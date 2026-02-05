const { BufferJSON, proto } = require("@whiskeysockets/baileys");
const mongoose = require("mongoose");
const crypto = require("crypto");

const useMongoDBAuthState = async (url) => {
    // Force wait for connection before doing anything
    if (mongoose.connection.readyState !== 1) {
        await mongoose.connect(url);
    }

    const collection = mongoose.connection.db.collection("auth");

    const writeData = (data, id) => {
        return collection.replaceOne(
            { _id: id },
            JSON.parse(JSON.stringify(data, BufferJSON.replacer)),
            { upsert: true }
        );
    };

    const readData = async (id) => {
        try {
            const data = await collection.findOne({ _id: id });
            if (!data) return null;
            return JSON.parse(JSON.stringify(data), BufferJSON.reviver);
        } catch (error) {
            return null;
        }
    };

    const removeData = async (id) => {
        try {
            await collection.deleteOne({ _id: id });
        } catch (error) {}
    };

    // Manual initialization to replace the broken initAuthStateCursor function
    const creds = await readData("creds") || {
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

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`);
                            if (type === "app-state-sync-key" && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            tasks.push(value ? writeData(value, key) : removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                },
            },
        },
        saveCreds: () => writeData(creds, "creds"),
    };
};

module.exports = { useMongoDBAuthState };
