import express from "express"
import { connectMongo } from "./config/database.js"
import type { clienteT, cuentaT, movimientoT } from "./models/models.js"
import { configCollection as configClientesCollection } from "./controllers/clientes.controllers.js"
import {
    configCollection as configCuentasCollection,
    configMongoClient,
    configMovimientosCollection
} from "./controllers/cuentas.controllers.js"
import clientesRoutes from "./routes/clientes.routes.js"
import cuentasRoutes from "./routes/cuentas.routes.js"
import transferenciasRoutes from "./routes/transferencias.routes.js"

const app = express()
app.use(express.json())
app.use((req, res, next) => {
    if (["POST", "PUT", "PATCH"].includes(req.method) &&
        (req.body === null || typeof req.body !== "object" || Array.isArray(req.body))) {
        res.status(400).json({ error: "El cuerpo de la petición debe ser un objeto JSON" })
        return
    }
    next()
})

const startServer = async (): Promise<void> => {
    try {
        const database = await connectMongo()
        const clientes = database.collection<clienteT>("clientes")
        const cuentas = database.collection<cuentaT>("cuentas")
        const movimientos = database.collection<movimientoT>("movimientos")

        await Promise.all([
            clientes.createIndex({ email: 1 }, {
                unique: true,
                collation: { locale: "en", strength: 2 },
                name: "email_unico"
            }),
            clientes.createIndex({ dni: 1 }, {
                unique: true,
                collation: { locale: "en", strength: 2 },
                name: "dni_unico"
            }),
            cuentas.createIndex({ iban: 1 }, { unique: true, name: "iban_unico" })
        ])

        configClientesCollection(clientes)
        configCuentasCollection(cuentas)
        configMovimientosCollection(movimientos)
        configMongoClient(database.client)

        app.use("/clientes", clientesRoutes)
        app.use("/cuentas", cuentasRoutes)
        app.use("/transferencias", transferenciasRoutes)
        app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
            if (error instanceof SyntaxError &&
                "status" in error && error.status === 400) {
                res.status(400).json({ error: "El cuerpo de la petición no es un JSON válido" })
                return
            }
            console.error("Error inesperado:", error)
            res.status(500).json({ error: "Error inesperado" })
        })

        const port = Number(process.env.PORT ?? 3000)
        app.listen(port, () => {
            console.log(`API funcionando en el puerto ${port}`)
        })
    } catch (error) {
        console.error("No se ha podido iniciar el servidor:", error)
        process.exitCode = 1
    }
}

void startServer()
