/**
 * Geometría plana para las distancias del área metropolitana. Es puro (no toca la base): lo usan el navegador
 * (flechas de rumbo de los colectivos, ¿Cuándo salgo?) y los scripts de backtesting.
 *
 * En unas decenas de km alcanza con aproximar la Tierra como plana: con un solo marco centrado en el área
 * metropolitana el error de escala queda por debajo del 0,5 %, unos metros en el recorrido que le falta a un bus.
 */
export type LngLat = [number, number];

export const M_PER_DEG = 111_320;
// Inicio y fin de un recorrido más cerca que esto: es un circular.
export const LOOP_CLOSE_M = 300;
// La simplificación del catálogo a 5 decimales deja vértices repetidos o pegados.
const DEDUPE_M = 0.5;

function delta([x1, y1]: LngLat, [x2, y2]: LngLat) {
  return { dx: (x2 - x1) * Math.cos((y1 * Math.PI) / 180), dy: y2 - y1 };
}

export function distanceM(a: LngLat, b: LngLat): number {
  const { dx, dy } = delta(a, b);
  return Math.hypot(dx, dy) * M_PER_DEG;
}

/** Rumbo de `a` hacia `b` en grados desde el norte, en [0, 360). */
export function bearing(a: LngLat, b: LngLat): number {
  const { dx, dy } = delta(a, b);
  return xyBearing(dx, dy);
}

/** Diferencia entre dos rumbos, en [0, 180]. */
export function angleDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function xyBearing(dx: number, dy: number): number {
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}

/** Proyección equirectangular con origen en `lng0, lat0`, en metros. */
export interface Frame { lng0: number; lat0: number; kx: number; ky: number }

export function makeFrame([lng0, lat0]: LngLat): Frame {
  return { lng0, lat0, kx: M_PER_DEG * Math.cos((lat0 * Math.PI) / 180), ky: M_PER_DEG };
}

export function toXY(f: Frame, [lng, lat]: LngLat): [number, number] {
  return [(lng - f.lng0) * f.kx, (lat - f.lat0) * f.ky];
}

export function toLngLat(f: Frame, [x, y]: [number, number]): LngLat {
  return [x / f.kx + f.lng0, y / f.ky + f.lat0];
}

/**
 * Una línea en metros con su largo acumulado en cada vértice (`cum`): la posición de un punto sobre la línea es
 * su `s`, los metros desde el inicio. Los vértices van en el sentido de viaje del colectivo.
 */
export interface Polyline {
  xs: Float64Array; ys: Float64Array; cum: Float64Array;
  length: number;
  bbox: [number, number, number, number];
  /** Recorrido circular: termina donde empieza, y la `s` da la vuelta. */
  closed: boolean;
}

/** Arma la línea. Las partes de un MultiLineString se unen en orden con un tramo recto (hoy el VMT no manda ninguno). */
export function preparePolyline(f: Frame, coords: LngLat[] | LngLat[][], loopCloseM = LOOP_CLOSE_M): Polyline {
  const parts = (typeof coords[0]?.[0] === "number" ? [coords] : coords) as LngLat[][];
  const xs: number[] = [], ys: number[] = [];
  for (const part of parts) {
    for (const p of part) {
      const [x, y] = toXY(f, p);
      const n = xs.length;
      if (n && Math.hypot(x - xs[n - 1], y - ys[n - 1]) < DEDUPE_M) continue;
      xs.push(x);
      ys.push(y);
    }
  }
  // Un circular que termina cerca de donde empieza se cierra con un tramo recto: si no, entre el final y el
  // principio faltarían esos metros (hasta 300) y la posición saltaría de golpe.
  let open = 0;
  for (let i = 1; i < xs.length; i++) open += Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
  const gap = xs.length > 2 ? Math.hypot(xs.at(-1)! - xs[0], ys.at(-1)! - ys[0]) : Infinity;
  const loops = gap <= loopCloseM && open > 2 * loopCloseM;
  if (loops && gap >= DEDUPE_M) {
    xs.push(xs[0]);
    ys.push(ys[0]);
  }
  // Una línea de un solo punto queda como un tramo de largo cero, para que proyectar sobre ella no falle.
  if (xs.length === 1) {
    xs.push(xs[0]);
    ys.push(ys[0]);
  }
  const n = xs.length;
  const cum = new Float64Array(n);
  const bbox: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    if (i) cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
    bbox[0] = Math.min(bbox[0], xs[i]);
    bbox[1] = Math.min(bbox[1], ys[i]);
    bbox[2] = Math.max(bbox[2], xs[i]);
    bbox[3] = Math.max(bbox[3], ys[i]);
  }
  const length = n ? cum[n - 1] : 0;
  const closed = loops;
  return { xs: Float64Array.from(xs), ys: Float64Array.from(ys), cum, length, bbox, closed };
}

/** Dónde cae un punto sobre la línea: `s` desde el inicio y a cuántos metros de la línea está. */
export interface Projection { s: number; offsetM: number; seg: number }

