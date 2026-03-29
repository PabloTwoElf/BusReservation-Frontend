import React, { useState, useEffect, useCallback, useMemo, memo } from 'react';
import HoldTimer from './HoldTimer';
import './BusSeatSelector.css';
import {
    getViewModel,
    createHold,
    deleteHold,
    confirmReserva,
} from '../services/asientosService';
import { getPricing } from '../services/pricingService';

// =============================================================================
// SeatButton FUERA del componente padre → evita re-montaje de 40 botones
// en cada cambio de estado (el bug de perf más crítico)
// =============================================================================
const SeatButton = memo(({ seat, isSelected, loading, onSeatClick }) => {
    let className = `seat seat-${seat.status}`;
    if (isSelected) className += ' seat-selected';
    return (
        <button
            className={className}
            onClick={() => onSeatClick(seat)}
            disabled={loading || (seat.status !== 'available' && seat.status !== 'heldByMe')}
            title={`Asiento ${seat.number} - ${seat.status}`}
        >
            {seat.number}
        </button>
    );
});
SeatButton.displayName = 'SeatButton';

// Skeleton mientras carga el mapa
const SkeletonGrid = () => (
    <div className="seats-grid">
        {Array.from({ length: 10 }, (_, i) => (
            <div key={i} className="bus-row" style={{ opacity: 0.35 }}>
                <div className="seat seat-reserved" style={{ cursor: 'default' }}>·</div>
                <div className="seat seat-reserved" style={{ cursor: 'default' }}>·</div>
                <div className="aisle" />
                <div className="seat seat-reserved" style={{ cursor: 'default' }}>·</div>
                <div className="seat seat-reserved" style={{ cursor: 'default' }}>·</div>
            </div>
        ))}
        <p style={{ textAlign: 'center', color: '#666', marginTop: 8, fontSize: 13 }}>
            Cargando mapa de asientos…
        </p>
    </div>
);

