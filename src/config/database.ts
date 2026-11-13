import { Db, MongoClient } from "mongodb"

export const connectMongo = async (): Promise<Db> => {
    const uri = process.env.MONGODB_URI
    if (!uri) {
        throw new Error("Falta configurar la variable de entorno MONGODB_URI")
    }

    const client = new MongoClient(uri)
    await client.connect()
    console.log("Conectado a Mongo")
    return client.db(process.env.MONGODB_DATABASE ?? "prc3_banco")
}
