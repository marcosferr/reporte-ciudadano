/**
 * Prepara el histórico del billetaje electrónico del VMT (enero de 2022 a marzo de 2023, los "8 CDs" que reúne
 * github.com/luchobenitez/monda-guasu) para el backtesting de ¿Cuándo salgo?.
 *
 * Cada validación de tarjeta es un colectivo detenido levantando gente: dónde y cuándo estuvo cada bus en una parada
 * real. Eso es lo único que se guarda: el validador (`idsam`, casi siempre el mismo bus), la hora, el lugar y el
 * recorrido (`idrutaestacion`, el mismo código que el `ruta_hex` del VMT de hoy).
 *
 * Privacidad: `serialtarjeta` es el hash de la tarjeta de un pasajero. Se descarta al leer cada fila y no se escribe
 * nunca, igual que el monto, el producto y el consecutivo. Los CSV originales los bajás a mano y conviene borrarlos
 * después de correr esto.
 *
 * Uso: pnpm --filter @rc/core backtest:prepare data/backtest/raw/*.csv
 * Deja un Parquet por día en data/backtest/billetaje/ (en .gitignore, no se sube a ningún lado).
 */
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { createGunzip } from "node:zlib";
import { parquetWriteBuffer } from "hyparquet-writer";
import { DATA_DIR, PY_OFFSET_MS } from "./data";

const OUT = path.join(DATA_DIR, "billetaje");
const TMP = path.join(OUT, "tmp");
// Hasta octubre de 2024 Paraguay cambiaba la hora: esos días tienen una hora repetida o faltante y se descartan.
const DST_CHANGES = new Set(["2022-03-27", "2022-10-02", "2023-03-26"]);
// Orden de las columnas si el CSV viene sin encabezado (el de los CDs). Los repos que lo usan no coinciden en el
// orden de latitud y longitud, así que se distinguen por el valor.
const DEFAULT_COLUMNS = ["serialtarjeta", "idsam", "fechahoraevento", "producto", "montoevento", "consecutivoevento", "identidad", "tipoevento", "longitude", "latitude", "idrutaestacion", "tipotransporte"];
// Tipo de evento de un viaje normal (los demás son devoluciones y recargas).
const TRIP_EVENT = 4;

const isLat = (v: number) => v > -27.7 && v < -19;
const isLng = (v: number) => v > -62.7 && v < -54;

/** Hora de reloj de Paraguay ("2023-03-01 05:12:33", "01/03/2023 05:12:33") como instante y día. */
export function parseClock(s: string): { t: number; day: string } | null {
  let m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  let y: string, mo: string, d: string, h: string, mi: string, se: string;
  if (m) [, y, mo, d, h, mi, se] = m;
  else {
    m = /(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})/.exec(s);
    if (!m) return null;
    [, d, mo, y, h, mi, se] = m;
  }
  // Se guarda como si Paraguay fuera siempre UTC-3 (como hoy): dentro de un día las diferencias son exactas y la
  // hora del día es la del reloj.
  const t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se) - PY_OFFSET_MS;
  return Number.isFinite(t) ? { t, day: `${y}-${mo}-${d}` } : null;
}

const unquote = (s: string | undefined) => (s ?? "").trim().replace(/^"(.*)"$/, "$1").trim();

/** Una validación reducida a lo que sirve, o el motivo por el que no sirve. Nunca devuelve datos de la tarjeta. */
export function parseRow(fields: string[], col: Record<string, number>): { idsam: string; t: number; day: string; lng: number; lat: number; route: string } | string {
  if (Number(unquote(fields[col.tipoevento])) !== TRIP_EVENT) return "evento";
  const a = Number(unquote(fields[col.latitude])), b = Number(unquote(fields[col.longitude]));
  const [lat, lng] = isLat(a) && isLng(b) ? [a, b] : isLat(b) && isLng(a) ? [b, a] : [NaN, NaN];
  if (!Number.isFinite(lat)) return "coordenadas";
  const when = parseClock(unquote(fields[col.fechahoraevento]));
  if (!when) return "fecha";
  if (DST_CHANGES.has(when.day)) return "cambio de hora";
  const route = unquote(fields[col.idrutaestacion]).toLowerCase();
  if (!/^[0-9a-f]{4}$/.test(route)) return "recorrido";
  const idsam = unquote(fields[col.idsam]);
  if (!idsam) return "validador";
  return { idsam, t: when.t, day: when.day, lng, lat, route };
}

