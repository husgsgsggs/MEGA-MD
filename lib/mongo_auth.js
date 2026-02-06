const { BufferJSON, proto, initConfigs, Curve, signedKeyPair, generateRegistrationId } = require("@whiskeysockets/baileys");
const mongoose = require("mongoose");

const useMongoDBAuthState = async (url) => {
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

    let creds = await readData("creds");
    if (!creds) {
        // Generate valid cryptographic keys that WhatsApp expects
        const keyPair = Curve.generateKeyPair();
        creds = {
            noiseKey: Curve.generateKeyPair(),
            pairingEphemeralKeyPair: Curve.generateKeyPair(),
            signedIdentityKey: keyPair,
            signedPreKey: signedKeyPair(keyPair, 1),
            registrationId: generateRegistrationId(),
            advSecretKey: require('crypto').randomBytes(32).toString('base64'),
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
                            if (value) {
                                await writeData(value, key);
                            } else {
                                await collection.deleteOne({ _id: key });
                            }
                        }
                    }
                },
            },
        },
        saveCreds: () => writeData(creds, "creds"),
    };
};

module.exports = { useMongoDBAuthState };
        