function projectSeg(line: Polyline, i: number, x: number, y: number): Projection {
  const { xs, ys, cum } = line;
  const dx = xs[i + 1] - xs[i], dy = ys[i + 1] - ys[i];
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.min(1, Math.max(0, ((x - xs[i]) * dx + (y - ys[i]) * dy) / len2)) : 0;
  const qx = xs[i] + t * dx, qy = ys[i] + t * dy;
  return { s: cum[i] + t * (cum[i + 1] - cum[i]), offsetM: Math.hypot(x - qx, y - qy), seg: i };
}

/** El punto de la línea más cercano. */
export function project(line: Polyline, x: number, y: number): Projection {
  let best = projectSeg(line, 0, x, y);
  for (let i = 1; i < line.xs.length - 1; i++) {
    const p = projectSeg(line, i, x, y);
    if (p.offsetM < best.offsetM) best = p;
  }
  return best;
}

export function inBBox(line: Polyline, x: number, y: number, marginM: number): boolean {
  const [x0, y0, x1, y1] = line.bbox;
  return x >= x0 - marginM && x <= x1 + marginM && y >= y0 - marginM && y <= y1 + marginM;
}

/**
 * Cada vez que la línea pasa a menos de `radiusM` del punto, el lugar más cercano de esa pasada. Un circular que
 * va y vuelve por la misma calle pasa dos veces (a km de distancia sobre la línea).
 * - Histéresis: una línea que zigzaguea justo en el borde del radio no parte la pasada en varias.
 * - Mínimos a menos de `mergeArcM` sobre la línea son la misma pasada (una rotonda o un retorno frente al punto).
 * - En un circular, la pasada que cruza el inicio de la línea es una sola.
 */
export function nearProjections(
  line: Polyline, x: number, y: number, radiusM: number,
  { hysteresisM = 15, mergeArcM = 200 }: { hysteresisM?: number; mergeArcM?: number } = {},
): Projection[] {
  if (!inBBox(line, x, y, radiusM + hysteresisM)) return [];
  const runs: Projection[] = [];
  let best: Projection | undefined;
  for (let i = 0; i < line.xs.length - 1; i++) {
    const p = projectSeg(line, i, x, y);
    if (p.offsetM <= (best ? radiusM + hysteresisM : radiusM)) {
      if (!best || p.offsetM < best.offsetM) best = p;
    } else if (best) {
      runs.push(best);
      best = undefined;
    }
  }
  if (best) runs.push(best);
  const merged: Projection[] = [];
  for (const r of runs) {
    const last = merged.at(-1);
    if (last && r.s - last.s <= mergeArcM) {
      if (r.offsetM < last.offsetM) merged[merged.length - 1] = r;
    } else merged.push(r);
  }
  if (line.closed && merged.length > 1) {
    const first = merged[0], last = merged.at(-1)!;
    if (line.length - last.s + first.s <= mergeArcM) {
      if (last.offsetM < first.offsetM) merged[0] = last;
      merged.pop();
    }
  }
  return merged;
}

/** En un circular, `s` fuera de [0, largo] da la vuelta; si no, se recorta a los extremos. */
export function normS(line: Polyline, s: number): number {
  if (line.closed && line.length > 0) return ((s % line.length) + line.length) % line.length;
  return Math.min(line.length, Math.max(0, s));
}

export function pointAt(line: Polyline, s: number): [number, number] {
  const { xs, ys, cum } = line;
  const v = normS(line, s);
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= v) lo = mid;
    else hi = mid;
  }
  const seg = cum[hi] - cum[lo];
  const t = seg > 0 ? (v - cum[lo]) / seg : 0;
  return [xs[lo] + t * (xs[hi] - xs[lo]), ys[lo] + t * (ys[hi] - ys[lo])];
}

/** Rumbo de la línea en `s`, mirando `halfWindowM` para cada lado (estable frente a zigzags cortos). */
export function bearingAt(line: Polyline, s: number, halfWindowM = 15): number {
  const [ax, ay] = pointAt(line, s - halfWindowM);
  const [bx, by] = pointAt(line, s + halfWindowM);
  return xyBearing(bx - ax, by - ay);
}

/**
 * Metros sobre la línea de `from` a `to`: negativo si `to` quedó atrás. En un circular, el camino más corto
 * dando la vuelta si hace falta.
 */
export function signedArc(line: Polyline, from: number, to: number): number {
  const d = to - from;
  if (!line.closed || !line.length) return d;
  if (d > line.length / 2) return d - line.length;
  if (d < -line.length / 2) return d + line.length;
  return d;
}

/** Metros hacia adelante de `from` a `to`; en un circular siempre se llega dando la vuelta. */
export function forwardArc(line: Polyline, from: number, to: number): number {
  const d = to - from;
  if (!line.closed || !line.length) return d;
  return ((d % line.length) + line.length) % line.length;
}
