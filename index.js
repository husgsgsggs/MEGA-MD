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

// Import the permanent storage library
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

// Initial Setup & Database Write Interval
store.readFromFile();
setInterval(() => store.writeToFile(), settings.storeWriteInterval || 10000);
commandHandler.loadCommands();

// RAM & Performance Management for Sevalla
setInterval(() => {
    if (global.gc) global.gc();
}, 60_000);

setInterval(() => {
    const used = process.memoryUsage().rss / 1024 / 1024;
    if (used > 480) {
        console.log(chalk.red("⚠️ Memory limit reached. Performing emergency restart..."));
        process.exit(1);
    }
}, 30_000);

// Keep Port 3000/8080 Open for Uptime
server.listen(PORT, () => printLog('success', `Uptime Server running on port ${PORT}`));

async function startQasimDev() {
    try {
        const mongoUrl = global.mongodb || process.env.MONGO_URL;
        
        // 1. HARD LOCK: Establishing Database Connection First
        console.log(chalk.yellow("📡 Phase 1: Establishing Stable Database Connection..."));
        if (!mongoUrl) {
            console.error(chalk.red("❌ Error: MONGO_URL is missing in your config!"));
            return;
        }
        
        await mongoose.connect(mongoUrl);
        console.log(chalk.green("✅ Phase 2: Database Connected. Syncing Auth State..."));

        const { state, saveCreds } = await useMongoDBAuthState(mongoUrl);
        const { version } = await fetchLatestBaileysVersion();
        const msgRetryCounterCache = new NodeCache();

        // Get pairing number from Environment Variables
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

        // 2. MAXIMUM STABILITY LOCK: 60-second delay for Pairing Code
        if (phoneNumber && !state.creds.registered) {
            console.log(chalk.blue("⏳ Stability Lock: Waiting 60 seconds for database replication..."));
            setTimeout(async () => {
                try {
                    console.log(chalk.cyan("🔑 Handshaking and Requesting Pairing Code..."));
                    let code = await QasimDev.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''));
                    code = code?.match(/.{1,4}/g)?.join("-") || code;
                    console.log(chalk.black(chalk.bgGreen(`\n 🔑 YOUR STABLE PAIRING CODE: `)), chalk.white.bold(code), `\n`);
                } catch (e) { 
                    console.log(chalk.red("❌ Pairing Error (Keys not ready):"), e.message); 
                }
            }, 60000); // 60s delay to prevent "Received undefined" errors
        }

        // Auto-Save Credentials
        QasimDev.ev.on('creds.update', async () => {
            await saveCreds();
        });

        store.bind(QasimDev.ev);

        QasimDev.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr && !phoneNumber) {
                qrcode.generate(qr, { small: true });
            }

            if (connection === 'open') {
                printLog('success', '✅ SUCCESS: Connected! Your bot is now permanent.');
            }

            if (connection === 'close') {
                let reason = new Boom(lastDisconnect?.error)?.output.statusCode;
                if (reason !== DisconnectReason.loggedOut) {
                    console.log(chalk.yellow("🔌 Connection lost. Cooling down for 10s before restart..."));
                    await delay(10000);
                    startQasimDev();
                } else {
                    printLog('error', '⚠️ Session Logged Out. Please clear MongoDB and re-pair.');
                }
            }
        });

        // Message & Event Listeners
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
        console.error(chalk.red("💥 CRITICAL START ERROR:"), err.message);
        setTimeout(startQasimDev, 15000);
    }
}

startQasimDev();
                   
