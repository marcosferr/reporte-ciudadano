/**
 * Corre el backtesting de ¿Cuándo salgo? sobre el histórico y deja un reporte en data/backtest/.
 *
 * Uso: pnpm --filter @rc/core backtest:run [--source billetaje|vmt] [--days 7] [--stops 40] [--every 5]
 *        [--max-age 120] [--poll 10] [--seed 1] [--catalog data/backtest/catalog.json]
 *
 * - billetaje: paradas de prueba donde de verdad sube gente (validaciones agrupadas cada 30 m). Las posiciones son
 *   más ralas que el GPS (solo cuando alguien paga), así que el resultado es pesimista.
 * - vmt: nuestro histórico de posiciones (una por minuto), con paradas de prueba cada 3 km de cada recorrido.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildCatalog, passesNear, type Catalog, type RouteKey } from "../../src/bus-catalog";
import { CFG } from "../../src/departure";
import { pointAt, toLngLat, toXY } from "../../src/geo";
import { DATA_DIR, dayStart, hourOf, listDays, loadCatalogFile, loadDay, type Source } from "./data";
import { adviceStats, bucketStats, byHorizon, commercialSpeedByHour, DEFAULT_SIM, groupBy, simulateStop, suggestFactors, type Bucket, type EtaSample, type Position, type TestStop } from "./simulate";

interface Args { source: Source; days: number; stops: number; every: number; maxAge: number; poll: number; seed: number; catalog?: string; minBoardings: number }

function parseArgs(argv: string[]): Args {
  const a: Args = { source: "billetaje", days: 7, stops: 40, every: 5, maxAge: 120, poll: 10, seed: 1, minBoardings: 0 };
  for (let i = 0; i < argv.length; i++) {
    const [k, v] = [argv[i].replace(/^--/, ""), argv[i + 1]];
    if (k === "source" && (v === "billetaje" || v === "vmt")) a.source = v;
    else if (k === "catalog") a.catalog = v;
    else if (k === "days" || k === "stops" || k === "every" || k === "poll" || k === "seed") a[k] = Number(v);
    else if (k === "max-age") a.maxAge = Number(v);
    else if (k === "min-boardings") a.minBoardings = Number(v);
    else continue;
    i++;
  }
  return a;
}

/** Números al azar reproducibles (mulberry32). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sample<T>(xs: T[], n: number, rand: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

/** Un solo paso del recorrido por la parada (en un circular que va y vuelve no se sabría cuál comparar). */
function singlePass(catalog: Catalog, key: RouteKey, stop: [number, number]) {
  const ps = passesNear(catalog, stop).filter((p) => p.key === key);
  return ps.length === 1 ? ps[0] : undefined;
}

/** Paradas reales: lugares de cada recorrido donde se validaron muchos pasajes. Hasta 3 por recorrido, separadas. */
async function boardingStops(catalog: Catalog, days: string[], hexToKey: Map<string, RouteKey>, minBoardings: number): Promise<TestStop[]> {
  const cells = new Map<string, { key: RouteKey; n: number; lng: number; lat: number }>();
  for (const day of days) {
    for (const p of await loadDay("billetaje", day, hexToKey, () => true)) {
      const [x, y] = toXY(catalog.frame, [p.lng, p.lat]);
      const id = `${p.key}|${Math.round(x / 30)}|${Math.round(y / 30)}`;
      const c = cells.get(id) ?? { key: p.key, n: 0, lng: 0, lat: 0 };
      c.n++;
      c.lng += p.lng;
      c.lat += p.lat;
      cells.set(id, c);
    }
  }
  const byKey = groupBy([...cells.values()].filter((c) => c.n >= minBoardings), (c) => c.key);
  const out: TestStop[] = [];
  for (const [key, cs] of byKey) {
    const picked: number[] = [];
    for (const c of cs.sort((a, b) => b.n - a.n)) {
      const stop: [number, number] = [c.lng / c.n, c.lat / c.n];
      const pass = singlePass(catalog, key, stop);
      if (!pass || picked.some((s) => Math.abs(s - pass.s) < 1000)) continue;
      picked.push(pass.s);
      out.push({ id: `${key}@${Math.round(pass.s)}`, key, stop });
      if (picked.length === 3) break;
    }
  }
  return out;
}

