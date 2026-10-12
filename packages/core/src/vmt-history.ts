/**
 * Histórico del VMT, para medir su disponibilidad y analizar el servicio de colectivos. Todo vive bajo `vmt/`
 * en el bucket Media (privado) y lo escriben tres Lambdas (infra/buses.ts):
 *
 *   vmt/raw/buses/date=AAAA-MM-DD/HHMMSS.json.gz      cada minuto, /buses de todas las empresas (VmtCollector)
 *   vmt/raw/itineraries/date=AAAA-MM-DD.json.gz       una vez por día, /itinerarios de todas (BusRoutesSync)
 *   vmt/positions/date=AAAA-MM-DD/positions.parquet   los reportes del día sin repetir (VmtCompactor)
 *
 * Lo crudo se guarda tal como llega (menos `driver_id`): lo que no se captura hoy no se recupera después. En la
 * base quedan solo resúmenes chicos (`vmt_polls`, `bus_route_activity`). Fechas y horas de las claves son de
 * Paraguay, para que un día de servicio no quede partido entre dos archivos.
 */
import { parquetWriteBuffer } from "hyparquet-writer";
import { sql } from "./db";
import { vmtTry, type VmtBus, type VmtCompany } from "./vmt";

// Paraguay usa UTC-3 todo el año desde octubre de 2024 (Ley 7115).
const PY_OFFSET_MS = -3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// Más que en el mapa (5 s): acá interesa distinguir un VMT lento de uno caído, y la latencia queda registrada.
const POLL_TIMEOUT_MS = 20_000;
// Igual que STALE_MS de la web: un reporte más viejo ya no se muestra en el mapa.
const FRESH_MS = 2 * 60 * 1000;
// Por debajo de esto el GPS de un bus detenido igual marca algo de velocidad.
const MOVING_KMH = 5;
// Reportes viejos que el VMT sigue devolviendo pasada la medianoche: VmtCompactor lee también estos minutos del día siguiente.
const NEXT_DAY_MINUTES = 15;
const PREFIX = "vmt";

/** Una consulta de VmtCollector: la respuesta de cada empresa, o cómo falló. */
export interface BusPoll {
  polled_at: string;
  companies: { code: number; status: number | null; latency_ms: number; error?: string; buses?: VmtBus[] }[];
}

// ---------- Fechas y claves ----------

/** Fecha (AAAA-MM-DD) y hora (HHMMSS) de Paraguay de un instante. */
export function localParts(at: Date): { date: string; time: string } {
  const iso = new Date(at.getTime() + PY_OFFSET_MS).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 19).replaceAll(":", "") };
}

