/** Hacia dónde va cada colectivo, para la flecha de su ícono en el mapa (ver buses.ts). */
import { bearing, distanceM } from "@rc/core/geo";

// Un bus que se movió menos que esto entre dos pedidos está detenido o es ruido del GPS.
const MIN_MOVE_M = 15;

export interface Track { at: [number, number]; heading?: number }

/**
 * Rumbo de cada bus en grados desde el norte. Primero el que manda /api/buses (el `rumbo_calculado` del VMT, si el
 * bus se movió desde su reporte anterior); si no, la dirección en que se movió desde el pedido anterior; si tampoco,
 * el último conocido. Un bus detenido desde que se prendió la capa queda sin rumbo (y sin flecha).
 */
export function trackHeadings(prev: ReadonlyMap<number, Track>, buses: { id: number; at: [number, number]; heading?: number }[]): Map<number, Track> {
  const next = new Map<number, Track>();
  for (const b of buses) {
    const p = prev.get(b.id);
    const moved = p && distanceM(p.at, b.at) >= MIN_MOVE_M ? bearing(p.at, b.at) : undefined;
    next.set(b.id, { at: b.at, heading: b.heading ?? moved ?? p?.heading });
  }
  return next;
}
