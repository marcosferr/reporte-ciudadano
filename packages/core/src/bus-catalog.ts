/**
 * Catálogo de recorridos para calcular en el dispositivo (¿Cuándo salgo?) y en el backtesting. Es puro: el
 * servidor lo arma con `listBusRoutes` (bus-routes.ts) y el teléfono lo baja entero, así nunca dice qué línea ni
 * qué parada le interesa a nadie.
 *
 * Una parada no es un dato del VMT: la marca el usuario. Acá se calcula por dónde pasan los recorridos cerca de
 * ella ("pasadas") y qué líneas le sirven.
 */
import { angleDiff, bearingAt, inBBox, makeFrame, nearProjections, preparePolyline, toXY, type Frame, type LngLat, type Polyline } from "./geo";

export interface CatalogProps {
  company: number; companyName: string | null; route: string;
  line: string | null; direction: string | null; from: string | null; to: string | null;
}
export interface CatalogFeature {
  type: "Feature";
  geometry: { type: "LineString"; coordinates: LngLat[] } | { type: "MultiLineString"; coordinates: LngLat[][] };
  properties: CatalogProps;
}
/** Lo que devuelve /api/buses/routes. `version` cambia cuando cambia cualquier recorrido. */
export interface CatalogFile { type: "FeatureCollection"; version: string; features: CatalogFeature[] }

/** Un recorrido se identifica por empresa y `ruta_hex` (el `route` de cada bus en /api/buses). */
export type RouteKey = string;
export const routeKey = (companyCode: number, route: string): RouteKey => `${companyCode}:${route.toLowerCase()}`;

export interface CatalogRoute {
  key: RouteKey; companyCode: number; companyName: string | null; route: string;
  line: string | null; direction: string | null; from: string | null; to: string | null;
  coords: LngLat[] | LngLat[][];
  path: Polyline;
}
export interface Catalog { version: string; frame: Frame; routes: Map<RouteKey, CatalogRoute> }

export const STOP_CFG = {
  // Un recorrido a esta distancia de la parada pasa por ella (el trazado del VMT no siempre va por el medio de la calle).
  STOP_RADIUS_M: 50,
  // Si no pasa ninguno, se buscan los más cercanos para decir a cuántos metros están.
  WIDE_RADIUS_M: 150,
  // Pasar por la parada en los últimos metros de un recorrido es llegar a la terminal: ahí no se sube nadie.
  END_EXCLUDE_M: 150,
  // Pasadas de una misma línea con rumbos más parecidos que esto van para el mismo lado.
  SAME_WAY_DEG: 60,
  // Al rearmar un viaje se busca un poco más lejos: el trazado de un recorrido se puede correr unos metros.
  RECONCILE_EXTRA_M: 20,
};

export function buildCatalog(file: CatalogFile): Catalog {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const each = (f: CatalogFeature, fn: (p: LngLat) => void) =>
    f.geometry.type === "LineString" ? f.geometry.coordinates.forEach(fn) : f.geometry.coordinates.forEach((l) => l.forEach(fn));
  for (const f of file.features) {
    each(f, ([x, y]) => {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    });
  }
  // Sin recorridos el marco no importa: centro de Asunción.
  const frame = makeFrame(Number.isFinite(x0) ? [(x0 + x1) / 2, (y0 + y1) / 2] : [-57.6, -25.3]);
  const routes = new Map<RouteKey, CatalogRoute>();
  for (const f of file.features) {
    const p = f.properties;
    const key = routeKey(p.company, p.route);
    if (routes.has(key)) continue;
    const coords = f.geometry.coordinates;
    routes.set(key, {
      // El VMT a veces manda la línea vacía en lugar de null.
      key, companyCode: p.company, companyName: p.companyName?.trim() || null, route: p.route.toLowerCase(),
      line: p.line?.trim() || null, direction: p.direction, from: p.from, to: p.to,
      coords, path: preparePolyline(frame, coords),
    });
  }
  return { version: file.version, frame, routes };
}

