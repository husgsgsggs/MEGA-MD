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
    if (used > 450) {
        console.log(chalk.red('⚠️ RAM limit reached, auto-restarting...'));
        process.exit(1);
    }
}, 30_000);

// Session Directory Management
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
        const fileContent = fs.readFileSync(credsPath, 'utf-8');
        if (!fileContent || fileContent.trim() === "") return false;
        const creds = JSON.parse(fileContent);
        return creds.registered === true;
    } catch { return false; }
}

async function initializeSession() {
    ensureSessionDirectory();
    const txt = process.env.SESSION_ID || global.SESSION_ID;
    // Skip if no ID provided and no local session exists
    if (!txt || txt.length < 10) return hasValidSession();
    // Use local if already valid
    if (hasValidSession()) return true;
    
    try {
        printLog('info', '📥 Attempting to sync session from MongoDB...');
        await SaveCreds(txt);
        await delay(2000);
        return hasValidSession();
    } catch (e) { 
        printLog('error', 'Session ID sync failed. Please scan QR.');
        return false; 
    }
}

server.listen(PORT, () => printLog('success', `Server listening on port ${PORT}`));

async function startQasimDev() {
    try {
        const { version } = await fetchLatestBaileysVersion();
        await initializeSession();
        
        const { state, saveCreds } = await useMultiFileAuthState(`./session`);
        const msgRetryCounterCache = new NodeCache();

        // Check Stealth Mode Status
        const ghostMode = await store.getSetting('global', 'stealthMode');
        const isGhostActive = ghostMode && ghostMode.enabled;

        const QasimDev = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false, // We use qrcode-terminal for better cloud logs
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
        });

        // Stealth Mode Override Logic
        const originalSendPresenceUpdate = QasimDev.sendPresenceUpdate;
        QasimDev.sendPresenceUpdate = async function(...args) {
            const ghost = await store.getSetting('global', 'stealthMode');
            if (ghost && ghost.enabled) return;
            return originalSendPresenceUpdate.apply(this, args);
        };

        // Sync Creds & Store
        QasimDev.ev.on('creds.update', saveCreds);
        store.bind(QasimDev.ev);

        // Connection Handling
        QasimDev.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                console.log(chalk.bgWhite.black("\n 📸 SCAN THE QR CODE BELOW TO LOG IN: \n"));
                qrcode.generate(qr, { small: true });
                console.log(chalk.gray("Note: If the QR is distorted, zoom out your browser/terminal."));
            }

            if (connection === 'connecting') printLog('connection', 'Connecting to WhatsApp...');
            
            if (connection === 'open') {
                printLog('success', '✅ Connected Successfully!');
                printLog('info', 'Session is now being managed by MongoDB.');
                const { startAutoBio } = require('./plugins/setbio');
                startAutoBio(QasimDev);
            }

            if (connection === 'close') {
                let reason = new Boom(lastDisconnect?.error)?.output.statusCode;
                if (reason !== DisconnectReason.loggedOut) {
                    printLog('warning', `Connection closed (Reason: ${reason}). Reconnecting...`);
                    startQasimDev();
                } else {
                    printLog('error', '⚠️ Session Logged Out. Please delete the session folder and re-scan.');
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
            } catch (err) { printLog('error', `Handler Error: ${err.message}`); }
        });

        QasimDev.ev.on('group-participants.update', async (anu) => {
            await handleGroupParticipantUpdate(QasimDev, anu);
        });

        QasimDev.ev.on('call', async (call) => {
            await handleCall(QasimDev, call);
        });

        // Helper Functions
        QasimDev.decodeJid = (jid) => {
            if (!jid) return jid;
            if (/:\d+@/gi.test(jid)) {
                let decode = jidDecode(jid) || {};
                return decode.user && decode.server && decode.user + '@' + decode.server || jid;
            } else return jid;
        };

        QasimDev.getName = (jid) => {
            let id = QasimDev.decodeJid(jid);
            let v = id === '0@s.whatsapp.net' ? { id, name: 'WhatsApp' } : (store.contacts[id] || {});
            return v.name || v.subject || v.verifiedName || jid.split('@')[0];
        };

        const smsg = require('./lib/myfunc').smsg;
        QasimDev.serializeM = (m) => smsg(QasimDev, m, store);

    } catch (err) {
        console.error(chalk.red("FATAL ERROR IN BOT STARTUP:"), err);
        setTimeout(startQasimDev, 10000);
    }
}

startQasimDev();
