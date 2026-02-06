/* process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; */

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

server.listen(PORT, () => console.log(chalk.green(`✅ Keep-alive server running on port ${PORT}`)));

async function startQasimDev() {
    try {
        const mongoUrl = process.env.MONGO_URL || global.mongodb;
        
        console.log(chalk.yellow("📡 Connecting to MongoDB..."));
        
        // Step 1: Force wait for MongoDB connection
        await mongoose.connect(mongoUrl, { useNewUrlParser: true, useUnifiedTopology: true });
        console.log(chalk.green("✅ DB Connected."));

        // Step 2: Load authentication state from Mongo
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

        // Step 3: Pairing Code Logic
        let phoneNumber = process.env.PAIRING_NUMBER || global.PAIRING_NUMBER;
        
        // We only request a code if there is a number AND we aren't already registered in the DB
        if (phoneNumber && !QasimDev.authState.creds.registered) {
            console.log(chalk.blue(`⏳ Preparing pairing code for: ${phoneNumber}`));
            
            // Wait 10 seconds to ensure the socket is stable before requesting
            await delay(10000); 
            
            try {
                let code = await QasimDev.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''));
                code = code?.match(/.{1,4}/g)?.join("-") || code;
                console.log(chalk.black.bgCyan(`\n PAIRING CODE: `), chalk.white.bold.bgMagenta(` ${code} `), `\n`);
            } catch (err) {
                console.log(chalk.red("❌ Pairing Request Failed:"), err.message);
            }
        } else if (QasimDev.authState.creds.registered) {
            console.log(chalk.cyan("♻️ Session loaded from MongoDB. Auto-logging in..."));
        }

        QasimDev.ev.on('creds.update', saveCreds);

        QasimDev.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            
            if (connection === 'open') {
                console.log(chalk.green.bold('✅ SUCCESS: Bot is Online!'));
            }
            
            if (connection === 'close') {
                let reason = new Boom(lastDisconnect?.error)?.output.statusCode;
                
                if (reason === DisconnectReason.restartRequired) {
                    startQasimDev();
                } else if (reason === DisconnectReason.loggedOut) {
                    console.log(chalk.red("❌ Logged out. You must clear your MongoDB collection to re-pair."));
                } else {
                    console.log(chalk.yellow(`🔌 Connection lost (${reason}). Reconnecting in 5s...`));
                    setTimeout(startQasimDev, 5000);
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

// Global safety net to stop Sevalla from crashing on every small error
process.on('uncaughtException', (err) => console.error("Critical Exception:", err.message));
process.on('unhandledRejection', (err) => console.error("Uncaught Promise:", err.message));

startQasimDev();
    
