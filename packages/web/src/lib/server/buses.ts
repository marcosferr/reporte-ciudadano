/**
 * Posición de los colectivos del área metropolitana, del prototipo del VMT (MOPC). No es un dato abierto
 * oficial: no tiene licencia ni garantía de que siga igual, así que todo lo que depende de su formato está acá.
 * Los buses reportan su GPS cada ~10 s.
 */
const VMT_API = "https://sistemas.mopc.gov.py/prototipo_vmt/api";
const TIMEOUT_MS = 5000;
// Los recorridos de una empresa grande pesan cientos de KB y el prototipo tarda varios segundos en armarlos.
// Por debajo de los 20 s de la Lambda (infra/web.ts): si no, la corta antes y no llega el 502.
const ITINERARIES_TIMEOUT_MS = 15_000;
// Un bus que no reportó en este tiempo está apagado o fuera de servicio.
const STALE_MS = 2 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const BUSES_TTL_MS = 10 * 1000;
// Recorrido de un bus que todavía no tiene uno asignado.
const NO_ROUTE = "0000";

interface VmtCompany { cod_catalogo: number }
// `linea_label` viene vacío cuando el bus no tiene un recorrido asignado (route_id "0000").
interface VmtBus {
  id_bus: number; latitude: number; longitude: number; rumbo: number; velocidad: number;
  fecha_hora: string; linea_label: string | null; eot_nombre: string; route_id: string; tiene_rampa: boolean;
}
interface VmtItinerary {
  ruta_hex: string; ruta_linea: string; sentido: string; origen: string; destino: string;
  geojson: { type: "MultiLineString"; coordinates: [number, number][][] } | { type: "LineString"; coordinates: [number, number][] };
}
/** Un bus y la empresa por la que se lo pidió (el prototipo identifica los recorridos por empresa). */
export type CompanyBus = VmtBus & { company_code: number };

export interface BusFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: {
    id: number; line: string | null; company: string; companyCode: number; route: string | null;
    ramp: boolean; bearing: number; speed: number; at: string;
  };
}

export interface RouteFeature {
  type: "Feature";
  geometry: VmtItinerary["geojson"];
  properties: { line: string; direction: string; from: string; to: string };
}

async function vmt<T>(path: string, timeout = TIMEOUT_MS): Promise<T[]> {
  const res = await fetch(`${VMT_API}${path}`, { signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`VMT ${path}: HTTP ${res.status}`);
  const body = (await res.json()) as { success: boolean; data: T[] };
  if (!body.success || !Array.isArray(body.data)) throw new Error(`VMT ${path}: respuesta inesperada`);
  return body.data;
}

/**
 * Memoriza `load(key)` durante `ttl` ms. Pedidos simultáneos comparten la misma promesa (un solo pedido al VMT
 * por instancia, por más usuarios que miren el mapa) y una falla no queda guardada.
 */
function cached<K, T>(ttl: number, load: (key: K) => Promise<T>): (key: K) => Promise<T> {
  const entries = new Map<K, { at: number; value: Promise<T> }>();
  return (key) => {
    const hit = entries.get(key);
    if (hit && Date.now() - hit.at <= ttl) return hit.value;
    const value = load(key);
    const entry = { at: Date.now(), value };
    entries.set(key, entry);
    value.catch(() => entries.get(key) === entry && entries.delete(key));
    return value;
  };
}

// La lista de empresas casi no cambia. El prototipo solo devuelve buses de a una empresa por pedido.
const companyCodes = cached(HOUR_MS, async () => (await vmt<VmtCompany>("/empresas")).map((r) => r.cod_catalogo));

export function toFeature(b: CompanyBus): BusFeature {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [b.longitude, b.latitude] },
    properties: {
      id: b.id_bus, line: b.linea_label, company: b.eot_nombre, companyCode: b.company_code,
      route: b.route_id && b.route_id !== NO_ROUTE ? b.route_id : null, ramp: b.tiene_rampa === true,
      bearing: b.rumbo, speed: b.velocidad, at: b.fecha_hora,
    },
  };
}

/** Buses que reportaron hace poco, con coordenadas válidas. Un bus repetido entre empresas queda con su último reporte. */
export function liveBuses(rows: CompanyBus[], now = Date.now()): BusFeature[] {
  const latest = new Map<number, CompanyBus>();
  for (const b of rows) {
    if (!Number.isFinite(b.latitude) || !Number.isFinite(b.longitude) || now - Date.parse(b.fecha_hora) > STALE_MS) continue;
    const prev = latest.get(b.id_bus);
    if (!prev || Date.parse(b.fecha_hora) > Date.parse(prev.fecha_hora)) latest.set(b.id_bus, b);
  }
  return [...latest.values()].map(toFeature);
}

async function fetchBuses(): Promise<BusFeature[]> {
  const codes = await companyCodes(null);
  const results = await Promise.allSettled(
    codes.map(async (c) => (await vmt<VmtBus>(`/buses?cod_catalogo=${c}`)).map((b): CompanyBus => ({ ...b, company_code: c }))),
  );
  const ok = results.filter((r): r is PromiseFulfilledResult<CompanyBus[]> => r.status === "fulfilled");
  // Si cae una empresa se muestran las demás; si caen todas, el prototipo no está respondiendo.
  if (!ok.length && codes.length) throw (results[0] as PromiseRejectedResult).reason;
  return liveBuses(ok.flatMap((r) => r.value));
}

const buses = cached(BUSES_TTL_MS, fetchBuses);
export const currentBuses = () => buses(null);

// Los recorridos de una empresa (ida, vuelta y ramales) cambian muy de vez en cuando.
const itineraries = cached(HOUR_MS, (code: number) => vmt<VmtItinerary>(`/itinerarios?cod_catalogo=${code}`, ITINERARIES_TIMEOUT_MS));

/**
 * Recorrido completo de un bus: su `route` es el `ruta_hex` de uno de los itinerarios de su empresa. Una empresa
 * que no existe no llega al VMT (ni ocupa lugar en la caché de itinerarios).
 */
export async function busRoute(companyCode: number, route: string): Promise<RouteFeature | null> {
  if (!(await companyCodes(null)).includes(companyCode)) return null;
  const it = (await itineraries(companyCode)).find((i) => i.ruta_hex.toLowerCase() === route.toLowerCase());
  if (!it) return null;
  return {
    type: "Feature",
    geometry: it.geojson,
    properties: { line: it.ruta_linea, direction: it.sentido, from: it.origen, to: it.destino },
  };
}
