import express from "express"
import { changeCliente, crearCliente, getClientes, getClientesWithId } from "../controllers/clientes.controllers.js"

const clientesRoutes = express.Router()

clientesRoutes.post("/", crearCliente)
clientesRoutes.get("/", getClientes)
clientesRoutes.get("/:id", getClientesWithId)
clientesRoutes.patch("/:id", changeCliente)
clientesRoutes.put("/:id", changeCliente)

export default clientesRoutes
