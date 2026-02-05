const { 
    BufferJSON, 
    initAuthStateCursor, 
    proto 
} = require("@whiskeysockets/baileys");
const mongoose = require("mongoose");

const useMongoDBAuthState = async (url) => {
    // Connect to MongoDB if not already connected
    if (!mongoose.connection.readyState) {
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

    const creds = await readData("creds") || initAuthStateCursor().creds;

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
          
