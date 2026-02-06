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
        
        // STAGE 1: Wait for Database
        await mongoose.connect(mongoUrl);
        console.log(chalk.green("✅ DB Connected. Initializing Auth..."));

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

        // STAGE 2: Pairing Code Logic with Stability Delay
        let phoneNumber = process.env.PAIRING_NUMBER || global.PAIRING_NUMBER;
        
        if (phoneNumber && !QasimDev.authState.creds.registered) {
            console.log(chalk.blue(`⏳ [STABILITY] Waiting 15s before requesting code for ${phoneNumber}...`));
            
            // This delay prevents "Connection Closed" by letting the socket finish handshake
            await delay(15000); 

            try {
                console.log(chalk.cyan("🔑 Requesting code now..."));
                let code = await QasimDev.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''));
                code = code?.match(/.{1,4}/g)?.join("-") || code;
                console.log(chalk.black.bgCyan(`\n YOUR PAIRING CODE: `), chalk.white.bold.bgMagenta(` ${code} `), `\n`);
            } catch (err) {
                console.log(chalk.red("❌ Pairing Request Failed:"), err.message);
                // If it fails, we wait and retry once
                setTimeout(startQasimDev, 10000);
                return;
            }
        }

        QasimDev.ev.on('creds.update', saveCreds);

        QasimDev.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            
            if (connection === 'open') {
                console.log(chalk.green.bold('✅ SUCCESS: Bot is Online! Session saved to MongoDB.'));
            }
            
            if (connection === 'close') {
                let reason = new Boom(lastDisconnect?.error)?.output.statusCode;
                if (reason !== DisconnectReason.loggedOut) {
                    console.log(chalk.yellow(`🔌 Connection closed (${reason}). Reconnecting...`));
                    startQasimDev();
                } else {
                    console.log(chalk.red("❌ Logged out. Reset your MongoDB 'auth' collection to re-pair."));
                }
            }
        });

        QasimDev.ev.on('messages.upsert', async (chatUpdate) => {
            await handleMessages(QasimDev, chatUpdate);
        });

    } catch (err) {
        console.error(chalk.red("💥 Boot Error:"), err.message);
        setTimeout(startQasimDev, 10000);
    }
}

// Global safety catch
process.on('uncaughtException', (err) => console.error("Critical:", err.message));
process.on('unhandledRejection', (err) => console.error("Promise Error:", err.message));

startQasimDev();