/** Puntos cada 3 km de los recorridos que tienen posiciones. */
function routeStops(catalog: Catalog, keys: Iterable<RouteKey>): TestStop[] {
  const out: TestStop[] = [];
  for (const key of keys) {
    const route = catalog.routes.get(key);
    if (!route) continue;
    for (let s = 1500; s < route.path.length - 500; s += 3000) {
      const stop = toLngLat(catalog.frame, pointAt(route.path, s));
      if (singlePass(catalog, key, stop)) out.push({ id: `${key}@${s}`, key, stop });
    }
  }
  return out;
}

const pct = (x: number) => `${(x * 100).toFixed(1)} %`;
const num = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "–");

function table(rows: Bucket[]): string {
  const head = "| | n | error P50 | error P90 | sesgo | dentro del rango | antes del rango | ancho del rango |\n|---|---:|---:|---:|---:|---:|---:|---:|";
  return [head, ...rows.filter((r) => r.n).map((r) => `| ${r.label} | ${r.n} | ${num(r.p50AbsMin)} min | ${num(r.p90AbsMin)} min | ${num(r.biasMin)} min | ${pct(r.coverage)} | ${pct(r.earlyMiss)} | ${num(r.widthMin)} min |`)].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rand = rng(args.seed);
  const catalog = buildCatalog(await loadCatalogFile(args.catalog));
  // El billetaje no trae la empresa: el ruta_hex es único entre empresas (si no, se descarta).
  const hexToKey = new Map<string, RouteKey>();
  const repeated = new Set<string>();
  for (const r of catalog.routes.values()) {
    if (hexToKey.has(r.route)) repeated.add(r.route);
    hexToKey.set(r.route, r.key);
  }
  for (const hex of repeated) hexToKey.delete(hex);

  const available = await listDays(args.source);
  if (!available.length) {
    throw new Error(args.source === "billetaje"
      ? "No hay días preparados: bajá los CSV del billetaje a data/backtest/raw/ y corré `pnpm --filter @rc/core backtest:prepare data/backtest/raw/*.csv`."
      : "No hay posiciones: `aws s3 sync s3://<bucket Media>/vmt/positions/ data/backtest/vmt/` (ver docs/DESARROLLO.md).");
  }
  const days = sample(available, args.days, rand).sort();
  console.log(`Fuente: ${args.source}. Días: ${days.join(", ")}`);

  let candidates: TestStop[];
  if (args.source === "billetaje") {
    candidates = await boardingStops(catalog, days, hexToKey, args.minBoardings || 5 * days.length);
  } else {
    const keys = new Set<RouteKey>();
    for (const day of days) for (const p of await loadDay("vmt", day, hexToKey, () => true)) keys.add(p.key);
    candidates = routeStops(catalog, keys);
  }
  const stops = sample(candidates, args.stops, rand);
  console.log(`Paradas de prueba: ${stops.length} de ${candidates.length} posibles`);

  const want = new Set(stops.map((s) => s.key));
  const positions: Position[] = [];
  for (const day of days) positions.push(...(await loadDay(args.source, day, hexToKey, (k) => want.has(k))));
  const byKey = groupBy(positions, (p) => p.key);

  const opts = { ...DEFAULT_SIM, dayStarts: days.map(dayStart), everyMs: args.every * 60_000, maxAgeMs: args.maxAge * 1000, pollMs: args.poll * 1000 };
  const etaSamples: EtaSample[] = [];
  const advice: ReturnType<typeof simulateStop>["advice"] = [];
  stops.forEach((stop, i) => {
    const r = simulateStop(catalog, stop, byKey.get(stop.key) ?? [], opts);
    etaSamples.push(...r.etas);
    advice.push(...r.advice);
    console.log(`[${i + 1}/${stops.length}] ${stop.id}: ${r.etas.length} llegadas, ${r.advice.length} consejos`);
  });

  const speed = commercialSpeedByHour(catalog, positions, hourOf, opts.maxGapMs);
  const dayHours = speed.filter((s) => s.hour >= 6 && s.hour <= 20);
  const suggestedKmh = dayHours.length ? dayHours.reduce((a, s) => a + s.kmh * s.n, 0) / dayHours.reduce((a, s) => a + s.n, 0) : NaN;
  const factors = suggestFactors(etaSamples);
  const ages: [string, number, number][] = [["0–30 s", 0, 30], ["30–60 s", 30, 60], ["60–120 s", 60, 120], ["más de 120 s", 120, Infinity]];

  const report = `# Backtesting de ¿Cuándo salgo? (${args.source})

Generado el ${new Date().toISOString()} con \`${process.argv.slice(2).join(" ") || "(valores por defecto)"}\`.

- Días: ${days.join(", ")}
- Paradas de prueba: ${stops.length} (de ${candidates.length} posibles), con la página abierta (una consulta cada ${args.poll} s) y una evaluación cada ${args.every} min, de 5 a 22 h
- Llegadas comparadas: ${etaSamples.length}. Edad máxima del reporte en el feed: ${args.maxAge} s

## Llegada estimada contra la real, por cuánto faltaba

Error de la llegada probable. "Antes del rango": el bus pasó antes de lo más temprano estimado (riesgo de perderlo).

${table(byHorizon(etaSamples))}

## Por confianza, origen de la velocidad y edad del reporte

${table([
  ...(["high", "medium", "low"] as const).map((c) => bucketStats(`confianza ${c}`, etaSamples.filter((x) => x.confidence === c))),
  ...(["bus", "peers", "default"] as const).map((s) => bucketStats(`velocidad: ${s}`, etaSamples.filter((x) => x.source === s))),
  ...ages.map(([label, a, b]) => bucketStats(`reporte de ${label}`, etaSamples.filter((x) => x.ageS >= a && x.ageS < b))),
])}

## Siguiendo el consejo (meta: perder menos del 5 %)

Margen de ${opts.marginMin} min. **Con el aviso**: arma el aviso cuando viene un colectivo y sale cuando suena. **Mirando una vez**: sale a la hora que le dijo la primera vez, sin volver a mirar (lo más pesimista).

${(["aviso", "una-vez"] as const).map((policy) => `| ${policy === "aviso" ? "con el aviso" : "mirando una vez"} | consejos | lo alcanzó | lo perdió | espera P50 | espera P90 | sin dato |
|---:|---:|---:|---:|---:|---:|---:|
${adviceStats(advice, opts.walksMin, policy).map((a) => `| caminata ${a.walkMin} min | ${a.n} | ${a.caught} | ${pct(a.missRate)} | ${num(a.p50WaitMin)} min | ${num(a.p90WaitMin)} min | ${a.unknown} |`).join("\n")}`).join("\n\n")}

## Sugerencias para \`CFG\` (packages/core/src/departure.ts)

- \`FACTORS\` actuales: ${JSON.stringify(CFG.FACTORS)}
- Con 5 % antes del rango y 95 % dentro: ${JSON.stringify(Object.fromEntries(Object.entries(factors).map(([k, v]) => [k, v && v.map((x) => +x.toFixed(2))])))}
- \`DEFAULT_KMH\` actual: ${CFG.DEFAULT_KMH}; velocidad comercial de 6 a 20 h: **${num(suggestedKmh)} km/h**

| hora | km/h (mediana) | tramos |
|---:|---:|---:|
${speed.map((s) => `| ${s.hour} | ${num(s.kmh)} | ${s.n} |`).join("\n")}
`;
  await mkdir(DATA_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = path.join(DATA_DIR, `report-${args.source}-${stamp}.md`);
  await writeFile(out, report);
  console.log(`\n${report}\nReporte: ${out}`);
}

await main();
