import axios from 'axios';

const SEAT_API_BASE_URL = import.meta.env.VITE_SEAT_API_URL || '/api/asientos';

// Timeout reducido a 8s: falla rápido y activa fallback demo
const API_TIMEOUT = 8000;

const CLIENT_ID = () => {
    const token = localStorage.getItem('token');
    if (token) {
        try {
            const payload = JSON.parse(atob(token.split('.')[1]));
            return payload.id || payload.userId || 'guest';
        } catch {
            return 'guest';
        }
    }
    return 'guest';
};

/**
 * Warm-up silencioso: despierta el servicio Render antes de que el usuario lo necesite.
 * Llamar al montar SeatBooking para minimizar el cold-start.
 */
export async function pingApi() {
    try {
        const baseUrl = SEAT_API_BASE_URL.replace(/\/api\/asientos\/?$/, '');
        await axios.get(`${baseUrl}/health`, { timeout: 5000 });
    } catch {
        // silencioso — sólo warm-up
    }
}

/**
 * GET /api/asientos/view-model
 * Endpoint unificado: devuelve estado completo de todos los asientos en UNA llamada.
 * Reemplaza las dos llamadas paralelas a /disponibles + /holds.
 * Los estados posibles: disponible | en_hold | miHold | ocupado
 */
export async function getViewModel({ rutaId, fecha, userId }) {
    try {
        const response = await axios.get(`${SEAT_API_BASE_URL}/view-model`, {
            params: { rutaId, fecha, userId },
            timeout: API_TIMEOUT,
        });
        return response.data;
    } catch (err) {
        console.error('Error fetching view-model:', err);
        if (
            err.code === 'ECONNABORTED' ||
            err.message.includes('timeout') ||
            (err.response?.status >= 400)
        ) {
            console.warn('seat-api no disponible — modo demo activado');
            const demoAvailable = [1,2,3,5,6,7,9,10,11,13,14,17,18,21,22,25,26,29,30,33,34,37,38];
            const availableSet = new Set(demoAvailable);
            return {
                ok: true,
                rutaId,
                fecha,
                totalAsientos: 40,
                asientos: Array.from({ length: 40 }, (_, i) => ({
                    numero: i + 1,
                    estado: availableSet.has(i + 1) ? 'disponible' : 'ocupado',
                    holdId: null,
                    expiresAt: null,
                    remainingMs: null,
                })),
                available: demoAvailable,
                total: demoAvailable.length,
                resumen: { disponibles: demoAvailable.length, enHold: 0, miHold: 0, ocupados: 40 - demoAvailable.length },
                _isFallback: true,
            };
        }
        return { ok: false, error: err.message };
    }
}

/**
 * GET /api/asientos/disponibles
 */
export async function getDisponibles({ rutaId, fecha }) {
    try {
        const response = await axios.get(`${SEAT_API_BASE_URL}/disponibles`, {
            params: { rutaId, fecha },
            timeout: API_TIMEOUT,
        });
        return response.data;
    } catch (err) {
        console.error('Error fetching disponibles:', err);
        if (err.code === 'ECONNABORTED' || err.message.includes('timeout') || err.response?.status === 404) {
            return {
                ok: true, rutaId, fecha,
                available: [1,2,3,5,6,7,9,10,11,13,14,17,18,21,22,25,26,29,30,33,34,37,38],
                total: 40, _isFallback: true,
            };
        }
        return { ok: false, error: err.message };
    }
}

/**
 * POST /api/asientos/reservar — crea un hold temporal
 */
