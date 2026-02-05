/* process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; */

require('./config');
require('./settings');

const { Boom } = require('@hapi/boom');
const fs = require('fs');
const chalk = require('chalk');
const path = require('path');
const qrcode = require('qrcode-terminal');
const {
    default: makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers,
    jidDecode,
    jidNormalizedUser,
    makeCacheableSignalKeyStore,
    delay
} = require("@whiskeysockets/baileys");
const NodeCache = require("node-cache");
const pino = require("pino");
const mongoose = require("mongoose");

// Import the MongoDB Auth Library
const { useMongoDBAuthState } = require('./lib/mongo_auth'); 

const store = require('./lib/lightweight_store');
const { server, PORT } = require('./lib/server');
const { printLog } = require('./lib/print');
const { 
    handleMessages, 
    handleGroupParticipantUpdate, 
    handleStatus,
    handleCall 
} = require('./lib/messageHandler');

const settings = require('./settings');
const commandHandler = require('./lib/commandHandler');

// Initial Setup
store.readFromFile();
setInterval(() => store.writeToFile(), settings.storeWriteInterval || 10000);
commandHandler.loadCommands();

// RAM Monitoring for Sevalla (Prevents OOM crashes)
setInterval(() => {
    if (global.gc) global.gc();
    const used = process.memoryUsage().rss / 1024 / 1024;
    if (used > 450) {
        console.log(chalk.red("⚠️ Memory high, restarting..."));
        process.exit(1);
    }
}, 30_000);

// Server for Port 8080/3000 Uptime
server.listen(PORT, () => printLog('success', `Bot server alive on port ${PORT}`));

async function startQasimDev() {
    try {
        const mongoUrl = global.mongodb || process.env.MONGO_URL;
        
        // 1. HARD WAIT: Force connection before doing anything else
        console.log(chalk.yellow("📡 Connecting to Database..."));
        if (!mongoUrl) {
            console.error(chalk.red("❌ Error: MONGO_URL not found in config.js or ENV."));
            return;
        }
        await mongoose.connect(mongoUrl);
        
        // 2. AUTH SYNC: Ensure state and creds are ready
        const { state, saveCreds } = await useMongoDBAuthState(mongoUrl);
        console.log(chalk.green("✅ Database Synced. Initializing Connection..."));

        const { version } = await fetchLatestBaileysVersion();
        const msgRetryCounterCache = new NodeCache();
        let phoneNumber = process.env.PAIRING_NUMBER || global.PAIRING_NUMBER || "";

        const QasimDev = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: !phoneNumber, 
            browser: Browsers.macOS('Chrome'),
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
            },
            markOnlineOnConnect: true,
            generateHighQualityLinkPreview: true,
            syncFullHistory: false,
            getMessage: async (key) => {
                let jid = jidNormalizedUser(key.remoteJid);
                let msg = await store.loadMessage(jid, key.id);
                return msg?.message || "";
            },
            msgRetryCounterCache,
        });

        // 3. SECURE PAIRING: 15s delay to ensure noiseKey isn't undefined
        if (phoneNumber && !state.creds.registered) {
            setTimeout(async () => {
                try {
                    console.log(chalk.cyan("🔑 Generating Pairing Code..."));
                    let code = await QasimDev.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''));
                    code = code?.match(/.{1,4}/g)?.join("-") || code;
                    console.log(chalk.bgGreen.black(`\n YOUR CODE: `), chalk.white.bold(code), `\n`);
                } catch (e) { 
                    console.log(chalk.red("Pairing Error:"), e.message); 
                }
            }, 15000);
        }

        QasimDev.ev.on('creds.update', saveCreds);
        store.bind(QasimDev.ev);

        QasimDev.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr && !phoneNumber) {
                qrcode.generate(qr, { small: true });
            }

            if (connection === 'open') {
                printLog('success', '✅ SUCCESS: Connected! Session saved to MongoDB.');
            }

            if (connection === 'close') {
                let reason = new Boom(lastDisconnect?.error)?.output.statusCode;
                if (reason !== DisconnectReason.loggedOut) {
                    console.log(chalk.cyan("🔌 Connection lost. Reconnecting..."));
                    startQasimDev();
                } else {
                    printLog('error', '⚠️ Logged out. Clean MongoDB and re-pair.');
                }
            }
        });

        // Event Handling
        QasimDev.ev.on('messages.upsert', async (chatUpdate) => {
            try {
                const mek = chatUpdate.messages[0];
                if (!mek.message) return;
                if (mek.key && mek.key.remoteJid === 'status@broadcast') {
                    await handleStatus(QasimDev, chatUpdate);
                    return;
                }
                await handleMessages(QasimDev, chatUpdate);
            } catch (err) { console.error(err); }
        });

        QasimDev.ev.on('group-participants.update', async (anu) => {
            await handleGroupParticipantUpdate(QasimDev, anu);
        });

        QasimDev.ev.on('call', async (call) => {
            await handleCall(QasimDev, call);
        });

        QasimDev.decodeJid = (jid) => {
            if (!jid) return jid;
            if (/:\d+@/gi.test(jid)) {
                let decode = jidDecode(jid) || {};
                return decode.user && decode.server && decode.user + '@' + decode.server || jid;
            } else return jid;
        };

        const smsg = require('./lib/myfunc').smsg;
        QasimDev.serializeM = (m) => smsg(QasimDev, m, store);

    } catch (err) {
        console.error(chalk.red("CRITICAL START ERROR:"), err.message);
        setTimeout(startQasimDev, 10000);
    }
}

startQasimDev();
    
