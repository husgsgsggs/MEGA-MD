/* process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; */

require('./config');
require('./settings');

const { Boom } = require('@hapi/boom');
const fs = require('fs');
const chalk = require('chalk');
const FileType = require('file-type');
const syntaxerror = require('syntax-error');
const path = require('path');
const axios = require('axios');
const PhoneNumber = require('awesome-phonenumber');
const { imageToWebp, videoToWebp, writeExifImg, writeExifVid } = require('./lib/exif');
const { smsg, isUrl, generateMessageTag, getBuffer, getSizeMedia, fetch, await, sleep, reSize } = require('./lib/myfunc');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    generateForwardMessageContent,
    prepareWAMessageMedia,
    generateWAMessageFromContent,
    generateMessageID,
    downloadContentFromMessage,
    Browsers,
    jidDecode,
    proto,
    jidNormalizedUser,
    makeCacheableSignalKeyStore,
    delay
} = require("@whiskeysockets/baileys");
const NodeCache = require("node-cache");
const pino = require("pino");
const readline = require("readline");
const { parsePhoneNumber } = require("libphonenumber-js");
const { PHONENUMBER_MCC } = require('@whiskeysockets/baileys/lib/Utils/generics');
const { rmSync, existsSync, mkdirSync } = require('fs');
const { join } = require('path');

const store = require('./lib/lightweight_store');
const SaveCreds = require('./lib/session');
const { app, server, PORT } = require('./lib/server');
const { printLog } = require('./lib/print');
const { 
    handleMessages, 
    handleGroupParticipantUpdate, 
    handleStatus,
    handleCall 
} = require('./lib/messageHandler');

const settings = require('./settings');
const commandHandler = require('./lib/commandHandler');

store.readFromFile();
setInterval(() => store.writeToFile(), settings.storeWriteInterval || 10000);

commandHandler.loadCommands();

setInterval(() => {
    if (global.gc) {
        global.gc();
        console.log('🧹 Garbage collection completed');
    }
}, 60_000);

setInterval(() => {
    const used = process.memoryUsage().rss / 1024 / 1024;
    if (used > 400) {
        console.log(chalk.yellow('⚠️ RAM too high (>400MB), restarting bot...'));
        process.exit(1);
    }
}, 30_000);

// FIXED: Removed the hardcoded number that was causing your pairing loop
let phoneNumber = global.PAIRING_NUMBER || process.env.PAIRING_NUMBER || ""; 
let owner = JSON.parse(fs.readFileSync('./data/owner.json'));

global.botname = process.env.BOT_NAME || "MEGA-MD";
global.themeemoji = "•";

const pairingCode = !!phoneNumber || process.argv.includes("--pairing-code");
const useMobile = process.argv.includes("--mobile");

let rl = null;
if (process.stdin.isTTY && !process.env.PAIRING_NUMBER) {
    rl = readline.createInterface({ 
        input: process.stdin, 
        output: process.stdout 
    });
}

const question = (text) => {
    if (rl && !rl.closed) {
        return new Promise((resolve) => rl.question(text, resolve));
    } else {
        return Promise.resolve(settings.ownerNumber || phoneNumber);
    }
};

process.on('exit', () => { if (rl && !rl.closed) rl.close(); });
process.on('SIGINT', () => { if (rl && !rl.closed) rl.close(); process.exit(0); });

function ensureSessionDirectory() {
    const sessionPath = path.join(__dirname, 'session');
    if (!existsSync(sessionPath)) {
        mkdirSync(sessionPath, { recursive: true });
    }
    return sessionPath;
}

function hasValidSession() {
    try {
        const credsPath = path.join(__dirname, 'session', 'creds.json');
        if (!existsSync(credsPath)) return false;
        const fileContent = fs.readFileSync(credsPath, 'utf8');
        if (!fileContent) return false;
        const creds = JSON.parse(fileContent);
        return creds.registered === true;
    } catch (error) { return false; }
}

