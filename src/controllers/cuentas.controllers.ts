import type { Request, Response } from "express"
import type { ClientSession, Collection, Filter, MongoClient } from "mongodb"
import { MongoServerError, ObjectId } from "mongodb"
import { clientesCollection } from "./clientes.controllers.js"
import type { cuentaT, movimientoT } from "../models/models.js"

let cuentasCollection: Collection<cuentaT>
let movimientosCollection: Collection<movimientoT> | undefined
let mongoClient: MongoClient

class ErrorReglaNegocio extends Error {
    constructor(readonly status: 400 | 404 | 409, message: string) {
        super(message)
    }
}

export const configCollection = (coleccion: Collection<cuentaT>): void => {
    cuentasCollection = coleccion
}

export const configMovimientosCollection = (coleccion: Collection<movimientoT>): void => {
    movimientosCollection = coleccion
}

export const configMongoClient = (client: MongoClient): void => {
    mongoClient = client
}

const esDuplicado = (error: unknown): boolean =>
    error instanceof MongoServerError && error.code === 11000

const convertirLetras = (valor: string): string =>
    valor.replace(/[A-Z]/g, letra => String(letra.charCodeAt(0) - 55))

const calcularMod97 = (numero: string): number => {
    let resto = 0
    for (const digito of numero) {
        resto = (resto * 10 + Number(digito)) % 97
    }
    return resto
}

export const esIbanValido = (iban: string): boolean => {
    const normalizado = iban.replace(/\s/g, "").toUpperCase()
    if (!/^ES\d{22}$/.test(normalizado)) return false
    return calcularMod97(convertirLetras(normalizado.slice(4) + normalizado.slice(0, 4))) === 1
}

const generarIBAN = (): string => {
    let bban = ""
    for (let i = 0; i < 20; i++) {
        bban += Math.floor(Math.random() * 10).toString()
    }
    const control = (98 - calcularMod97(`${bban}142800`)).toString().padStart(2, "0")
    return `ES${control}${bban}`
}

const paginacion = (req: Request): { pagina: number; limite: number; skip: number } => {
    const parse = (value: unknown, fallback: number): number => {
        const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : fallback
        return Number.isSafeInteger(n) && n > 0 ? n : fallback
    }
    const pagina = parse(req.query.pagina, 1)
    const limite = Math.min(100, parse(req.query.limite, 20))
    return { pagina, limite, skip: (pagina - 1) * limite }
}

const datosMovimiento = (body: Record<string, unknown>):
    { importe: number; concepto: string; categoria: string } | string => {
    if (!Number.isSafeInteger(body.importe) || (body.importe as number) <= 0) {
        return "El importe debe ser un entero mayor que 0"
    }
    if (typeof body.concepto !== "string" || !body.concepto.trim()) {
        return "El concepto es obligatorio"
    }
    if (body.categoria !== undefined &&
        (typeof body.categoria !== "string" || !body.categoria.trim())) {
        return "La categoría debe ser un texto no vacío"
    }
    return {
        importe: body.importe as number,
        concepto: body.concepto.trim(),
        categoria: typeof body.categoria === "string" ? body.categoria.trim() : "otros"
    }
}

const inicioDia = (fecha: Date): Date => {
    const inicio = new Date(fecha)
    inicio.setHours(0, 0, 0, 0)
    return inicio
}

const calcularRetiradasDiarias = async (
    cuentaId: string,
    session: ClientSession
): Promise<number> => {
    if (!movimientosCollection) throw new Error("La colección de movimientos no está configurada")
    const inicio = inicioDia(new Date()).toISOString()
    const fin = new Date(new Date(inicio).getTime() + 24 * 60 * 60 * 1000).toISOString()
    const movimientos = await movimientosCollection.find({
        cuentaId,
        fecha: { $gte: inicio, $lt: fin },
        tipo: { $in: ["retirada", "transferencia_emitida", "comision"] }
    }, { session }).toArray()
    return movimientos.reduce((total, movimiento) => total + Math.abs(movimiento.importe), 0)
}