/** "ASUNCIÓN", "Asuncion " y "asunción" son el mismo lugar. */
export function normPlace(s: string | null | undefined): string {
  return (s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toUpperCase().replace(/\s+/g, " ").trim();
}

/** "41 - 1", "41-1" y " 41 " son la línea 41. */
export function normLine(s: string | null | undefined): string {
  return normPlace(s).split(/\s*-\s*/)[0];
}

/** Por dónde pasa un recorrido cerca de la parada. `s`: metros desde el inicio del recorrido. */
export interface Pass { key: RouteKey; s: number; bearing: number; offsetM: number }

export function passesNear(catalog: Catalog, stop: LngLat, radiusM = STOP_CFG.STOP_RADIUS_M): (Pass & { route: CatalogRoute })[] {
  const [x, y] = toXY(catalog.frame, stop);
  const out: (Pass & { route: CatalogRoute })[] = [];
  for (const route of catalog.routes.values()) {
    const path = route.path;
    if (!inBBox(path, x, y, radiusM)) continue;
    for (const p of nearProjections(path, x, y, radiusM)) {
      if (!path.closed && p.s > path.length - STOP_CFG.END_EXCLUDE_M) continue;
      out.push({ key: route.key, s: p.s, bearing: bearingAt(path, p.s), offsetM: p.offsetM, route });
    }
  }
  return out;
}

/** Una opción de "¿qué líneas te sirven acá?": una línea hacia un destino, con todas sus variantes. */
export interface StopOption {
  id: string; companyCode: number; companyName: string | null; line: string | null;
  /** Destino tal como lo escribe el VMT ("ASUNCIÓN"). */
  destination: string | null;
  bearing: number;
  routes: Pass[];
  minOffsetM: number;
  /** Solo para recorridos sin línea: no hay otra forma de agruparlos. */
  route?: string;
}

/** Lo que el usuario eligió de una opción. Las pasadas se rearman desde acá cuando cambia el catálogo. */
export interface LineChoice {
  companyCode: number; line: string | null; route?: string;
  /** Destino normalizado (`normPlace`). */
  destination: string;
  bearing: number;
}

function meanBearing(bearings: number[]): number {
  let sx = 0, sy = 0;
  for (const b of bearings) {
    sx += Math.sin((b * Math.PI) / 180);
    sy += Math.cos((b * Math.PI) / 180);
  }
  return ((Math.atan2(sx, sy) * 180) / Math.PI + 360) % 360;
}

// Por número de línea; las que no tienen, al final (en `localeCompare` cualquier signo va antes que los números).
const lineOrder = (a: string | null, b: string | null) => (a === null ? (b === null ? 0 : 1) : b === null ? -1 : a.localeCompare(b, "es", { numeric: true }));

/**
 * Las líneas que pasan por la parada, agrupadas por empresa, línea, destino y sentido: las 15 variantes del 38 hacia
 * Asunción son una sola opción. Una línea que pasa por las dos manos de la calle da dos opciones.
 */
export function stopOptions(catalog: Catalog, stop: LngLat, radiusM = STOP_CFG.STOP_RADIUS_M): StopOption[] {
  const groups = new Map<string, (Pass & { route: CatalogRoute })[][]>();
  for (const p of passesNear(catalog, stop, radiusM)) {
    const r = p.route;
    const g = r.line ? `${r.companyCode}|${normLine(r.line)}|${normPlace(r.to)}` : `${r.companyCode}|#${r.route}`;
    const clusters = groups.get(g) ?? [];
    const same = clusters.find((c) => angleDiff(c[0].bearing, p.bearing) <= STOP_CFG.SAME_WAY_DEG);
    if (same) same.push(p);
    else clusters.push([p]);
    groups.set(g, clusters);
  }
  const options: StopOption[] = [];
  for (const [g, clusters] of groups) {
    for (const c of clusters) {
      const r = c[0].route;
      const bearing = meanBearing(c.map((p) => p.bearing));
      options.push({
        id: `${g}|${Math.round(bearing)}`, companyCode: r.companyCode, companyName: r.companyName, line: r.line,
        destination: r.to, bearing, minOffsetM: Math.min(...c.map((p) => p.offsetM)),
        routes: c.map(({ key, s, bearing, offsetM }) => ({ key, s, bearing, offsetM })),
        ...(r.line ? {} : { route: r.route }),
      });
    }
  }
  return options.sort((a, b) => lineOrder(a.line, b.line) || a.minOffsetM - b.minOffsetM);
}

export function choiceOf(o: StopOption): LineChoice {
  return { companyCode: o.companyCode, line: o.line, destination: normPlace(o.destination), bearing: o.bearing, ...(o.route ? { route: o.route } : {}) };
}

/**
 * Las pasadas de lo elegido según el catálogo de ahora: toma variantes nuevas de la misma línea, el mismo sentido y
 * el mismo destino, y descarta un `ruta_hex` que el VMT reusó para la otra mano. Un recorrido que ya era del viaje
 * (`known`) sigue aunque el VMT le haya cambiado el nombre al destino.
 */
export function passesFor(catalog: Catalog, stop: LngLat, choices: LineChoice[], radiusM: number, known: ReadonlySet<RouteKey> = new Set()): Pass[] {
  const near = passesNear(catalog, stop, radiusM);
  const out = new Map<string, Pass>();
  for (const c of choices) {
    const found = near.filter((p) =>
      p.route.companyCode === c.companyCode &&
      (c.line ? normLine(p.route.line) === normLine(c.line) : p.route.route === c.route) &&
      angleDiff(p.bearing, c.bearing) <= STOP_CFG.SAME_WAY_DEG &&
      (normPlace(p.route.to) === c.destination || known.has(p.key)));
    for (const { key, s, bearing, offsetM } of found) out.set(`${key}@${Math.round(s)}`, { key, s, bearing, offsetM });
  }
  return [...out.values()].sort((a, b) => a.key.localeCompare(b.key) || a.s - b.s);
}

/** Lo mínimo de un viaje guardado que hace falta para rearmarlo (el resto vive en el teléfono, ver web/lib/client/trips.ts). */
export interface TripPlace { stop: LngLat; choices: LineChoice[]; passes: Pass[]; catalogVersion: string; radiusM: number }

/** Rearma las pasadas de un viaje cuando cambió el catálogo. `lost`: ya no pasa ninguna de sus líneas. */
export function reconcileTrip<T extends TripPlace>(trip: T, catalog: Catalog): { trip: T; status: "same" | "updated" | "lost" } {
  if (trip.catalogVersion === catalog.version && trip.passes.length) return { trip, status: "same" };
  const passes = passesFor(catalog, trip.stop, trip.choices, trip.radiusM + STOP_CFG.RECONCILE_EXTRA_M, new Set(trip.passes.map((p) => p.key)));
  if (!passes.length) return { trip: { ...trip, catalogVersion: catalog.version, passes: [] }, status: "lost" };
  const same = passes.length === trip.passes.length && passes.every((p, i) => p.key === trip.passes[i].key && Math.abs(p.s - trip.passes[i].s) < 1);
  return { trip: { ...trip, catalogVersion: catalog.version, passes }, status: same ? "same" : "updated" };
}

/** Los sentidos en que pasan las líneas por la parada (cada mano de la calle), con sus opciones. */
export function stopDirections(options: StopOption[]): { bearing: number; options: StopOption[] }[] {
  const groups: { bearing: number; options: StopOption[] }[] = [];
  for (const o of options) {
    const g = groups.find((x) => angleDiff(x.bearing, o.bearing) <= STOP_CFG.SAME_WAY_DEG);
    if (g) g.options.push(o);
    else groups.push({ bearing: o.bearing, options: [o] });
  }
  return groups.sort((a, b) => b.options.length - a.options.length);
}
