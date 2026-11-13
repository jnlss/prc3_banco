import type { ObjectId } from "mongodb"


export type clienteT = {
    _id?: ObjectId;
    nombre: string;
    email: string;
    dni: string;
    creadoEn?: string;
    cuentasRevision?: number;
}

export type cuentaT = {
    _id?: ObjectId;
    iban: string;
    clienteId: string;
    tipo: "corriente" | "ahorro";
    saldo: number;
    descubiertoMax: number;
    estado: "activa" | "bloqueada" | "cerrada";
    creadaEn: string;
}


export type movimientoT = {
    _id?: ObjectId;
    cuentaId: string;
    tipo: "ingreso" | "retirada" | "transferencia_emitida" | "transferencia_recibida" | "comision";
    importe: number;
    saldoResultante: number;
    concepto: string;
    categoria: string;
    transferenciaId?: string;
    fecha: string;
}