const movimiento = (
    cuentaId: string,
    tipo: movimientoT["tipo"],
    importe: number,
    saldoResultante: number,
    concepto: string,
    categoria: string,
    fecha = new Date().toISOString(),
    transferenciaId?: string
): movimientoT => ({
    cuentaId, tipo, importe, saldoResultante, concepto, categoria, fecha,
    ...(transferenciaId ? { transferenciaId } : {})
})

export const altaCuenta = async (req: Request, res: Response): Promise<void> => {
    if (typeof req.body.clienteId !== "string" ||
        (req.body.tipo !== "corriente" && req.body.tipo !== "ahorro")) {
        res.status(400).json({ error: "Se requieren clienteId y tipo 'corriente' o 'ahorro'" })
        return
    }
    if (!ObjectId.isValid(req.body.clienteId)) {
        res.status(400).json({ error: "ID de cliente no válido" })
        return
    }

    const clienteId = new ObjectId(req.body.clienteId)
    for (let intento = 0; intento < 5; intento++) {
        const nuevaCuenta: cuentaT = {
            iban: generarIBAN(),
            clienteId: req.body.clienteId,
            tipo: req.body.tipo,
            saldo: 0,
            descubiertoMax: req.body.tipo === "corriente" ? 50000 : 0,
            estado: "activa",
            creadaEn: new Date().toISOString()
        }
        let cuentaId: ObjectId | undefined
        const session = mongoClient.startSession()
        try {
            await session.withTransaction(async () => {
                const clienteActualizado = await clientesCollection.updateOne(
                    { _id: clienteId },
                    { $inc: { cuentasRevision: 1 } },
                    { session }
                )
                if (!clienteActualizado.matchedCount) {
                    throw new ErrorReglaNegocio(404, "El cliente indicado no existe")
                }

                const cuentasNoCerradas = await cuentasCollection.countDocuments({
                    clienteId: req.body.clienteId,
                    estado: { $ne: "cerrada" }
                }, { session })
                if (cuentasNoCerradas >= 3) {
                    throw new ErrorReglaNegocio(409, "El cliente ya tiene 3 cuentas no cerradas")
                }

                const resultado = await cuentasCollection.insertOne(nuevaCuenta, { session })
                cuentaId = resultado.insertedId
            })
            res.status(201).json({ _id: cuentaId, ...nuevaCuenta })
            return
        } catch (error) {
            if (esDuplicado(error) && intento < 4) continue
            if (error instanceof ErrorReglaNegocio) {
                res.status(error.status).json({ error: error.message })
                return
            }
            if (esDuplicado(error)) {
                res.status(500).json({ error: "No se pudo generar un IBAN único tras varios intentos" })
                return
            }
            console.error("Error al crear la cuenta:", error)
            res.status(500).json({ error: "Error al crear la cuenta" })
            return
        } finally {
            await session.endSession()
        }
    }
}

export const listarCuentas = async (req: Request, res: Response): Promise<void> => {
    const { pagina, limite, skip } = paginacion(req)
    const filtro: Filter<cuentaT> = {}
    for (const campo of ["clienteId", "tipo", "estado"] as const) {
        const valor = req.query[campo]
        if (typeof valor === "string" && valor.length) {
            Object.assign(filtro, { [campo]: valor })
        }
    }

    try {
        const [cuentas, total] = await Promise.all([
            cuentasCollection.find(filtro).skip(skip).limit(limite).toArray(),
            cuentasCollection.countDocuments(filtro)
        ])
        res.status(200).json({ cuentas, total, pagina, limite })
    } catch {
        res.status(500).json({ error: "Error al listar las cuentas" })
    }
}

