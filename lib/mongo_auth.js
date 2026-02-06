const { BufferJSON, proto } = require("@whiskeysockets/baileys");
const mongoose = require("mongoose");
const crypto = require("crypto");

const useMongoDBAuthState = async (url) => {
    // Force wait for connection to be active
    if (mongoose.connection.readyState !== 1) {
        await mongoose.connect(url);
    }
    const collection = mongoose.connection.db.collection("auth");

    const writeData = (data, id) => collection.replaceOne(
        { _id: id },
        JSON.parse(JSON.stringify(data, BufferJSON.replacer)),
        { upsert: true }
    );

    const readData = async (id) => {
        try {
            const data = await collection.findOne({ _id: id });
            return data ? JSON.parse(JSON.stringify(data), BufferJSON.reviver) : null;
        } catch { return null; }
    };

    // Fixes the Pairing "Received undefined" error by generating keys manually
    let creds = await readData("creds");
    if (!creds) {
        creds = {
            noiseKey: crypto.randomBytes(32),
            pairingEphemeralKeyPair: crypto.randomBytes(32),
            signedIdentityKey: crypto.randomBytes(32),
            signedPreKey: crypto.randomBytes(32),
            registrationId: Math.floor(Math.random() * 16383) + 1,
            advSecretKey: crypto.randomBytes(32),
            nextPreKeyId: 1,
            firstUnuploadedPreKeyId: 1,
            accountSettings: { unarchiveChats: false }
        };
        await writeData(creds, "creds");
    }

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async (id) => {
                        let value = await readData(`${type}-${id}`);
                        if (type === "app-state-sync-key" && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            value ? await writeData(value, key) : await collection.deleteOne({ _id: key });
                        }
                    }
                },
            },
        },
        saveCreds: () => writeData(creds, "creds"),
    };
};

module.exports = { useMongoDBAuthState };
                        
