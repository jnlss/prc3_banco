import express from "express"
import { transferir } from "../controllers/cuentas.controllers.js"

const transferenciasRoutes = express.Router()

transferenciasRoutes.post("/", transferir)

export default transferenciasRoutes
