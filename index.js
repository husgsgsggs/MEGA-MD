require('./config');
require('./settings');
const { Boom } = require('@hapi/boom');
const chalk = require('chalk');
const {
    default: makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers,
    makeCacheableSignalKeyStore,
    delay
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const mongoose = require("mongoose");
const { useMongoDBAuthState } = require('./lib/mongo_auth'); 
const { server, PORT } = require('./lib/server');
const { handleMessages } = require('./lib/messageHandler');

server.listen(PORT, () => console.log(chalk.green(`✅ Keep-alive server on port ${PORT}`)));

async function startQasimDev() {
    try {
        const mongoUrl = process.env.MONGO_URL || global.mongodb;
        
        console.log(chalk.yellow("📡 Connecting to MongoDB..."));
        await mongoose.connect(mongoUrl);
        
        const { state, saveCreds } = await useMongoDBAuthState(mongoUrl);
        const { version } = await fetchLatestBaileysVersion();
        
        const QasimDev = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false, 
            browser: Browsers.ubuntu('Chrome'),
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
            },
        });

        // Pairing Logic: Only runs if the session isn't already registered
        let phoneNumber = process.env.PAIRING_NUMBER || global.PAIRING_NUMBER;
        if (phoneNumber && !QasimDev.authState.creds.registered) {
            console.log(chalk.blue(`⏳ Requesting code for: ${phoneNumber}`));
            setTimeout(async () => {
                try {
                    let code = await QasimDev.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''));
                    code = code?.match(/.{1,4}/g)?.join("-") || code;
                    console.log(chalk.black.bgCyan(`\n PAIRING CODE: `), chalk.white.bold.bgMagenta(` ${code} `), `\n`);
                } catch (err) {
                    console.log(chalk.red("❌ Pairing Error:"), err.message);
                }
            }, 5000); 
        }

        QasimDev.ev.on('creds.update', saveCreds);

        QasimDev.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === 'open') {
                console.log(chalk.green.bold('✅ SUCCESS: Connected! Session saved to MongoDB.'));
            }
            if (connection === 'close') {
                let reason = new Boom(lastDisconnect?.error)?.output.statusCode;
                if (reason !== DisconnectReason.loggedOut) {
                    console.log(chalk.yellow(`🔌 Connection closed (${reason}). Reconnecting...`));
                    startQasimDev();
                } else {
                    console.log(chalk.red("❌ Logged out. Manual reset required in DB."));
                }
            }
        });

        QasimDev.ev.on('messages.upsert', async (chatUpdate) => {
            await handleMessages(QasimDev, chatUpdate);
        });

    } catch (err) {
        console.error(chalk.red("💥 Boot Error:"), err);
        setTimeout(startQasimDev, 10000);
    }
}

// Prevent process from dying on small errors
process.on('uncaughtException', (err) => console.error("Ex:", err));
process.on('unhandledRejection', (err) => console.error("Rej:", err));

startQasimDev();
