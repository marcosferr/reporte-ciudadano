/** Hacia dónde va cada colectivo, para la flecha de su ícono en el mapa (ver buses.ts). */

// Un bus que se movió menos que esto entre dos pedidos está detenido o es ruido del GPS.
const MIN_MOVE_M = 15;
const M_PER_DEG = 111_320;

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

// En los pocos metros entre dos reportes alcanza con aproximar la Tierra como plana.
function delta([x1, y1]: [number, number], [x2, y2]: [number, number]) {
  return { dx: (x2 - x1) * Math.cos((y1 * Math.PI) / 180), dy: y2 - y1 };
}

function distanceM(a: [number, number], b: [number, number]): number {
  const { dx, dy } = delta(a, b);
  return Math.hypot(dx, dy) * M_PER_DEG;
}

function bearing(a: [number, number], b: [number, number]): number {
  const { dx, dy } = delta(a, b);
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}
