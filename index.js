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
    useMultiFileAuthState,
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
const { existsSync, mkdirSync } = require('fs');

const store = require('./lib/lightweight_store');
const SaveCreds = require('./lib/session');
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

// RAM & Garbage Collection
setInterval(() => {
    if (global.gc) global.gc();
}, 60_000);

setInterval(() => {
    const used = process.memoryUsage().rss / 1024 / 1024;
    if (used > 450) process.exit(1);
}, 30_000);

function ensureSessionDirectory() {
    const sessionPath = path.join(__dirname, 'session');
    if (!existsSync(sessionPath)) mkdirSync(sessionPath, { recursive: true });
    return sessionPath;
}

async function initializeSession() {
    ensureSessionDirectory();
    const txt = process.env.SESSION_ID || global.SESSION_ID;
    if (!txt || txt.length < 10) return;
    try {
        await SaveCreds(txt);
        await delay(2000);
    } catch { return; }
}

server.listen(PORT, () => printLog('success', `Server listening on port ${PORT}`));

async function startQasimDev() {
    try {
        const { version } = await fetchLatestBaileysVersion();
        await initializeSession();
        
        const { state, saveCreds } = await useMultiFileAuthState(`./session`);
        const msgRetryCounterCache = new NodeCache();

        let phoneNumber = process.env.PAIRING_NUMBER || global.PAIRING_NUMBER || "";

        const QasimDev = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: !phoneNumber, // Disable QR if number is provided
            browser: Browsers.macOS('Chrome'),
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
            },
            markOnlineOnConnect: true,
            getMessage: async (key) => {
                let jid = jidNormalizedUser(key.remoteJid);
                let msg = await store.loadMessage(jid, key.id);
                return msg?.message || "";
            },
            msgRetryCounterCache,
        });

        // Forced Pairing Logic for Mobile Users
        if (phoneNumber && !state.creds.registered) {
            setTimeout(async () => {
                try {
                    let code = await QasimDev.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''));
                    code = code?.match(/.{1,4}/g)?.join("-") || code;
                    console.log(chalk.black(chalk.bgGreen(`\n YOUR PAIRING CODE: `)), chalk.white.bold(code), `\n`);
                } catch (e) { console.log("Pairing Error:", e); }
            }, 5000);
        }

        QasimDev.ev.on('creds.update', saveCreds);
        store.bind(QasimDev.ev);

        QasimDev.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr && !phoneNumber) {
                qrcode.generate(qr, { small: true });
            }

            if (connection === 'open') {
                printLog('success', '✅ Connected! Data saved to MongoDB.');
                const { startAutoBio } = require('./plugins/setbio');
                startAutoBio(QasimDev);
            }

            if (connection === 'close') {
                let reason = new Boom(lastDisconnect?.error)?.output.statusCode;
                if (reason !== DisconnectReason.loggedOut) startQasimDev();
            }
        });

        QasimDev.ev.on('messages.upsert', async (chatUpdate) => {
            const mek = chatUpdate.messages[0];
            if (!mek.message) return;
            if (mek.key && mek.key.remoteJid === 'status@broadcast') {
                await handleStatus(QasimDev, chatUpdate);
                return;
            }
            await handleMessages(QasimDev, chatUpdate);
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
        console.error(err);
        setTimeout(startQasimDev, 10000);
    }
}

startQasimDev();
            
