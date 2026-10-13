/**
 * Recorridos de los colectivos, guardados en la base. El VMT tarda segundos en armar los de una empresa y
 * cambian muy de vez en cuando, así que se traen una vez por día (Lambda BusRoutesSync) y el mapa los lee de acá.
 */
import type { CatalogFeature } from "./bus-catalog";
import { sql } from "./db";
import { vmt, vmtTry, type VmtCompany, type VmtItinerary } from "./vmt";

// Los recorridos de una empresa grande pesan cientos de KB y el prototipo llega a tardar más de 15 s en armarlos.
const ITINERARIES_TIMEOUT_MS = 60_000;
// Empresas pedidas a la vez: rápido sin cargar al prototipo con las 34 juntas.
const CONCURRENCY = 4;
// Simplificación del catálogo que se baja al teléfono (~3 m): de 240 mil vértices a 44 mil, ~130 KB con gzip.
export const CATALOG_TOLERANCE_DEG = 0.00003;

export interface BusRoute {
  type: "Feature";
  geometry: { type: "MultiLineString"; coordinates: [number, number][][] };
  properties: { line: string | null; direction: string | null; from: string | null; to: string | null };
}

/** Respuesta cruda de `/itinerarios` por empresa, para el historial de recorridos (ver vmt-history.ts). */
export interface ItinerariesSnapshot {
  synced_at: string;
  companies: { code: number; status: number | null; latency_ms: number; error?: string; itineraries?: unknown[] }[];
}

export interface SyncOptions {
  /** No empieza a pedir empresas después de este instante (ms epoch); las que quedan conservan sus recorridos. */
  deadline?: number;
}

/** Un itinerario sirve para dibujar el recorrido de un bus si tiene ruta, está vigente y su trazado es una línea. */
function drawable(i: VmtItinerary): boolean {
  if (!i.ruta_hex || i.vigente === false || !i.geojson) return false;
  const g = i.geojson;
  if (g.type === "LineString") return Array.isArray(g.coordinates) && g.coordinates.length >= 2;
  if (g.type === "MultiLineString") return Array.isArray(g.coordinates) && g.coordinates.length > 0 && g.coordinates.every((l) => Array.isArray(l) && l.length >= 2);
  return false;
}

/**
 * Reemplaza los recorridos guardados por los del VMT. Una empresa que falla, que vuelve sin recorridos o que no se
 * llegó a pedir antes de `deadline` conserva los que ya tenía; una que el VMT ya no lista se borra.
 */