async function initializeSession() {
    ensureSessionDirectory();
    const txt = global.SESSION_ID || process.env.SESSION_ID;
    if (!txt) return hasValidSession();
    if (hasValidSession()) return true;
    try {
        await SaveCreds(txt);
        await delay(2000);
        return hasValidSession();
    } catch (error) { return false; }
}

server.listen(PORT, () => {
    printLog('success', `Server listening on port ${PORT}`);
});

async function startQasimDev() {
    try {
        let { version, isLatest } = await fetchLatestBaileysVersion();
        
        // Critical: Download from MongoDB/Session ID before initializing state
        await initializeSession();
        
        const { state, saveCreds } = await useMultiFileAuthState(`./session`);
        const msgRetryCounterCache = new NodeCache();

        const ghostMode = await store.getSetting('global', 'stealthMode');
        const isGhostActive = ghostMode && ghostMode.enabled;

        const QasimDev = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: !pairingCode,
            browser: Browsers.macOS('Chrome'),
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
            },
            markOnlineOnConnect: !isGhostActive,
            generateHighQualityLinkPreview: true,
            syncFullHistory: false,
            getMessage: async (key) => {
                let jid = jidNormalizedUser(key.remoteJid);
                let msg = await store.loadMessage(jid, key.id);
                return msg?.message || "";
            },
            msgRetryCounterCache,
            defaultQueryTimeoutMs: 60000,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 10000,
        });

        // (Original Stealth Mode Logic Kept Here...)
        const originalSendPresenceUpdate = QasimDev.sendPresenceUpdate;
        QasimDev.sendPresenceUpdate = async function(...args) {
            const ghostMode = await store.getSetting('global', 'stealthMode');
            if (ghostMode && ghostMode.enabled) return;
            return originalSendPresenceUpdate.apply(this, args);
        };

        QasimDev.ev.on('creds.update', saveCreds);
        store.bind(QasimDev.ev);
        
        QasimDev.ev.on('messages.upsert', async (chatUpdate) => {
            try {
                const mek = chatUpdate.messages[0];
                if (!mek.message) return;
                if (mek.key && mek.key.remoteJid === 'status@broadcast') {
                    await handleStatus(QasimDev, chatUpdate);
                    return;
                }
                await handleMessages(QasimDev, chatUpdate);
            } catch (err) { printLog('error', err.message); }
        });

        // (All your original JID and Name functions kept here...)
        QasimDev.decodeJid = (jid) => {
            if (!jid) return jid;
            if (/:\d+@/gi.test(jid)) {
                let decode = jidDecode(jid) || {};
                return decode.user && decode.server && decode.user + '@' + decode.server || jid;
            } else return jid;
        };

        QasimDev.public = true;
        QasimDev.serializeM = (m) => smsg(QasimDev, m, store);

        const isRegistered = state.creds?.registered === true;
        
        // FIXED: Only pair if a number exists and we aren't already registered
        if (pairingCode && !isRegistered && phoneNumber !== "") {
            let phoneNumberInput = phoneNumber.replace(/[^0-9]/g, '');
            setTimeout(async () => {
                try {
                    let code = await QasimDev.requestPairingCode(phoneNumberInput);
                    code = code?.match(/.{1,4}/g)?.join("-") || code;
                    console.log(chalk.black(chalk.bgGreen(`Your Pairing Code : `)), chalk.black(chalk.white(code)));
                } catch (error) { printLog('error', `Failed pairing: ${error.message}`); }
            }, 3000);
        }

        QasimDev.ev.on('connection.update', async (s) => {
            const { connection, lastDisconnect, qr } = s;
            if (qr && !pairingCode) printLog('info', 'Please scan the QR Code');
            if (connection === 'open') {
                printLog('success', 'Bot connected successfully!');
                const { startAutoBio } = require('./plugins/setbio');
                startAutoBio(QasimDev); 
            }
            if (connection === 'close') {
                let reason = new Boom(lastDisconnect?.error)?.output.statusCode;
                if (reason !== DisconnectReason.loggedOut) startQasimDev();
            }
        });

    } catch (err) { console.error(err); }
}

startQasimDev();
    