// =============================================================================
// Componente principal
// =============================================================================
const BusSeatSelector = ({ rutaId, fecha, onClose, onReservationComplete }) => {
    const [seats, setSeats] = useState([]);
    const [loadingMap, setLoadingMap] = useState(false); // carga inicial del mapa
    const [loading, setLoading] = useState(false);       // acciones (hold/release/confirm)
    const [error, setError] = useState(null);
    const [myHolds, setMyHolds] = useState([]);
    const [pricingInfo, setPricingInfo] = useState(null);
    const [apiResponse, setApiResponse] = useState(null);
    const [showDebug, setShowDebug] = useState(false);

    const normalizeRutaId = useCallback((v) => {
        if (!v) return '';
        if (typeof v === 'string') return v;
        if (typeof v === 'object') return v._id || v.id || String(v);
        return String(v);
    }, []);

    const normalizedRutaId = useMemo(() => normalizeRutaId(rutaId), [rutaId, normalizeRutaId]);

    // Calculado una sola vez al montar — el token no cambia durante la sesión
    const myUserId = useMemo(() => {
        const token = localStorage.getItem('token');
        if (!token) return 'guest';
        try {
            const payload = JSON.parse(atob(token.split('.')[1]));
            return payload.id || payload.userId || 'guest';
        } catch { return 'guest'; }
    }, []);

    // Set de números de asientos seleccionados — O(1) lookup en render
    const selectedSeatNumbers = useMemo(
        () => new Set(myHolds.map(h => h.asiento)),
        [myHolds]
    );

    // Convierte estado del view-model al formato interno del componente
    const vmEstadoToStatus = (estado) => {
        switch (estado) {
            case 'disponible': return 'available';
            case 'miHold':    return 'heldByMe';
            case 'en_hold':   return 'heldByOther';
            case 'ocupado':   return 'reserved';
            default:          return 'reserved';
        }
    };

    // Carga del mapa — UNA sola petición al endpoint /view-model
    const loadSeats = useCallback(async () => {
        const rid = normalizeRutaId(rutaId);
        if (!rid || !fecha) return;
        setLoadingMap(true);
        setError(null);
        try {
            const vm = await getViewModel({ rutaId: rid, fecha, userId: myUserId });
            setApiResponse(vm);
            if (vm.ok) {
                setSeats(vm.asientos.map(a => ({
                    number: a.numero,
                    status: vmEstadoToStatus(a.estado),
                    holdInfo: a.holdId ? { holdId: a.holdId, expiresAt: a.expiresAt } : null,
                })));
                // Sincronizar mis holds desde la API (útil en F5 / sesión recuperada)
                const myActiveFromVM = vm.asientos
                    .filter(a => a.estado === 'miHold' && a.holdId)
                    .map(a => ({
                        holdId: a.holdId,
                        asiento: a.numero,
                        rutaId: rid,
                        fecha,
                        expiresAt: a.expiresAt,
                        remainingMs: a.remainingMs,
                    }));
                if (myHolds.length === 0 && myActiveFromVM.length > 0) {
                    setMyHolds(myActiveFromVM);
                }
            } else if (vm._isFallback) {
                setSeats(vm.asientos.map(a => ({ number: a.numero, status: 'available', holdInfo: null })));
            } else {
                setError(vm.error || 'Error al cargar asientos');
            }
        } catch (e) {
            setError(e.message);
        } finally {
            setLoadingMap(false);
        }
    }, [normalizedRutaId, fecha, myUserId]);

    useEffect(() => { loadSeats(); }, [loadSeats]);

    // Auto-refresh cada 15 s sólo si no hay holds activos propios
    useEffect(() => {
        if (myHolds.length > 0) return;
        const id = setInterval(loadSeats, 15000);
        return () => clearInterval(id);
    }, [loadSeats, myHolds.length]);

    // Calcular precio
    const calculateTotalPrice = useCallback(async () => {
        if (myHolds.length === 0) { setPricingInfo(null); return; }
        try {
            const r = await getPricing(myHolds.length, normalizedRutaId);
            if (r.ok) {
                setPricingInfo({
                    ok: true,
                    cantidad: r.cantidad,
                    cantidadAsientos: r.cantidad,
                    precioBase: r.precioUnitario,
                    precioBaseTotal: r.subtotal,
                    porcentajeDescuento: r.porcentajeDescuento,
                    descuento: r.montoDescuento,
                    descuentoTotal: r.montoDescuento,
                    recargo: 0, recargoTotal: 0,
                    totalPagar: r.total,
                    ahorros: r.ahorros,
                    _isFallback: r._isFallback || false,
                });
            } else { setPricingInfo(null); }
        } catch { setPricingInfo(null); }
    }, [myHolds.length, normalizedRutaId]);

    useEffect(() => { calculateTotalPrice(); }, [calculateTotalPrice]);

    // Click en asiento: crear o liberar hold
    const handleSeatClick = useCallback(async (seat) => {
        if (!seat) return;
        const rid = normalizeRutaId(rutaId);
        if (!rid || !fecha) { setError('Faltan rutaId o fecha'); return; }

        const existingHold = myHolds.find(h => h.asiento === seat.number);

        if (existingHold) {
            setLoading(true); setError(null);
            try {
                const r = await deleteHold({
                    holdId: existingHold.holdId,
                    rutaId: existingHold.rutaId || rid,
                    fecha: existingHold.fecha || fecha,
                    asiento: existingHold.asiento,
                });
                if (r.ok) {
                    setMyHolds(prev => prev.filter(h => h.holdId !== existingHold.holdId));
                    await loadSeats();
                } else { setError(r.error || 'Error al cancelar hold'); }
            } catch (e) { setError(e.message); }
            finally { setLoading(false); }

        } else if (seat.status === 'available') {
            setLoading(true); setError(null);
            try {
                const r = await createHold({ rutaId: rid, fecha, seatNumber: seat.number });
                if (r.ok) {
                    setMyHolds(prev => [...prev, {
                        holdId: r.holdId,
                        asiento: seat.number,
                        rutaId: rid,
                        fecha: String(fecha),
                        expiresAt: r.expiresAt,
                        remainingMs: r.remainingMs,
                    }]);
                    await loadSeats();
                } else { setError(r.error || 'Error al crear hold'); }
            } catch (e) { setError(e.message); }
            finally { setLoading(false); }
        }
    }, [myHolds, rutaId, fecha, normalizeRutaId, loadSeats]);

    const handleCancelAll = async () => {
        if (myHolds.length === 0) return;
        if (!window.confirm(`¿Cancelar todos los holds? (${myHolds.length} asiento${myHolds.length > 1 ? 's' : ''})`)) return;
        setLoading(true);
        const rid = normalizeRutaId(rutaId);
        try {
            await Promise.all(myHolds.map(h => deleteHold({
                holdId: h.holdId,
                rutaId: h.rutaId || rid,
                fecha: h.fecha || fecha,
                asiento: h.asiento,
            })));
            setMyHolds([]);
            setPricingInfo(null);
            await loadSeats();
        } catch (e) { setError(e.message); }
        finally { setLoading(false); }
    };

    const handleConfirm = async () => {
        if (myHolds.length === 0) return;
        const invalid = myHolds.filter(h => !h.holdId || !h.rutaId || !h.fecha || !h.asiento);
        if (invalid.length > 0) { setError('Algunos holds no tienen todos los datos requeridos. Cancela y vuelve a seleccionar.'); return; }
        setLoading(true); setError(null);
        try {
            const results = await Promise.all(myHolds.map(h =>
                confirmReserva({ holdId: h.holdId, rutaId: h.rutaId, fecha: h.fecha, asiento: h.asiento })
            ));
            const successful = results.filter(r => r.ok);
            const failed = results.filter(r => !r.ok);
            if (successful.length > 0) {
                alert(`¡${successful.length} reserva${successful.length > 1 ? 's' : ''} confirmada${successful.length > 1 ? 's' : ''}!`);
                if (onReservationComplete) onReservationComplete({
                    ok: true,
                    asientos: myHolds.map(h => h.asiento),
                    rutaId: myHolds[0]?.rutaId,
                    fecha: myHolds[0]?.fecha,
                    precio: pricingInfo || null,
                    results: successful,
                });
                setMyHolds([]); setPricingInfo(null);
                await loadSeats();
                if (failed.length > 0) alert(`Advertencia: ${failed.length} reserva(s) no se pudieron confirmar.`);
            } else { setError('No se pudo confirmar ninguna reserva'); }
        } catch (e) { setError(e.message); }
        finally { setLoading(false); }
    };

    const handleTimerExpire = useCallback((expiredHoldId) => {
        setMyHolds(prev => prev.filter(h => h.holdId !== expiredHoldId));
        loadSeats();
    }, [loadSeats]);

    // Renderizar grilla del bus (4 columnas: 2 + pasillo + 2)
    const renderBusGrid = useCallback(() => {
        const rows = [];
        for (let i = 0; i < seats.length; i += 4) {
            const row = seats.slice(i, i + 4);
            rows.push(
                <div key={i} className="bus-row">
                    {[0,1].map(j => row[j]
                        ? <SeatButton key={row[j].number} seat={row[j]}
                            isSelected={selectedSeatNumbers.has(row[j].number)}
                            loading={loading} onSeatClick={handleSeatClick} />
                        : <div key={`p${i}${j}`} className="seat-placeholder" />
                    )}
                    <div className="aisle" />
                    {[2,3].map(j => row[j]
                        ? <SeatButton key={row[j].number} seat={row[j]}
                            isSelected={selectedSeatNumbers.has(row[j].number)}
                            loading={loading} onSeatClick={handleSeatClick} />
                        : <div key={`p${i}${j}`} className="seat-placeholder" />
                    )}
                </div>
            );
        }
        return rows;
    }, [seats, selectedSeatNumbers, loading, handleSeatClick]);

    const selectedSeatsList = useMemo(() => myHolds.map(h => h.asiento).sort((a,b) => a-b), [myHolds]);

    return (
        <div className="bus-seat-selector">
            <div className="selector-header">
                <h2 style={{ color: '#000' }}>Selección de Asientos</h2>
                <p style={{ color: '#000' }}>Ruta: {normalizedRutaId || 'N/A'} | Fecha: {String(fecha || '')}</p>
                {onClose && <button className="btn-close" onClick={onClose}>✕</button>}
            </div>

            {error && (
                <div className="error-banner">
                    <span style={{ color: '#000' }}>{error}</span>
                    <button onClick={() => setError(null)}>✕</button>
                </div>
            )}

            {loading && <div className="loading-overlay" style={{ color: '#000' }}>Procesando…</div>}

            <div className="bus-container">
                <div className="driver-section">🚌 Conductor</div>
                <div className="seats-grid">
                    {loadingMap ? <SkeletonGrid /> : seats.length === 0
                        ? <div style={{ color:'#000', padding:'20px', textAlign:'center' }}>No hay asientos disponibles</div>
                        : renderBusGrid()
                    }
                </div>
            </div>

            <div className="legend">
                <span className="legend-item"><span className="dot available"></span> Disponible</span>
                <span className="legend-item"><span className="dot heldByMe"></span> Mi Hold</span>
                <span className="legend-item"><span className="dot heldByOther"></span> Ocupado (Hold)</span>
                <span className="legend-item"><span className="dot reserved"></span> Reservado</span>
            </div>

            {selectedSeatsList.length > 0 && (
                <div className="selected-seats-panel" style={{ background:'#e8f5e9', border:'2px solid #4caf50', borderRadius:'8px', padding:'15px', marginBottom:'15px' }}>
                    <strong style={{ color:'#000', display:'block', marginBottom:'10px', fontSize:'16px' }}>
                        Asientos seleccionados: [{selectedSeatsList.join(', ')}]
                    </strong>
                    {myHolds.map(hold => (
                        <div key={hold.holdId} style={{ marginBottom:'8px', fontSize:'14px', color:'#000' }}>
                            <span>Asiento #{hold.asiento}</span>
                            <HoldTimer expiresAt={hold.expiresAt} remainingMs={hold.remainingMs}
                                onExpire={() => handleTimerExpire(hold.holdId)} />
                        </div>
                    ))}
                </div>
            )}

            {myHolds.length > 0 && pricingInfo?.ok && (
                <div className="pricing-panel" style={{ marginBottom:'15px', padding:'15px', background:'#f8f9fa', borderRadius:'8px', border:'1px solid #dee2e6' }}>
                    <h4 style={{ margin:'0 0 10px 0', fontSize:'16px', fontWeight:'600', color:'#000' }}>
                        💰 Resumen de Precio {pricingInfo._isFallback && <span style={{ color:'#999', fontSize:'12px' }}>(local)</span>}
                    </h4>
                    <div style={{ display:'flex', flexDirection:'column', gap:'8px', fontSize:'14px', color:'#000' }}>
                        <div style={{ display:'flex', justifyContent:'space-between' }}><span>Precio Unitario:</span><strong>${pricingInfo.precioBase?.toLocaleString()}</strong></div>
                        <div style={{ display:'flex', justifyContent:'space-between' }}><span>Cantidad:</span><strong>{pricingInfo.cantidadAsientos}</strong></div>
                        <div style={{ display:'flex', justifyContent:'space-between' }}><span>Subtotal:</span><strong>${pricingInfo.precioBaseTotal?.toLocaleString()}</strong></div>
                        {pricingInfo.porcentajeDescuento > 0 && (
                            <div style={{ display:'flex', justifyContent:'space-between', color:'#28a745' }}>
                                <span>Descuento ({pricingInfo.porcentajeDescuento}%):</span>
                                <strong>-${pricingInfo.descuentoTotal?.toLocaleString()}</strong>
                            </div>
                        )}
                        <div style={{ display:'flex', justifyContent:'space-between', marginTop:'8px', paddingTop:'8px', borderTop:'2px solid #dee2e6', fontSize:'18px', fontWeight:'bold' }}>
                            <span>Total a Pagar:</span>
                            <strong style={{ color:'#11998e' }}>${pricingInfo.totalPagar?.toLocaleString()}</strong>
                        </div>
                        {pricingInfo.ahorros > 0 && (
                            <div style={{ textAlign:'center', background:'#d4edda', color:'#155724', padding:'8px', borderRadius:'4px', marginTop:'8px', fontWeight:'600' }}>
                                ¡Ahorras ${pricingInfo.ahorros?.toLocaleString()}!
                            </div>
                        )}
                    </div>
                </div>
            )}

            {myHolds.length > 0 && (
                <div className="hold-panel">
                    <div className="hold-actions">
                        <button className="btn btn-confirm" onClick={handleConfirm}
                            disabled={loading || !pricingInfo?.ok || myHolds.some(h => !h.holdId || !h.rutaId || !h.fecha || !h.asiento)}>
                            ✓ Confirmar {myHolds.length} Reserva{myHolds.length > 1 ? 's' : ''}
                        </button>
                        <button className="btn btn-cancel" onClick={handleCancelAll} disabled={loading}>
                            ✕ Cancelar Todo
                        </button>
                    </div>
                </div>
            )}

            <div className="actions-bar">
                <button className="btn btn-refresh" onClick={loadSeats} disabled={loadingMap || loading}>🔄 Refrescar</button>
                <button className="btn btn-refresh" onClick={() => setShowDebug(!showDebug)} style={{ marginLeft:'10px' }}>🔍 Debug API</button>
            </div>

            {showDebug && (
                <div style={{ background:'#1a1a2e', color:'#0f0', padding:'15px', borderRadius:'8px', marginTop:'15px', maxHeight:'400px', overflow:'auto' }}>
                    <div style={{ display:'flex', justifyContent:'space-between', marginBottom:'10px' }}>
                        <strong style={{ color:'#fff' }}>Respuesta /view-model</strong>
                        <button onClick={() => setShowDebug(false)} style={{ background:'#dc3545', color:'#fff', border:'none', padding:'4px 10px', borderRadius:'4px', cursor:'pointer' }}>✕</button>
                    </div>
                    <pre style={{ color:'#0f0', fontSize:'12px', whiteSpace:'pre-wrap', wordBreak:'break-all' }}>
                        {JSON.stringify(apiResponse || {}, null, 2)}
                    </pre>
                </div>
            )}
        </div>
    );
};

export default BusSeatSelector;
