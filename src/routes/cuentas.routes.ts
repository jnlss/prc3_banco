import express from "express"
import { altaCuenta, cambiarEstadoCuenta, ingresar, listarCuentas, listarMovimientosCuenta, obtenerCuenta, retirar } from "../controllers/cuentas.controllers.js"

const cuentasRoutes = express.Router()

cuentasRoutes.post("/", altaCuenta)
cuentasRoutes.get("/", listarCuentas)
cuentasRoutes.get("/:id/movimientos", listarMovimientosCuenta)
cuentasRoutes.post("/:id/ingresos", ingresar)
cuentasRoutes.post("/:id/retiradas", retirar)
cuentasRoutes.get("/:id", obtenerCuenta)
cuentasRoutes.patch("/:id/estado", cambiarEstadoCuenta)

export default cuentasRoutes
