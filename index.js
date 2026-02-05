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

// RAM & Performance Management
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

// Keep Port 3000 Open for Cron-job/Uptime
server.listen(PORT, () => printLog('success', `Uptime Server running on port ${PORT}`));

async function startQasimDev() {
    try {
        const { version } = await fetchLatestBaileysVersion();
        
        // MongoDB Auth System (Prevents 3-minute deletion on Sevalla)
        const mongoUrl = global.mongodb || process.env.MONGO_URL;
        if (!mongoUrl) {
            console.error(chalk.red("❌ Error: MONGO_URL is missing in your config!"));
            process.exit(1);
        }

        const { state, saveCreds } = await useMongoDBAuthState(mongoUrl);
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

        // Pairing Code Support logic
        if (phoneNumber && !state.creds.registered) {
            setTimeout(async () => {
                try {
                    let code = await QasimDev.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''));
                    code = code?.match(/.{1,4}/g)?.join("-") || code;
                    console.log(chalk.black(chalk.bgGreen(`\n 🔑 YOUR PAIRING CODE: `)), chalk.white.bold(code), `\n`);
                } catch (e) { console.log("Pairing Error:", e); }
            }, 6000);
        }

        // Auto-Save Credentials to MongoDB
        QasimDev.ev.on('creds.update', async () => {
            await saveCreds();
            console.log(chalk.cyan("📤 Session credentials synced to MongoDB."));
        });

        store.bind(QasimDev.ev);

        QasimDev.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr && !phoneNumber) {
                qrcode.generate(qr, { small: true });
            }

            if (connection === 'open') {
                printLog('success', '✅ Connected! Your bot is now permanent.');
                try {
                    const { startAutoBio } = require('./plugins/setbio');
                    startAutoBio(QasimDev);
                } catch (e) { /* Bio plugin check */ }
            }

            if (connection === 'close') {
                let reason = new Boom(lastDisconnect?.error)?.output.statusCode;
                if (reason !== DisconnectReason.loggedOut) {
                    console.log(chalk.yellow("🔌 Connection lost. Reconnecting..."));
                    startQasimDev();
                } else {
                    printLog('error', '⚠️ Session Logged Out. Please re-pair your number.');
                }
            }
        });

        // Event Listeners
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
        console.error("Initialization Crash:", err);
        setTimeout(startQasimDev, 10000);
    }
}

// Global Crash Prevention
process.on('uncaughtException', (err) => {
    console.error('CRITICAL ERROR:', err);
    startQasimDev();
});

startQasimDev();
    