/** Inicio y fin (exclusivo) de un día de Paraguay. */
export function dayBounds(date: string): [Date, Date] {
  const start = Date.parse(`${date}T00:00:00Z`) - PY_OFFSET_MS;
  return [new Date(start), new Date(start + DAY_MS)];
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export const rawBusesPrefix = (date: string) => `${PREFIX}/raw/buses/date=${date}/`;
// Con segundos: si EventBridge dispara dos veces en el mismo minuto, la segunda consulta no pisa a la primera.
export const rawBusesKey = (polledAt: Date) => {
  const { date, time } = localParts(polledAt);
  return `${rawBusesPrefix(date)}${time}.json.gz`;
};
export const rawItinerariesKey = (syncedAt: Date) => `${PREFIX}/raw/itineraries/date=${localParts(syncedAt).date}.json.gz`;
export const positionsKey = (date: string) => `${PREFIX}/positions/date=${date}/positions.parquet`;

/** De las claves listadas bajo el día y el siguiente, las consultas que pueden tener reportes del día. */
export function pollKeysForDay(date: string, keys: string[]): string[] {
  const own = rawBusesPrefix(date);
  const next = rawBusesPrefix(addDays(date, 1));
  const limit = String(NEXT_DAY_MINUTES).padStart(4, "0");
  return keys.filter((k) => k.startsWith(own) || (k.startsWith(next) && k.slice(next.length, next.length + 4) < limit)).sort();
}

// ---------- Recolección (VmtCollector, cada minuto) ----------

/** Empresas consultadas en el último día, para registrar la caída cuando el VMT no devuelve ni la lista. */
async function knownCompanies(): Promise<number[]> {
  const rows = await sql()<{ code: number }[]>`
    SELECT company_code AS code FROM vmt_polls WHERE polled_at > now() - interval '1 day'
    UNION SELECT company_code FROM bus_routes`;
  return rows.map((r) => r.code).sort((a, b) => a - b);
}

/** Pide los buses de todas las empresas a la vez y devuelve lo que contestó cada una, sin lanzar si alguna falla. */
export async function collectBuses(now = new Date()): Promise<BusPoll> {
  const list = await vmtTry<VmtCompany>("/empresas", POLL_TIMEOUT_MS);
  if (!list.data) {
    const codes = await knownCompanies();
    if (!codes.length) throw new Error(list.error);
    // Sin la lista no se puede pedir ninguna empresa: para el mapa es una caída de todas.
    const companies = codes.map((code) => ({ code, status: list.status, latency_ms: list.latencyMs, error: list.error }));
    return { polled_at: now.toISOString(), companies };
  }
  const companies = await Promise.all(
    list.data.map(async ({ cod_catalogo: code }) => {
      const r = await vmtTry<VmtBus & { driver_id?: unknown }>(`/buses?cod_catalogo=${code}`, POLL_TIMEOUT_MS);
      // driver_id hoy viene vacío o con un valor de relleno, pero podría identificar a una persona: no se guarda.
      const buses = r.data?.map(({ driver_id: _, ...b }) => b);
      return { code, status: r.status, latency_ms: r.latencyMs, error: r.error, buses };
    }),
  );
  return { polled_at: now.toISOString(), companies: companies.sort((a, b) => a.code - b.code) };
}

/** Guarda una fila por empresa en `vmt_polls`. */
export async function savePoll(poll: BusPoll): Promise<number> {
  const polledAt = Date.parse(poll.polled_at);
  const rows = poll.companies.map((c) => {
    const ages = (c.buses ?? []).map((b) => polledAt - Date.parse(b.fecha_hora)).filter(Number.isFinite).sort((a, b) => a - b);
    return {
      polled_at: poll.polled_at,
      company_code: c.code,
      http_status: c.status,
      latency_ms: c.latency_ms,
      error: c.error ?? null,
      buses: c.buses ? c.buses.length : null,
      fresh_buses: c.buses ? ages.filter((a) => a <= FRESH_MS).length : null,
      median_age_s: ages.length ? Math.round(median(ages) / 1000) : null,
    };
  });
  if (!rows.length) return 0;
  const s = sql();
  const res = await s`INSERT INTO vmt_polls ${s(rows)} ON CONFLICT DO NOTHING`;
  return res.count;
}

function median(sorted: number[]): number {
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ---------- Compactación (VmtCompactor, una vez por día) ----------

export interface RouteActivity {
  hour: Date; company_code: number; route_hex: string;
  buses: number; moving_buses: number; reports: number; avg_speed: number | null;
}

interface Position {
  reported_at: number; seen_at: number; company_code: number; bus_id: number; route_hex: string; line: string | null;
  lat: number; lon: number; speed: number | null; heading: number | null;
  calc_speed: number | null; calc_heading: number | null; prev_distance_m: number | null; ramp: boolean | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Junta las consultas de un día en una fila por reporte: el VMT devuelve el último reporte de cada bus en cada
 * consulta, así que un reporte aparece en varias. `seen_at` es la primera consulta que lo trajo (para medir con qué
 * demora llegan los datos). Las consultas se pueden agregar en cualquier orden.
 */
export class DayCompactor {
  private readonly start: number;
  private readonly end: number;
  private readonly byReport = new Map<string, Position>();
  polls = 0;

  constructor(readonly date: string) {
    const [start, end] = dayBounds(date);
    this.start = start.getTime();
    this.end = end.getTime();
  }

  add(poll: BusPoll) {
    this.polls++;
    const seenAt = Date.parse(poll.polled_at);
    for (const c of poll.companies) {
      for (const b of c.buses ?? []) {
        const reportedAt = Date.parse(b.fecha_hora);
        const lat = num(b.latitude), lon = num(b.longitude);
        if (!(reportedAt >= this.start && reportedAt < this.end) || lat === null || lon === null) continue;
        const key = `${b.id_bus}|${reportedAt}`;
        const prev = this.byReport.get(key);
        if (prev) {
          prev.seen_at = Math.min(prev.seen_at, seenAt);
          continue;
        }
        const withPrev = b.punto_anterior != null;
        this.byReport.set(key, {
          reported_at: reportedAt, seen_at: seenAt, company_code: c.code, bus_id: b.id_bus,
          route_hex: (b.route_id || "0000").toLowerCase(), line: b.linea_label?.trim() || null, lat, lon,
          speed: num(b.velocidad), heading: num(b.rumbo),
          // Sin el punto anterior el VMT manda estos campos en 0 o con un valor viejo.
          calc_speed: withPrev ? num(b.velocidad_calculada) : null,
          calc_heading: withPrev ? num(b.rumbo_calculado) : null,
          prev_distance_m: withPrev ? num(b.distancia_entre_puntos_m) : null,
          ramp: typeof b.tiene_rampa === "boolean" ? b.tiene_rampa : null,
        });
      }
    }
  }

  get size() {
    return this.byReport.size;
  }

  /** Reportes ordenados por bus y hora (comprime mejor y es el orden de un recorrido). */
  private positions(): Position[] {
    return [...this.byReport.values()].sort((a, b) => a.bus_id - b.bus_id || a.reported_at - b.reported_at);
  }

  /** Parquet con un reporte por fila. Las horas van en UTC (TIMESTAMP_MILLIS). */
  parquet(): ArrayBuffer {
    const rows = this.positions();
    const pick = (f: (p: Position) => unknown) => rows.map(f);
    const int = (v: number | null) => (v === null ? null : Math.round(v));
    return parquetWriteBuffer({
      columnData: [
        { name: "reported_at", type: "TIMESTAMP", data: pick((p) => new Date(p.reported_at)) },
        { name: "seen_at", type: "TIMESTAMP", data: pick((p) => new Date(p.seen_at)) },
        { name: "company_code", type: "INT32", data: pick((p) => p.company_code) },
        { name: "bus_id", type: "INT32", data: pick((p) => p.bus_id) },
        { name: "route_hex", type: "STRING", data: pick((p) => p.route_hex) },
        { name: "line", type: "STRING", data: pick((p) => p.line) },
        { name: "lat", type: "DOUBLE", data: pick((p) => p.lat) },
        { name: "lon", type: "DOUBLE", data: pick((p) => p.lon) },
        { name: "speed", type: "INT32", data: pick((p) => int(p.speed)) },
        { name: "heading", type: "INT32", data: pick((p) => int(p.heading)) },
        { name: "calc_speed", type: "INT32", data: pick((p) => int(p.calc_speed)) },
        { name: "calc_heading", type: "INT32", data: pick((p) => int(p.calc_heading)) },
        { name: "prev_distance_m", type: "INT32", data: pick((p) => int(p.prev_distance_m)) },
        { name: "ramp", type: "BOOLEAN", data: pick((p) => p.ramp) },
      ],
      kvMetadata: [
        { key: "source", value: "prototipo del VMT (MOPC), /buses; compactado por Reporte Ciudadano" },
        { key: "date", value: this.date },
      ],
    });
  }

  /** Actividad por hora y recorrido. La hora de Paraguay empieza en hora UTC exacta, así que se agrupa por hora UTC. */
  activity(): RouteActivity[] {
    const groups = new Map<string, { hour: number; company_code: number; route_hex: string; buses: Set<number>; moving: Set<number>; reports: number; speedSum: number; speedN: number }>();
    for (const p of this.byReport.values()) {
      const hour = p.reported_at - (p.reported_at % 3_600_000);
      const key = `${hour}|${p.company_code}|${p.route_hex}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { hour, company_code: p.company_code, route_hex: p.route_hex, buses: new Set(), moving: new Set(), reports: 0, speedSum: 0, speedN: 0 }));
      g.reports++;
      g.buses.add(p.bus_id);
      if (p.speed !== null && p.speed >= MOVING_KMH) {
        g.moving.add(p.bus_id);
        g.speedSum += p.speed;
        g.speedN++;
      }
    }
    return [...groups.values()]
      .map((g) => ({
        hour: new Date(g.hour), company_code: g.company_code, route_hex: g.route_hex,
        buses: g.buses.size, moving_buses: g.moving.size, reports: g.reports,
        avg_speed: g.speedN ? Math.round((g.speedSum / g.speedN) * 10) / 10 : null,
      }))
      .sort((a, b) => a.hour.getTime() - b.hour.getTime() || a.company_code - b.company_code || a.route_hex.localeCompare(b.route_hex));
  }
}

/** Reemplaza la actividad guardada del día (se puede volver a compactar un día sin duplicar). */
export async function saveRouteActivity(date: string, rows: RouteActivity[]): Promise<void> {
  const [start, end] = dayBounds(date);
  await sql().begin(async (tx) => {
    await tx`DELETE FROM bus_route_activity WHERE hour >= ${start} AND hour < ${end}`;
    // De a 1000 filas: postgres.js manda cada valor como parámetro y el límite es 65535 por consulta.
    for (let i = 0; i < rows.length; i += 1000) await tx`INSERT INTO bus_route_activity ${tx(rows.slice(i, i + 1000))}`;
  });
}
