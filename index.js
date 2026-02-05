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

// Import the auth library
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

// RAM Monitoring to prevent Sevalla from killing the process
setInterval(() => {
    if (global.gc) global.gc();
    const used = process.memoryUsage().rss / 1024 / 1024;
    if (used > 450) {
        console.log(chalk.red("⚠️ High RAM usage. Restarting to stay stable..."));
        process.exit(1);
    }
}, 30_000);

// Keep Uptime Port Active
server.listen(PORT, () => printLog('success', `Uptime Server live on port ${PORT}`));

async function startQasimDev() {
    try {
        const mongoUrl = global.mongodb || process.env.MONGO_URL;
        
        // 1. THE HARD GATE: Bot will not move past this line until DB is 100% connected
        console.log(chalk.yellow("⏳ Step 1: Connecting to MongoDB (Waiting for handshake)..."));
        if (!mongoUrl) {
            console.error(chalk.red("❌ ERROR: MONGO_URL missing in config.js or Environment Variables."));
            return;
        }

        // Wait for connection to prevent "undefined collection" error
        await mongoose.connect(mongoUrl, { serverSelectionTimeoutMS: 5000 });
        console.log(chalk.green("✅ Step 2: Database Connected. Synchronizing auth..."));

        const { state, saveCreds } = await useMongoDBAuthState(mongoUrl);
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
            syncFullHistory: false,
            getMessage: async (key) => {
                let jid = jidNormalizedUser(key.remoteJid);
                let msg = await store.loadMessage(jid, key.id);
                return msg?.message || "";
            },
            msgRetryCounterCache,
        });

        // 2. STABILITY DELAY: Prevents Pairing Error
        if (phoneNumber && !state.creds.registered) {
            console.log(chalk.blue("⏳ Stability Lock: Syncing security keys (60s wait)..."));
            setTimeout(async () => {
                try {
                    console.log(chalk.cyan("🔑 Handshaking with WhatsApp..."));
                    let code = await QasimDev.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''));
                    code = code?.match(/.{1,4}/g)?.join("-") || code;
                    console.log(chalk.black(chalk.bgGreen(`\n 🔑 YOUR PAIRING CODE: `)), chalk.white.bold(code), `\n`);
                } catch (e) { 
                    console.log(chalk.red("❌ Pairing Error (Retrying in next loop):"), e.message);
                }
            }, 60000); 
        }

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
                printLog('success', '✅ SUCCESS: Bot is connected and stable!');
            }

            if (connection === 'close') {
                let reason = new Boom(lastDisconnect?.error)?.output.statusCode;
                if (reason !== DisconnectReason.loggedOut) {
                    // 3. COOL-DOWN RESTART: Prevents the rapid restart crash loop
                    console.log(chalk.cyan("🔌 Connection closed. Cooling down for 15s before restart..."));
                    await delay(15000);
                    startQasimDev();
                } else {
                    printLog('error', '⚠️ Logged out. Delete the "auth" collection in MongoDB and re-pair.');
                }
            }
        });

        // Handler Logic
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
        setTimeout(startQasimDev, 20000); // 20s recovery delay
    }
}

startQasimDev();
