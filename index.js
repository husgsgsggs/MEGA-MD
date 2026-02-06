require('./config');
require('./settings');
const { Boom } = require('@hapi/boom');
const chalk = require('chalk');
const fs = require('fs');
const {
    default: makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers,
    makeCacheableSignalKeyStore,
    jidDecode,
    delay
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const mongoose = require("mongoose");

// --- CUSTOM IMPORTS FROM YOUR MAIN REPO ---
const { useMongoDBAuthState } = require('./lib/mongo_auth'); 
const { server, PORT } = require('./lib/server');
const { handleMessages, handleStatus } = require('./lib/messageHandler');
const { smsg } = require('./lib/myfunc');
const store = require('./lib/lightweight_store');
const commandHandler = require('./lib/commandHandler');

// Initialize the store and commands
commandHandler.loadCommands();
store.readFromFile();
setInterval(() => store.writeToFile(), 10000);

server.listen(PORT, () => console.log(chalk.green(`✅ Keep-alive server running on port ${PORT}`)));

async function startQasimDev() {
    try {
        const mongoUrl = process.env.MONGO_URL || global.mongodb;
        console.log(chalk.yellow("📡 Connecting to MongoDB..."));
        
        await mongoose.connect(mongoUrl);
        console.log(chalk.green("✅ DB Connected. Loading session from Mongo..."));

        const { state, saveCreds } = await useMongoDBAuthState(mongoUrl);
        const { version } = await fetchLatestBaileysVersion();
        
        const QasimDev = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false, 
            browser: Browsers.macOS('Chrome'),
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
            },
            generateHighQualityLinkPreview: true,
            getMessage: async (key) => {
                let jid = QasimDev.decodeJid(key.remoteJid);
                let msg = await store.loadMessage(jid, key.id);
                return msg?.message || "";
            }
        });

        // --- RE-ENABLING RESPONSIVE HELPERS ---
        QasimDev.decodeJid = (jid) => {
            if (!jid) return jid;
            if (/:\d+@/gi.test(jid)) {
                let decode = jidDecode(jid) || {};
                return decode.user && decode.server && decode.user + '@' + decode.server || jid;
            } else return jid;
        };

        QasimDev.serializeM = (m) => smsg(QasimDev, m, store);
        QasimDev.public = true;
        
        // Link the store to the socket events
        store.bind(QasimDev.ev);

        // --- PAIRING CODE LOGIC ---
        let phoneNumber = process.env.PAIRING_NUMBER || global.PAIRING_NUMBER;
        if (phoneNumber && !QasimDev.authState.creds.registered) {
            console.log(chalk.blue(`⏳ Waiting 15s for stability...`));
            await delay(15000); 
            try {
                let code = await QasimDev.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''));
                code = code?.match(/.{1,4}/g)?.join("-") || code;
                console.log(chalk.black.bgCyan(`\n YOUR PAIRING CODE: `), chalk.white.bold.bgMagenta(` ${code} `), `\n`);
            } catch (err) {
                console.log(chalk.red("❌ Pairing Error:"), err.message);
            }
        }

        QasimDev.ev.on('creds.update', saveCreds);

        QasimDev.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === 'open') {
                console.log(chalk.green.bold('✅ SUCCESS: Bot Online & Responsive!'));
                const botNumber = QasimDev.user.id.split(':')[0] + '@s.whatsapp.net';
                await QasimDev.sendMessage(botNumber, { text: `🤖 *MEGA-MD CONNECTED*\n\nSession: MongoDB\nStatus: Responsive` });
            }
            if (connection === 'close') {
                let reason = new Boom(lastDisconnect?.error)?.output.statusCode;
                if (reason !== DisconnectReason.loggedOut) {
                    console.log(chalk.yellow(`🔌 Reconnecting...`));
                    startQasimDev();
                }
            }
        });

        QasimDev.ev.on('messages.upsert', async (chatUpdate) => {
            try {
                const mek = chatUpdate.messages[0];
                if (!mek.message) return;

                // Auto-read Status/Stories if needed
                if (mek.key && mek.key.remoteJid === 'status@broadcast') {
                    if (handleStatus) await handleStatus(QasimDev, chatUpdate);
                    return;
                }

                // Important: Serialize the message so handleMessages understands it
                const m = QasimDev.serializeM(mek);
                
                // Pass to your existing message handler
                await handleMessages(QasimDev, chatUpdate);
            } catch (err) {
                console.error("Error in message event:", err);
            }
        });

    } catch (err) {
        console.error(chalk.red("💥 Boot Error:"), err);
        setTimeout(startQasimDev, 10000);
    }
}

// Global safety catch for Sevalla
process.on('uncaughtException', (err) => console.error("Critical:", err.message));
process.on('unhandledRejection', (err) => console.error("Promise Error:", err.message));

startQasimDev();
            