export const obtenerCuenta = async (req: Request, res: Response): Promise<void> => {
    const id = String(req.params.id)
    if (!ObjectId.isValid(id)) {
        res.status(400).json({ error: "ID de cuenta no válido" })
        return
    }

    try {
        const cuenta = await cuentasCollection.findOne({ _id: new ObjectId(id) })
        if (!cuenta) {
            res.status(404).json({ error: "La cuenta indicada no existe" })
            return
        }
        const cliente = ObjectId.isValid(cuenta.clienteId)
            ? await clientesCollection.findOne(
                { _id: new ObjectId(cuenta.clienteId) },
                { projection: { nombre: 1, email: 1 } }
            )
            : null
        res.status(200).json({
            ...cuenta,
            titular: cliente ? { nombre: cliente.nombre, email: cliente.email } : null
        })
    } catch {
        res.status(500).json({ error: "Error al obtener la cuenta" })
    }
}

export const cambiarEstadoCuenta = async (req: Request, res: Response): Promise<void> => {
    const id = String(req.params.id)
    if (!ObjectId.isValid(id)) {
        res.status(400).json({ error: "ID de cuenta no válido" })
        return
    }
    const solicitado = req.body.estado
    if (typeof solicitado !== "string" ||
        !["activa", "bloqueada", "cerrada"].includes(solicitado)) {
        res.status(400).json({ error: "El estado debe ser 'activa', 'bloqueada' o 'cerrada'" })
        return
    }

    try {
        const cuenta = await cuentasCollection.findOne({ _id: new ObjectId(id) })
        if (!cuenta) {
            res.status(404).json({ error: "La cuenta indicada no existe" })
            return
        }
        const permitidas: Record<cuentaT["estado"], string[]> = {
            activa: ["bloqueada", "cerrada"],
            bloqueada: ["activa", "cerrada"],
            cerrada: []
        }
        if (!permitidas[cuenta.estado].includes(solicitado)) {
            res.status(409).json({
                error: `No se puede cambiar el estado de '${cuenta.estado}' a '${solicitado}'`
            })
            return
        }
        if (solicitado === "cerrada" && cuenta.saldo !== 0) {
            res.status(409).json({
                error: `No se puede cerrar una cuenta con saldo distinto de 0 (saldo actual: ${cuenta.saldo})`
            })
            return
        }

        const resultado = await cuentasCollection.updateOne(
            {
                _id: new ObjectId(id),
                estado: cuenta.estado,
                ...(solicitado === "cerrada" ? { saldo: 0 } : {})
            },
            { $set: { estado: solicitado as cuentaT["estado"] } }
        )
        if (!resultado.matchedCount) {
            res.status(409).json({
                error: solicitado === "cerrada"
                    ? `No se puede cerrar una cuenta con saldo distinto de 0 (saldo actual: ${(await cuentasCollection.findOne({ _id: new ObjectId(id) }))?.saldo ?? "desconocido"})`
                    : `No se puede cambiar el estado de '${cuenta.estado}' a '${solicitado}'`
            })
            return
        }
        res.status(200).json(await cuentasCollection.findOne({ _id: new ObjectId(id) }))
    } catch {
        res.status(500).json({ error: "Error al cambiar el estado de la cuenta" })
    }
}

