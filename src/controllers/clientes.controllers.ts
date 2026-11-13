import type { Request, Response } from "express"
import type { Collection } from "mongodb"
import { MongoServerError, ObjectId } from "mongodb"
import type { clienteT } from "../models/models.js"

export let clientesCollection: Collection<clienteT>

export const configCollection = (coleccion: Collection<clienteT>): void => {
    clientesCollection = coleccion
}

const esDuplicado = (error: unknown): boolean =>
    error instanceof MongoServerError && error.code === 11000

const validarCliente = (body: Record<string, unknown>): string | null => {
    if (typeof body.nombre !== "string" || !body.nombre.trim()) {
        return "El nombre es obligatorio"
    }
    if (typeof body.email !== "string" ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())) {
        return "El email no es válido"
    }
    if (typeof body.dni !== "string" || !/^\d{8}[A-Za-z]$/.test(body.dni.trim())) {
        return "El DNI debe tener 8 dígitos y una letra"
    }
    return null
}

export const crearCliente = async (req: Request, res: Response): Promise<void> => {
    const errorValidacion = validarCliente(req.body)
    if (errorValidacion) {
        res.status(400).json({ error: errorValidacion })
        return
    }

    const nuevoCliente: clienteT = {
        nombre: (req.body.nombre as string).trim(),
        email: (req.body.email as string).trim().toLowerCase(),
        dni: (req.body.dni as string).trim().toUpperCase(),
        creadoEn: new Date().toISOString()
    }

    try {
        const resultado = await clientesCollection.insertOne(nuevoCliente)
        res.status(201).json({ _id: resultado.insertedId, ...nuevoCliente })
    } catch (error) {
        if (esDuplicado(error)) {
            res.status(409).json({ error: "Ya existe un cliente con ese email o DNI" })
            return
        }
        res.status(500).json({ error: "Error al crear el cliente" })
    }
}

export const getClientes = async (req: Request, res: Response): Promise<void> => {
    const paginaSolicitada = typeof req.query.pagina === "string" ? Number(req.query.pagina) : 1
    const limiteSolicitado = typeof req.query.limite === "string" ? Number(req.query.limite) : 20
    const pagina = Number.isSafeInteger(paginaSolicitada) && paginaSolicitada > 0
        ? paginaSolicitada
        : 1
    const limite = Number.isSafeInteger(limiteSolicitado) && limiteSolicitado > 0
        ? Math.min(limiteSolicitado, 100)
        : 20
    const skip = (pagina - 1) * limite

    try {
        const [clientes, total] = await Promise.all([
            clientesCollection.find({}, { projection: { cuentasRevision: 0 } })
                .skip(skip).limit(limite).toArray(),
            clientesCollection.countDocuments()
        ])
        res.status(200).json({ clientes, total, pagina, limite })
    } catch {
        res.status(500).json({ error: "Error al buscar los clientes" })
    }
}

export const getClientesWithId = async (req: Request, res: Response): Promise<void> => {
    const id = String(req.params.id)
    if (!ObjectId.isValid(id)) {
        res.status(400).json({ error: "ID no válido" })
        return
    }

    try {
        const cliente = await clientesCollection.findOne(
            { _id: new ObjectId(id) },
            { projection: { cuentasRevision: 0 } }
        )
        if (!cliente) {
            res.status(404).json({ error: "No existe un cliente con ese ID" })
            return
        }
        res.status(200).json(cliente)
    } catch {
        res.status(500).json({ error: "Error al buscar el cliente" })
    }
}

export const changeCliente = async (req: Request, res: Response): Promise<void> => {
    const id = String(req.params.id)
    if (!ObjectId.isValid(id)) {
        res.status(400).json({ error: "ID no válido" })
        return
    }

    try {
        const actual = await clientesCollection.findOne(
            { _id: new ObjectId(id) },
            { projection: { cuentasRevision: 0 } }
        )
        if (!actual) {
            res.status(404).json({ error: "Cliente no encontrado" })
            return
        }

        if (req.body.dni !== undefined &&
            (typeof req.body.dni !== "string" ||
                req.body.dni.trim().toUpperCase() !== actual.dni)) {
            res.status(400).json({ error: "El DNI no se puede modificar" })
            return
        }

        const datos = {
            nombre: req.body.nombre ?? actual.nombre,
            email: req.body.email ?? actual.email,
            dni: actual.dni
        }
        const errorValidacion = validarCliente(datos)
        if (errorValidacion) {
            res.status(400).json({ error: errorValidacion })
            return
        }

        await clientesCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: {
                nombre: (datos.nombre as string).trim(),
                email: (datos.email as string).trim().toLowerCase()
            } }
        )
        res.status(200).json({
            ...actual,
            nombre: (datos.nombre as string).trim(),
            email: (datos.email as string).trim().toLowerCase()
        })
    } catch (error) {
        if (esDuplicado(error)) {
            res.status(409).json({ error: "Ya existe un cliente con ese email" })
            return
        }
        res.status(500).json({ error: "Error al actualizar el cliente" })
    }
}
