/**
 * Carga de datos del backtesting: el catálogo de recorridos y las posiciones históricas de los buses, del billetaje
 * (prepare-billetaje.ts) o de nuestro histórico del VMT (vmt/positions/ en S3, ver docs/HISTORICO_VMT.md).
 * Todo vive en data/backtest/, que está en .gitignore.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";
import { routeKey, type CatalogFile, type RouteKey } from "../../src/bus-catalog";
import type { Position } from "./simulate";

export const DATA_DIR = path.resolve(import.meta.dirname, "../../../../data/backtest");
// Paraguay es UTC-3 todo el año desde octubre de 2024; el billetaje (2022–23) se guarda con el mismo criterio.
export const PY_OFFSET_MS = -3 * 3_600_000;
export const hourOf = (t: number) => new Date(t + PY_OFFSET_MS).getUTCHours();
/** Medianoche de Paraguay del día "AAAA-MM-DD". */
export const dayStart = (day: string) => Date.parse(`${day}T00:00:00Z`) - PY_OFFSET_MS;

/**
 * El catálogo que recibe el teléfono: el de un archivo si se pasa, si no el de la base local (después de
 * `pnpm db:bus-routes`), que se guarda para las corridas siguientes.
 */
export async function loadCatalogFile(file?: string): Promise<CatalogFile> {
  const cached = file ?? path.join(DATA_DIR, "catalog.json");
  if (existsSync(cached)) return JSON.parse(await readFile(cached, "utf8")) as CatalogFile;
  if (file) throw new Error(`No existe ${file}`);
  process.env.DATABASE_URL ??= "postgres://postgres:password@localhost:5433/reporte";
  const { listBusRoutes } = await import("../../src/bus-routes");
  const { closeDb } = await import("../../src/db");
  const features = await listBusRoutes();
  await closeDb();
  if (!features.length) throw new Error("La base local no tiene recorridos: corré `pnpm db:migrate && pnpm db:bus-routes`.");
  const catalog: CatalogFile = { type: "FeatureCollection", version: "local", features };
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(cached, JSON.stringify(catalog));
  return catalog;
}

export type Source = "billetaje" | "vmt";

/** Los días disponibles de una fuente ("AAAA-MM-DD"), en orden. */
export async function listDays(source: Source): Promise<string[]> {
  const dir = path.join(DATA_DIR, source);
  if (!existsSync(dir)) return [];
  const names = await readdir(dir);
  const re = source === "billetaje" ? /^date=(\d{4}-\d{2}-\d{2})\.parquet$/ : /^date=(\d{4}-\d{2}-\d{2})$/;
  return names.map((n) => re.exec(n)?.[1]).filter((d): d is string => !!d).sort();
}

/**
 * Las posiciones de un día cuyos recorridos cumplen `want`. En el billetaje la empresa no viene: se toma del
 * catálogo por el `ruta_hex`, que es único entre empresas.
 */
export async function loadDay(source: Source, day: string, hexToKey: Map<string, RouteKey>, want: (key: RouteKey) => boolean): Promise<Position[]> {
  const out: Position[] = [];
  if (source === "billetaje") {
    const file = await asyncBufferFromFile(path.join(DATA_DIR, "billetaje", `date=${day}.parquet`));
    const rows = (await parquetReadObjects({ file, columns: ["bus", "t", "lon", "lat", "route_hex"] })) as { bus: number; t: Date; lon: number; lat: number; route_hex: string }[];
    for (const r of rows) {
      const key = hexToKey.get(r.route_hex);
      if (key && want(key)) out.push({ bus: r.bus, key, t: new Date(r.t).getTime(), lng: r.lon, lat: r.lat });
    }
  } else {
    const file = await asyncBufferFromFile(path.join(DATA_DIR, "vmt", `date=${day}`, "positions.parquet"));
    const rows = (await parquetReadObjects({ file, columns: ["reported_at", "seen_at", "company_code", "bus_id", "route_hex", "lat", "lon", "speed", "calc_heading", "prev_distance_m"] })) as {
      reported_at: Date; seen_at: Date; company_code: number; bus_id: number; route_hex: string | null; lat: number; lon: number; speed: number | null; calc_heading: number | null; prev_distance_m: number | null;
    }[];
    for (const r of rows) {
      if (!r.route_hex || r.route_hex === "0000") continue;
      const key = routeKey(r.company_code, r.route_hex);
      if (!want(key)) continue;
      // Igual que /api/buses: el rumbo calculado solo si el bus se movió.
      const heading = r.calc_heading !== null && (r.prev_distance_m ?? 0) >= 15 ? r.calc_heading : undefined;
      out.push({ bus: r.bus_id, key, t: new Date(r.reported_at).getTime(), seen: new Date(r.seen_at).getTime(), lng: r.lon, lat: r.lat, speed: r.speed ?? 0, ...(heading === undefined ? {} : { heading }) });
    }
  }
  return out;
}