const operarCuenta = async (
    req: Request,
    res: Response,
    tipo: "ingreso" | "retirada"
): Promise<void> => {
    const id = String(req.params.id)
    if (!ObjectId.isValid(id)) {
        res.status(400).json({ error: "ID de cuenta no válido" })
        return
    }
    if (!movimientosCollection) {
        res.status(500).json({ error: "La colección de movimientos no está configurada" })
        return
    }
    const coleccionMovimientos = movimientosCollection
    const datos = datosMovimiento(req.body)
    if (typeof datos === "string") {
        res.status(400).json({ error: datos })
        return
    }

    const session = mongoClient.startSession()
    let nuevoMovimiento: movimientoT | undefined
    try {
        await session.withTransaction(async () => {
            const cuenta = await cuentasCollection.findOne(
                { _id: new ObjectId(id) },
                { session }
            )
            if (!cuenta) throw new ErrorReglaNegocio(404, "La cuenta indicada no existe")
            if (cuenta.estado === "cerrada" ||
                (tipo === "retirada" && cuenta.estado !== "activa")) {
                throw new ErrorReglaNegocio(
                    409,
                    tipo === "retirada"
                        ? `No se puede retirar de una cuenta en estado '${cuenta.estado}'`
                        : "Una cuenta cerrada no admite operaciones"
                )
            }

            if (tipo === "retirada") {
                const retiradoHoy = await calcularRetiradasDiarias(id, session)
                if (retiradoHoy + datos.importe > 100000) {
                    throw new ErrorReglaNegocio(
                        409,
                        "Se ha superado el límite diario de retiradas de 100000 céntimos"
                    )
                }
                if (cuenta.saldo - datos.importe < -cuenta.descubiertoMax) {
                    throw new ErrorReglaNegocio(
                        409,
                        `Saldo insuficiente: disponible ${cuenta.saldo + cuenta.descubiertoMax} céntimos (incluido descubierto), solicitado ${datos.importe}`
                    )
                }
            }

            const cambio = tipo === "ingreso" ? datos.importe : -datos.importe
            const saldoResultante = cuenta.saldo + cambio
            if (!Number.isSafeInteger(saldoResultante)) {
                throw new ErrorReglaNegocio(409, "La operación excede el rango seguro del saldo")
            }
            const filtro: Filter<cuentaT> = {
                _id: new ObjectId(id),
                estado: tipo === "ingreso" ? { $ne: "cerrada" } : "activa",
                ...(tipo === "retirada"
                    ? { saldo: { $gte: datos.importe - cuenta.descubiertoMax } }
                    : {})
            }
            const actualizacion = await cuentasCollection.updateOne(
                filtro,
                { $inc: { saldo: cambio } },
                { session }
            )
            if (!actualizacion.matchedCount) {
                throw new ErrorReglaNegocio(
                    409,
                    `Saldo insuficiente: disponible ${cuenta.saldo + cuenta.descubiertoMax} céntimos (incluido descubierto), solicitado ${datos.importe}`
                )
            }

            nuevoMovimiento = movimiento(
                id,
                tipo,
                tipo === "ingreso" ? datos.importe : -datos.importe,
                saldoResultante,
                datos.concepto,
                datos.categoria
            )
            await coleccionMovimientos.insertOne(nuevoMovimiento, { session })
        })
        res.status(201).json(nuevoMovimiento)
    } catch (error) {
        if (error instanceof ErrorReglaNegocio) {
            res.status(error.status).json({ error: error.message })
            return
        }
        console.error(`Error al registrar el ${tipo}:`, error)
        res.status(500).json({ error: `Error al registrar el ${tipo}` })
    } finally {
        await session.endSession()
    }
}

export const ingresar = (req: Request, res: Response): Promise<void> =>
    operarCuenta(req, res, "ingreso")

export const retirar = (req: Request, res: Response): Promise<void> =>
    operarCuenta(req, res, "retirada")