export async function syncBusRoutes(opts: SyncOptions = {}): Promise<{ routes: number; failed: number[]; skipped: number[]; snapshot: ItinerariesSnapshot }> {
  const syncedAt = new Date().toISOString();
  const codes = (await vmt<VmtCompany>("/empresas")).map((c) => c.cod_catalogo);
  const fetched = new Map<number, VmtItinerary[]>();
  const failed: number[] = [];
  const skipped: number[] = [];
  const snapshot: ItinerariesSnapshot = { synced_at: syncedAt, companies: [] };

  const queue = [...codes];
  async function worker() {
    for (let code = queue.shift(); code !== undefined; code = queue.shift()) {
      if (opts.deadline && Date.now() > opts.deadline) {
        skipped.push(code);
        continue;
      }
      const r = await vmtTry<VmtItinerary>(`/itinerarios?cod_catalogo=${code}`, ITINERARIES_TIMEOUT_MS);
      snapshot.companies.push({ code, status: r.status, latency_ms: r.latencyMs, error: r.error, itineraries: r.data });
      if (!r.data) {
        console.error(r.error);
        failed.push(code);
        continue;
      }
      const itineraries = r.data.filter(drawable);
      if (itineraries.length) fetched.set(code, itineraries);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (!fetched.size) throw new Error(`VMT: no llegó ningún recorrido de las ${codes.length} empresas`);

  let routes = 0;
  await sql().begin(async (tx) => {
    await tx`DELETE FROM bus_routes WHERE company_code NOT IN ${tx(codes)}`;
    for (const [code, itineraries] of fetched) {
      await tx`DELETE FROM bus_routes WHERE company_code = ${code}`;
      // Solo lo que se guarda: el VMT manda además la vigencia, observaciones, etc.
      const rows = itineraries.map(({ ruta_hex, ruta_linea, sentido, origen, destino, eot_nombre, geojson }) => ({ ruta_hex, ruta_linea, sentido, origen, destino, eot_nombre: eot_nombre ?? null, geojson }));
      // Si el VMT repite un ruta_hex en la misma empresa queda el primero.
      const inserted = await tx`
        INSERT INTO bus_routes (company_code, route_hex, line, direction, origin, destination, company_name, geom)
        SELECT ${code}, lower(r.ruta_hex), r.ruta_linea, r.sentido, r.origen, r.destino, r.eot_nombre,
          ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(r.geojson), 4326))
        FROM jsonb_to_recordset(${tx.json(rows)})
          AS r(ruta_hex text, ruta_linea text, sentido text, origen text, destino text, eot_nombre text, geojson text)
        ON CONFLICT DO NOTHING`;
      routes += inserted.count;
    }
  });
  failed.sort((a, b) => a - b);
  skipped.sort((a, b) => a - b);
  snapshot.companies.sort((a, b) => a.code - b.code);
  return { routes, failed, skipped, snapshot };
}

/** Carga los recorridos solo si la tabla está vacía (primer deploy). */
export async function syncBusRoutesIfEmpty(opts: SyncOptions = {}): Promise<boolean> {
  const [{ n }] = await sql()<{ n: number }[]>`SELECT count(*)::int AS n FROM bus_routes`;
  if (n > 0) return false;
  await syncBusRoutes(opts);
  return true;
}

/** Recorrido de un bus: su `route` es el `ruta_hex` de uno de los itinerarios de su empresa. */
export async function getBusRoute(companyCode: number, route: string): Promise<BusRoute | null> {
  const [row] = await sql()<{ geometry: BusRoute["geometry"]; line: string | null; direction: string | null; origin: string | null; destination: string | null }[]>`
    SELECT ST_AsGeoJSON(geom, 6)::json AS geometry, line, direction, origin, destination
    FROM bus_routes WHERE company_code = ${companyCode} AND route_hex = ${route.toLowerCase()}`;
  if (!row) return null;
  return {
    type: "Feature",
    geometry: row.geometry,
    properties: { line: row.line, direction: row.direction, from: row.origin, to: row.destination },
  };
}

/**
 * Todos los recorridos, simplificados, para el catálogo que se baja entero al teléfono (/api/buses/routes): así
 * nunca se pide uno en particular y el servidor no sabe qué línea le interesa a nadie. Un recorrido de una sola
 * parte va como LineString. `ST_LineMerge` no se usa: puede dar vuelta el orden de los vértices, que es el sentido
 * de viaje.
 */
export async function listBusRoutes(): Promise<CatalogFeature[]> {
  const rows = await sql()<{ company_code: number; route_hex: string; company_name: string | null; line: string | null; direction: string | null; origin: string | null; destination: string | null; geometry: CatalogFeature["geometry"] }[]>`
    SELECT company_code, route_hex, company_name, line, direction, origin, destination,
      ST_AsGeoJSON(CASE WHEN ST_NumGeometries(g) = 1 THEN ST_GeometryN(g, 1) ELSE g END, 5)::json AS geometry
    FROM (SELECT *, ST_Simplify(geom, ${CATALOG_TOLERANCE_DEG}, true) AS g FROM bus_routes) r
    ORDER BY company_code, route_hex`;
  return rows.map((r) => ({
    type: "Feature",
    geometry: r.geometry,
    properties: {
      company: r.company_code, companyName: r.company_name, route: r.route_hex,
      line: r.line, direction: r.direction, from: r.origin, to: r.destination,
    },
  }));
}
