/** Posición de los colectivos del área metropolitana, del prototipo del VMT (ver @rc/core/vmt). */
import { listBusRoutes } from "@rc/core/bus-routes";
import { vmt, type VmtBus, type VmtCompany } from "@rc/core/vmt";
import { createHash } from "node:crypto";

// Un bus que no reportó en este tiempo está apagado o fuera de servicio.
const STALE_MS = 2 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const BUSES_TTL_MS = 10 * 1000;
// Recorrido de un bus que todavía no tiene uno asignado.
const NO_ROUTE = "0000";
// Igual que en el cliente (lib/client/bus-heading.ts): por debajo de esto el bus está detenido y el rumbo calculado es ruido.
const MIN_MOVE_M = 15;

/** Un bus y la empresa por la que se lo pidió (el prototipo identifica los recorridos por empresa). */
export type CompanyBus = VmtBus & { company_code: number };

export interface BusFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: {
    id: number; line: string | null; company: string; companyCode: number; route: string | null;
    ramp: boolean; speed: number; at: string;
    /** Rumbo en grados desde el norte, solo si el bus se movió desde su reporte anterior. */
    heading?: number;
  };
}

/**
 * Memoriza `load(key)` durante `ttl` ms. Pedidos simultáneos comparten la misma promesa (un solo pedido al VMT
 * por instancia, por más usuarios que miren el mapa) y una falla no queda guardada.
 */
export function cached<K, T>(ttl: number, load: (key: K) => Promise<T>): (key: K) => Promise<T> {
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

/**
 * El `rumbo` del VMT no sirve (en una muestra de 139 buses en marcha, 52 desviados más de 45°), pero su
 * `rumbo_calculado`, la dirección entre el reporte anterior y el actual, coincidió en todos. Con el bus detenido
 * viene en 0 o es ruido del GPS.
 */
function heading(b: CompanyBus): number | undefined {
  const moved = b.punto_anterior != null && (b.distancia_entre_puntos_m ?? 0) >= MIN_MOVE_M;
  return moved && typeof b.rumbo_calculado === "number" && Number.isFinite(b.rumbo_calculado) ? b.rumbo_calculado : undefined;
}

export function toFeature(b: CompanyBus): BusFeature {
  const h = heading(b);
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [b.longitude, b.latitude] },
    properties: {
      id: b.id_bus, line: b.linea_label, company: b.eot_nombre, companyCode: b.company_code,
      route: b.route_id && b.route_id !== NO_ROUTE ? b.route_id : null, ramp: b.tiene_rampa === true,
      speed: b.velocidad, at: new Date(b.fecha_hora).toISOString(), ...(h === undefined ? {} : { heading: h }),
    },
  };
}

/** Buses que reportaron hace poco, con coordenadas válidas. Un bus repetido entre empresas queda con su último reporte. */
export function liveBuses(rows: CompanyBus[], now = Date.now()): BusFeature[] {
  const latest = new Map<number, CompanyBus>();
  for (const b of rows) {
    // Una fecha que no se entiende no es un reporte reciente (`now - NaN > STALE_MS` daría falso).
    const at = Date.parse(b.fecha_hora);
    if (!Number.isFinite(b.latitude) || !Number.isFinite(b.longitude) || !Number.isFinite(at) || now - at > STALE_MS) continue;
    const prev = latest.get(b.id_bus);
    if (!prev || at > Date.parse(prev.fecha_hora)) latest.set(b.id_bus, b);
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

/**
 * Catálogo de todos los recorridos (ver @rc/core/bus-catalog), armado una vez por hora por instancia: la consulta
 * simplifica 240 mil vértices. `version` cambia cuando cambia cualquier recorrido.
 */
const catalog = cached(HOUR_MS, async () => {
  const features = await listBusRoutes();
  const version = createHash("sha256").update(JSON.stringify(features)).digest("base64url").slice(0, 12);
  return { body: JSON.stringify({ type: "FeatureCollection", version, features }), etag: `"${version}"` };
});
export const routesCatalog = () => catalog(null);