export const transferir = async (req: Request, res: Response): Promise<void> => {
    if (!movimientosCollection) {
        res.status(500).json({ error: "La colección de movimientos no está configurada" })
        return
    }
    const coleccionMovimientos = movimientosCollection
    const origenIban = typeof req.body.ibanOrigen === "string" ? req.body.ibanOrigen.trim().toUpperCase() : ""
    const destinoIban = typeof req.body.ibanDestino === "string" ? req.body.ibanDestino.trim().toUpperCase() : ""
    if (!esIbanValido(origenIban)) {
        res.status(400).json({ error: "El IBAN de origen no es válido" })
        return
    }
    if (!esIbanValido(destinoIban)) {
        res.status(400).json({ error: "El IBAN de destino no es válido" })
        return
    }
    if (origenIban === destinoIban) {
        res.status(400).json({ error: "Las cuentas de origen y destino deben ser distintas" })
        return
    }
    const datos = datosMovimiento(req.body)
    if (typeof datos === "string") {
        res.status(400).json({ error: datos })
        return
    }

    const session = mongoClient.startSession()
    let respuesta: {
        transferenciaId: string
        importe: number
        comision: number
        saldoOrigen: number
        saldoDestino: number
        movimientos: movimientoT[]
    } | undefined
    try {
        await session.withTransaction(async () => {
            const origen = await cuentasCollection.findOne({ iban: origenIban }, { session })
            const destino = await cuentasCollection.findOne({ iban: destinoIban }, { session })
            if (!origen || !destino) {
                throw new ErrorReglaNegocio(404, "No se encontró la cuenta de origen o destino")
            }
            if (origen.estado !== "activa") {
                throw new ErrorReglaNegocio(
                    409,
                    `La cuenta de origen debe estar activa (estado actual: '${origen.estado}')`
                )
            }
            if (destino.estado === "cerrada") {
                throw new ErrorReglaNegocio(409, "La cuenta de destino está cerrada")
            }

            const comision = origen.clienteId === destino.clienteId
                ? 0
                : Math.max(
                    100,
                    Math.floor(datos.importe / 200) + (datos.importe % 200 === 0 ? 0 : 1)
                )
            const totalDebito = datos.importe + comision
            if (!Number.isSafeInteger(totalDebito)) {
                throw new ErrorReglaNegocio(400, "El importe total de la transferencia excede el rango permitido")
            }

            const retiradoHoy = await calcularRetiradasDiarias(String(origen._id), session)
            if (retiradoHoy + totalDebito > 100000) {
                throw new ErrorReglaNegocio(
                    409,
                    "Se ha superado el límite diario de retiradas de 100000 céntimos"
                )
            }
            if (origen.saldo - totalDebito < -origen.descubiertoMax) {
                throw new ErrorReglaNegocio(
                    409,
                    `Saldo insuficiente: disponible ${origen.saldo + origen.descubiertoMax} céntimos (incluido descubierto), solicitado ${totalDebito}`
                )
            }
            if (!Number.isSafeInteger(destino.saldo + datos.importe)) {
                throw new ErrorReglaNegocio(409, "La transferencia excede el rango seguro del saldo de destino")
            }

            const actualizacionOrigen = await cuentasCollection.updateOne(
                {
                    _id: origen._id,
                    estado: "activa",
                    saldo: { $gte: totalDebito - origen.descubiertoMax }
                },
                { $inc: { saldo: -totalDebito } },
                { session }
            )
            if (!actualizacionOrigen.matchedCount) {
                throw new ErrorReglaNegocio(
                    409,
                    `Saldo insuficiente: disponible ${origen.saldo + origen.descubiertoMax} céntimos (incluido descubierto), solicitado ${totalDebito}`
                )
            }

            const actualizacionDestino = await cuentasCollection.updateOne(
                { _id: destino._id, estado: { $in: ["activa", "bloqueada"] } },
                { $inc: { saldo: datos.importe } },
                { session }
            )
            if (!actualizacionDestino.matchedCount) {
                throw new ErrorReglaNegocio(409, "La cuenta destino ya no admite transferencias")
            }

            const origenActualizado = await cuentasCollection.findOne({ _id: origen._id }, { session })
            const destinoActualizado = await cuentasCollection.findOne({ _id: destino._id }, { session })
            if (!origenActualizado || !destinoActualizado) {
                throw new Error("No se pudieron leer los saldos actualizados de la transferencia")
            }

            const transferenciaId = new ObjectId().toHexString()
            const fecha = new Date().toISOString()
            const movimientos: movimientoT[] = [
                movimiento(
                    String(origen._id),
                    "transferencia_emitida",
                    -datos.importe,
                    origenActualizado.saldo + comision,
                    datos.concepto,
                    datos.categoria,
                    fecha,
                    transferenciaId
                ),
                movimiento(
                    String(destino._id),
                    "transferencia_recibida",
                    datos.importe,
                    destinoActualizado.saldo,
                    datos.concepto,
                    datos.categoria,
                    fecha,
                    transferenciaId
                )
            ]
            if (comision > 0) {
                movimientos.push(movimiento(
                    String(origen._id),
                    "comision",
                    -comision,
                    origenActualizado.saldo,
                    "Comisión por transferencia",
                    "comisiones",
                    fecha,
                    transferenciaId
                ))
            }
            await coleccionMovimientos.insertMany(movimientos, { session })
            respuesta = {
                transferenciaId,
                importe: datos.importe,
                comision,
                saldoOrigen: origenActualizado.saldo,
                saldoDestino: destinoActualizado.saldo,
                movimientos
            }
        })
        res.status(201).json(respuesta)
    } catch (error) {
        if (error instanceof ErrorReglaNegocio) {
            res.status(error.status).json({ error: error.message })
            return
        }
        console.error("Error al realizar la transferencia:", error)
        res.status(500).json({ error: "Error al realizar la transferencia" })
    } finally {
        await session.endSession()
    }
}