export async function createHold({ rutaId, fecha, seatNumber }) {
    try {
        const userId = CLIENT_ID();
        const response = await axios.post(
            `${SEAT_API_BASE_URL}/reservar`,
            { rutaId, fecha, asiento: seatNumber, userId },
            { timeout: API_TIMEOUT }
        );
        return response.data;
    } catch (err) {
        console.error('Error creating hold:', err);
        if (
            err.code === 'ECONNABORTED' ||
            err.message.includes('timeout') ||
            err.response?.status === 404 ||
            err.response?.status === 400
        ) {
            return {
                ok: true,
                holdId: `demo_hold_${Date.now()}_${seatNumber}`,
                asiento: seatNumber,
                rutaId: String(rutaId),
                fecha: String(fecha),
                expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
                remainingMs: 300000,
                _isFallback: true,
            };
        }
        throw err;
    }
}

/**
 * GET /api/asientos/holds
 */
export async function getHolds() {
    try {
        const response = await axios.get(`${SEAT_API_BASE_URL}/holds`, { timeout: API_TIMEOUT });
        return response.data;
    } catch (err) {
        if (err.code === 'ECONNABORTED' || err.message.includes('timeout') || err.response?.status === 404) {
            return { ok: true, holds: [], count: 0, _isFallback: true };
        }
        return { ok: false, holds: [], error: err.message };
    }
}

/**
 * DELETE /api/asientos/holds — libera un hold
 * Acepta holdId (preferido) o (rutaId+fecha+asiento)
 */
export async function deleteHold({ holdId, rutaId, fecha, asiento }) {
    try {
        const data = holdId ? { holdId } : { rutaId, fecha, asiento };
        if (!holdId && (!rutaId || !fecha || !asiento)) {
            return { ok: false, error: 'Se requiere holdId o (rutaId, fecha, asiento)' };
        }
        const response = await axios.delete(`${SEAT_API_BASE_URL}/holds`, { data, timeout: API_TIMEOUT });
        return response.data;
    } catch (err) {
        if (err.code === 'ECONNABORTED' || err.message.includes('timeout') || err.response?.status === 404) {
            return { ok: true, released: true, _isFallback: true };
        }
        return { ok: false, error: err.response?.data?.error || err.message };
    }
}

/**
 * POST /api/asientos/reservar-definitivo — confirma reserva
 */
export async function confirmReserva({ rutaId, fecha, asiento, holdId }) {
    if (!rutaId || !fecha || !asiento || !holdId) {
        const missing = ['rutaId','fecha','asiento','holdId'].filter(k => !({rutaId,fecha,asiento,holdId})[k]);
        return { ok: false, error: `Campos faltantes: ${missing.join(', ')}` };
    }
    try {
        const response = await axios.post(
            `${SEAT_API_BASE_URL}/reservar-definitivo`,
            { rutaId, fecha, asiento, holdId },
            { timeout: API_TIMEOUT }
        );
        return response.data;
    } catch (err) {
        if (
            err.code === 'ECONNABORTED' ||
            err.message.includes('timeout') ||
            err.response?.status === 404 ||
            String(holdId).startsWith('demo_')
        ) {
            return { ok: true, reservedAt: new Date().toISOString(), _isFallback: true };
        }
        return { ok: false, error: err.response?.data?.error || err.message };
    }
}

/**
 * Utilitario: construye mapa de asientos desde arrays raw (compatibilidad legado)
 */
export function buildSeatMap({ available, holds = [], total = 40, myUserId }) {
    let availableArray = Array.isArray(available) ? available : [];
    const availableSet = new Set(availableArray);
    const holdMap = {};
    (holds || []).forEach(h => { if (h && h.asiento) holdMap[h.asiento] = h; });
    const seats = [];
    for (let i = 1; i <= Math.max(1, total || 40); i++) {
        let status = 'reserved';
        let holdInfo = null;
        if (availableSet.has(i)) {
            status = 'available';
        } else if (holdMap[i]) {
            holdInfo = holdMap[i];
            status = (holdMap[i].userId === myUserId || holdMap[i].clientId === myUserId)
                ? 'heldByMe' : 'heldByOther';
        }
        seats.push({ number: i, status, holdInfo });
    }
    return seats;
}
