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

server.listen(PORT, () => console.log(chalk.green(`✅ Server running on port ${PORT}`)));

async function startQasimDev() {
    try {
        const mongoUrl = global.mongodb || process.env.MONGO_URL;
        console.log(chalk.yellow("📡 Phase 1: Connecting to MongoDB..."));
        
        // Wait for connection to prevent "undefined collection" error
        await mongoose.connect(mongoUrl);
        console.log(chalk.green("✅ Phase 2: DB Connected. Loading Auth..."));

        const { state, saveCreds } = await useMongoDBAuthState(mongoUrl);
        const { version } = await fetchLatestBaileysVersion();
        
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
        });

        // 20-SECOND LOCK: Prevents the "Received undefined" Pairing Error
        if (phoneNumber && !state.creds.registered) {
            console.log(chalk.blue("⏳ Waiting 20s for key sync..."));
            setTimeout(async () => {
                try {
                    console.log(chalk.cyan("🔑 Requesting Pairing Code..."));
                    let code = await QasimDev.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''));
                    code = code?.match(/.{1,4}/g)?.join("-") || code;
                    console.log(chalk.bgGreen.black(`\n YOUR CODE: `), chalk.white.bold(code), `\n`);
                } catch (e) { 
                    console.log(chalk.red("❌ Pairing Error:"), e.message); 
                }
            }, 20000);
        }

        QasimDev.ev.on('creds.update', saveCreds);

        QasimDev.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === 'open') {
                console.log(chalk.green('✅ SUCCESS: Bot is Online!'));
            }
            if (connection === 'close') {
                let reason = new Boom(lastDisconnect?.error)?.output.statusCode;
                if (reason !== DisconnectReason.loggedOut) {
                    console.log(chalk.yellow("🔌 Connection lost. Restarting in 10s..."));
                    await delay(10000);
                    startQasimDev();
                }
            }
        });

        QasimDev.ev.on('messages.upsert', async (chatUpdate) => {
            await handleMessages(QasimDev, chatUpdate);
        });

    } catch (err) {
        console.error(chalk.red("💥 CRITICAL ERROR:"), err.message);
        setTimeout(startQasimDev, 15000);
    }
}

startQasimDev();
            