const fechaValida = (valor: string): boolean => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(valor)) return false
    const fecha = new Date(`${valor}T00:00:00.000Z`)
    return !Number.isNaN(fecha.getTime()) && fecha.toISOString().slice(0, 10) === valor
}

export const listarMovimientosCuenta = async (req: Request, res: Response): Promise<void> => {
    const id = String(req.params.id)
    if (!ObjectId.isValid(id)) {
        res.status(400).json({ error: "ID de cuenta no válido" })
        return
    }
    if (!movimientosCollection) {
        res.status(500).json({ error: "La colección de movimientos no está configurada" })
        return
    }

    try {
        const cuenta = await cuentasCollection.findOne({ _id: new ObjectId(id) })
        if (!cuenta) {
            res.status(404).json({ error: "La cuenta indicada no existe" })
            return
        }

        const filtro: Filter<movimientoT> = { cuentaId: id }
        if (typeof req.query.tipo === "string" && req.query.tipo) {
            const tipos = req.query.tipo.split(",").map(tipo => tipo.trim()).filter(Boolean)
            if (tipos.length > 1) Object.assign(filtro, { tipo: { $in: tipos } })
            else if (tipos.length === 1) Object.assign(filtro, { tipo: tipos[0] })
        }
        if (typeof req.query.categoria === "string" && req.query.categoria) {
            filtro.categoria = req.query.categoria
        }
        const desde = typeof req.query.desde === "string" ? req.query.desde : undefined
        const hasta = typeof req.query.hasta === "string" ? req.query.hasta : undefined
        if ((desde && !fechaValida(desde)) || (hasta && !fechaValida(hasta))) {
            res.status(400).json({ error: "Las fechas deben tener formato YYYY-MM-DD válido" })
            return
        }
        if (desde || hasta) {
            const rango: Record<string, string> = {}
            if (desde) rango.$gte = `${desde}T00:00:00.000Z`
            if (hasta) {
                rango.$lt = new Date(
                    new Date(`${hasta}T00:00:00.000Z`).getTime() + 86400000
                ).toISOString()
            }
            Object.assign(filtro, { fecha: rango })
        }

        const { pagina, limite, skip } = paginacion(req)
        const orden = req.query.orden === "fecha" ? 1 : -1
        const [datos, totalElementos] = await Promise.all([
            movimientosCollection.find(filtro).sort({ fecha: orden }).skip(skip).limit(limite).toArray(),
            movimientosCollection.countDocuments(filtro)
        ])
        res.status(200).json({
            datos,
            pagina,
            limite,
            totalElementos,
            totalPaginas: Math.ceil(totalElementos / limite)
        })
    } catch {
        res.status(500).json({ error: "Error al obtener los movimientos" })
    }
}