async function main(files: string[]) {
  if (!files.length) {
    console.error("Uso: pnpm --filter @rc/core backtest:prepare <csv o csv.gz del billetaje>...");
    process.exit(1);
  }
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });
  const buses = new Map<string, number>();
  const outs = new Map<string, WriteStream>();
  const skipped = new Map<string, number>();
  let read = 0, kept = 0;

  for (const file of files) {
    const input = file.endsWith(".gz") ? createReadStream(file).pipe(createGunzip()) : createReadStream(file);
    let col: Record<string, number> | undefined;
    let sep = ";";
    for await (const line of createInterface({ input, crlfDelay: Infinity })) {
      if (!line.trim()) continue;
      if (!col) {
        sep = line.includes(";") ? ";" : ",";
        const head = line.split(sep).map((h) => unquote(h).toLowerCase());
        const names = head.includes("idsam") ? head : DEFAULT_COLUMNS;
        col = Object.fromEntries(names.map((n, i) => [n, i]));
        if (head.includes("idsam")) continue;
      }
      read++;
      const row = parseRow(line.split(sep), col);
      if (typeof row === "string") {
        skipped.set(row, (skipped.get(row) ?? 0) + 1);
        continue;
      }
      kept++;
      let bus = buses.get(row.idsam);
      if (bus === undefined) buses.set(row.idsam, (bus = buses.size + 1));
      let out = outs.get(row.day);
      if (!out) outs.set(row.day, (out = createWriteStream(path.join(TMP, `${row.day}.csv`), { flags: "a" })));
      if (!out.write(`${bus},${row.t},${row.lng},${row.lat},${row.route}\n`)) await new Promise<void>((r) => out!.once("drain", () => r()));
      if (read % 1_000_000 === 0) console.log(`${(read / 1e6).toFixed(0)} M filas leídas…`);
    }
  }
  await Promise.all([...outs.values()].map((o) => new Promise<void>((r) => o.end(() => r()))));

  // Un Parquet por día, ordenado por bus y hora (el orden de un recorrido).
  for (const name of (await readdir(TMP)).sort()) {
    const rows = (await readFile(path.join(TMP, name), "utf8")).trim().split("\n").map((l) => l.split(","));
    rows.sort((a, b) => +a[0] - +b[0] || +a[1] - +b[1]);
    const day = name.replace(".csv", "");
    const buf = parquetWriteBuffer({
      columnData: [
        { name: "bus", type: "INT32", data: rows.map((r) => +r[0]) },
        { name: "t", type: "TIMESTAMP", data: rows.map((r) => new Date(+r[1])) },
        { name: "lon", type: "DOUBLE", data: rows.map((r) => +r[2]) },
        { name: "lat", type: "DOUBLE", data: rows.map((r) => +r[3]) },
        { name: "route_hex", type: "STRING", data: rows.map((r) => r[4]) },
      ],
      kvMetadata: [
        { key: "source", value: "billetaje electrónico del VMT (validaciones de viaje), sin datos de tarjetas" },
        { key: "date", value: day },
      ],
    });
    await writeFile(path.join(OUT, `date=${day}.parquet`), new Uint8Array(buf));
    console.log(`${day}: ${rows.length} validaciones`);
  }
  await rm(TMP, { recursive: true, force: true });
  console.log(`Leídas ${read}, guardadas ${kept}. Descartadas: ${[...skipped].map(([k, n]) => `${k} ${n}`).join(", ") || "ninguna"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
