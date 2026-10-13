/**
 * Backtesting de ¿Cuándo salgo?: simula a alguien que abre la app en una parada a cierta hora, corre el mismo
 * cálculo que el teléfono (@rc/core/departure) con las posiciones que se conocían hasta ese momento y lo compara con
 * cuándo pasó de verdad cada bus por la parada.
 *
 * Es puro: los datos los cargan run.ts (billetaje del VMT 2022–23 o nuestro histórico en Parquet) y los tests.
 */
import { passesNear, type Catalog, type Pass, type RouteKey } from "../../src/bus-catalog";
import { advise, CFG, etas, indexPasses, smoothEtas, speedFor, trackBuses, type Advice, type BusEta, type BusTrack, type DepartureConfig, type LiveBus, type SpeedSource } from "../../src/departure";
import { nearProjections, signedArc, toXY, type LngLat, type Polyline } from "../../src/geo";

/**
 * Una posición conocida de un bus. `t`: cuándo reportó (ms); `seen`: cuándo estuvo disponible en el VMT, si se sabe
 * (nuestro histórico guarda las dos; en el billetaje son la misma).
 */
export interface Position { bus: number; key: RouteKey; t: number; seen?: number; lng: number; lat: number; speed?: number; heading?: number }

/** Una parada de prueba sobre un recorrido. */
export interface TestStop { id: string; key: RouteKey; stop: LngLat }

export interface SimOptions {
  /** Cada cuánto se simula una consulta (ms). */
  everyMs: number;
  /** Desde y hasta qué hora del día (ms desde la medianoche de cada día en `dayStarts`). */
  fromMs: number;
  toMs: number;
  /** Medianoche (hora de Paraguay) de cada día simulado. */
  dayStarts: number[];
  /** Una posición más vieja que esto no está en el feed (el servidor descarta los buses que no reportan hace 2 min). */
  maxAgeMs: number;
  /** Cada cuánto consulta el teléfono con la página abierta (como /api/buses, cada 10 s). */
  pollMs: number;
  /** Caminatas a evaluar (minutos) y margen. */
  walksMin: number[];
  marginMin: number;
  /** Hueco máximo entre dos posiciones para interpolar cuándo pasó un bus. */
  maxGapMs: number;
  cfg?: DepartureConfig;
}

export const DEFAULT_SIM: Omit<SimOptions, "dayStarts"> = {
  everyMs: 5 * 60_000, fromMs: 5 * 3_600_000, toMs: 22 * 3_600_000, maxAgeMs: 120_000,
  pollMs: 10_000, walksMin: [3, 8, 15], marginMin: 2, maxGapMs: 5 * 60_000,
};

/** Una predicción comparada con lo que pasó. */
export interface EtaSample {
  stop: string; key: RouteKey; bus: number; t0: number;
  /** Cuándo pasó de verdad por la parada. */
  truth: number;
  earlyAt: number; likelyAt: number; lateAt: number;
  confidence: BusEta["confidence"];
  source: SpeedSource;
  /** Edad del reporte del bus en el momento de la consulta (s). */
  ageS: number;
}

/**
 * El consejo de una consulta y si se alcanzaba el colectivo siguiéndolo:
 * - `aviso`: arma el aviso y sale cuando suena (la cuenta se recalcula cada 10 s, como en el teléfono).
 * - `una-vez`: mira una sola vez y sale a la hora que le dijo, sin volver a mirar (lo más pesimista).
 */
export type Policy = "aviso" | "una-vez";
export interface AdviceSample {
  stop: string; t0: number; walkMin: number; policy: Policy;
  state: string;
  /** `true`: llegó a la parada antes que el bus; `false`: lo perdió; `null`: no se sabe cuándo pasó. */
  caught: boolean | null;
  /** Minutos esperando en la parada si lo alcanzó. */
  waitMin?: number;
}

/**
 * Cuándo cruzó cada bus el punto `passS` de su recorrido, interpolando entre la posición de antes y la de después.
 * Independiente del seguimiento de departure.ts: cada posición se ubica en el lugar del recorrido más cercano a la
 * anterior, y una vuelta empieza cuando el bus aparece muy atrás.
 */
export function crossingTimes(path: Polyline, frame: Catalog["frame"], positions: Position[], passS: number, maxGapMs: number): number[] {
  return crossingsAndBreaks(path, frame, positions, passS, maxGapMs).crossings;
}

/**
 * Los cruces y los cortes del seguimiento: un hueco largo o un salto para atrás (otra vuelta). Después de un corte
 * no se sabe si el bus pasó por la parada mientras tanto, así que no se lo compara con el cruce de la vuelta siguiente.
 */
export function crossingsAndBreaks(path: Polyline, frame: Catalog["frame"], positions: Position[], passS: number, maxGapMs: number): { crossings: number[]; breaks: number[] } {
  const out: number[] = [];
  const breaks: number[] = [];
  let prev: { t: number; s: number } | undefined;
  for (const p of positions) {
    const [x, y] = toXY(frame, [p.lng, p.lat]);
    const cands = nearProjections(path, x, y, CFG.BUS_OFFSET_M);
    if (!cands.length) continue;
    const ref = prev;
    const c = ref ? cands.reduce((a, b) => (Math.abs(signedArc(path, ref.s, a.s)) <= Math.abs(signedArc(path, ref.s, b.s)) ? a : b)) : cands[0];
    if (prev && p.t - prev.t <= maxGapMs) {
      const ds = signedArc(path, prev.s, c.s);
      const d0 = signedArc(path, prev.s, passS);
      if (ds > 0 && d0 > 0 && d0 <= ds) out.push(prev.t + (d0 / ds) * (p.t - prev.t));
      else if (ds < -CFG.RESET_BACK_M) breaks.push(p.t);
    } else if (prev) breaks.push(p.t);
    prev = { t: p.t, s: c.s };
  }
  return { crossings: out, breaks };
}

/**
 * El feed que habría visto el teléfono a la hora `t`: la última posición disponible de cada bus (la demora del VMT
 * incluida), si no es demasiado vieja.
 */
function feedAt(byBus: Map<number, Position[]>, t: number, maxAgeMs: number): LiveBus[] {
  const out: LiveBus[] = [];
  for (const [bus, ps] of byBus) {
    let lo = 0, hi = ps.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ps[mid].t <= t) {
        idx = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    while (idx >= 0 && (ps[idx].seen ?? ps[idx].t) > t) idx--;
    if (idx < 0 || t - ps[idx].t > maxAgeMs) continue;
    const p = ps[idx];
    const [companyCode, route] = p.key.split(":");
    out.push({ id: bus, companyCode: Number(companyCode), route, line: null, coordinates: [p.lng, p.lat], at: p.t, speed: p.speed ?? 0, ...(p.heading === undefined ? {} : { heading: p.heading }) });
  }
  return out;
}

/** Simula todas las consultas de una parada de prueba. `positions`: las del recorrido de la parada, de todos los días. */
export function simulateStop(catalog: Catalog, stop: TestStop, positions: Position[], opts: SimOptions): { etas: EtaSample[]; advice: AdviceSample[] } {
  const cfg = opts.cfg ?? CFG;
  const route = catalog.routes.get(stop.key);
  const passes: Pass[] = passesNear(catalog, stop.stop).filter((p) => p.key === stop.key).map(({ key, s, bearing, offsetM }) => ({ key, s, bearing, offsetM }));
  if (!route || passes.length !== 1) return { etas: [], advice: [] };
  const trip = indexPasses(passes);
  const byBus = groupBy(positions, (p) => p.bus);
  const truthByBus = new Map<number, { crossings: number[]; breaks: number[] }>();
  for (const [bus, ps] of byBus) {
    ps.sort((a, b) => a.t - b.t);
    truthByBus.set(bus, crossingsAndBreaks(route.path, catalog.frame, ps, passes[0].s, opts.maxGapMs));
  }
  // El próximo cruce, si no hubo un corte del seguimiento antes (ahí se pudo haber perdido el cruce de verdad).
  const nextTruth = (bus: number, t0: number) => {
    const tr = truthByBus.get(bus);
    const c = tr?.crossings.find((t) => t >= t0 - 30_000);
    if (c === undefined) return undefined;
    const b = tr!.breaks.find((t) => t > t0);
    return b !== undefined && b < c ? undefined : c;
  };
  // Hasta dónde hay datos cada día. Una llegada solo se compara si los datos alcanzan a cubrir lo más tarde estimado:
  // si no, quedarían solo los buses que llegaron rápido (los lentos no llegan a verse) y el resultado saldría sesgado.
  const span = new Map<number, [number, number]>();
  for (const day of opts.dayStarts) {
    let first = Infinity, last = -Infinity;
    for (const p of positions) {
      if (p.t < day || p.t >= day + 86_400_000) continue;
      first = Math.min(first, p.t);
      last = Math.max(last, p.t);
    }
    span.set(day, [first, last]);
  }
  // Cuándo suena el aviso: lo mismo que decide lib/client/departure-controller.ts.
  const go = (a: Advice) => a.state === "leave-now" && !!a.target && a.target.confidence !== "low";

  const etaSamples: EtaSample[] = [];
  const adviceSamples: AdviceSample[] = [];
  for (const day of opts.dayStarts) {
    const [first, end] = span.get(day)!;
    if (!Number.isFinite(first)) continue;
    // La página abierta todo el rato: una consulta cada 10 s, con las llegadas suavizadas entre consultas.
    const from = Math.max(day + opts.fromMs, first - 5 * 60_000), to = Math.min(day + opts.toMs, end);
    let tracks = new Map<number, BusTrack>();
    let smooth = new Map<string, BusEta>();
    const polls: { t: number; list: BusEta[]; query: boolean }[] = [];
    let nextQuery = from;
    for (let t = from; t <= to; t += opts.pollMs) {
      tracks = trackBuses(tracks, feedAt(byBus, t, opts.maxAgeMs), catalog, trip, t, cfg);
      const s = smoothEtas(smooth, etas(trip, catalog, tracks, t, cfg), cfg);
      smooth = s.byId;
      const query = t >= nextQuery;
      polls.push({ t, list: s.list, query });
      if (!query) continue;
      nextQuery += opts.everyMs;
      for (const e of s.list) {
        if (e.lateAt > end) continue;
        const truth = nextTruth(e.busId, t);
        // Sin dato de cuándo pasó (el bus dejó de reportar o terminó antes) no hay con qué comparar.
        if (truth === undefined || truth - t > 90 * 60_000) continue;
        const tr = tracks.get(e.busId)!;
        etaSamples.push({
          stop: stop.id, key: stop.key, bus: e.busId, t0: t, truth, earlyAt: e.earlyAt, likelyAt: e.likelyAt, lateAt: e.lateAt,
          confidence: e.confidence, source: speedFor(tr, tracks, cfg).source, ageS: (t - tr.samples.at(-1)!.t) / 1000,
        });
      }
    }
    for (const walkMin of opts.walksMin) {
      const advices = polls.map((p) => advise(p.list, { now: p.t, walkS: walkMin * 60, marginS: opts.marginMin * 60, feedAgeS: 0 }, cfg));
      const judge = (policy: Policy, t0: number, state: string, target: BusEta, leaveAt: number) => {
        if (target.lateAt > end) return;
        const arrive = leaveAt + walkMin * 60_000;
        const truth = nextTruth(target.busId, leaveAt);
        const caught = truth === undefined || truth - t0 > 90 * 60_000 ? null : truth >= arrive;
        adviceSamples.push({ stop: stop.id, t0, walkMin, policy, state, caught, ...(caught ? { waitMin: (truth! - arrive) / 60_000 } : {}) });
      };
      polls.forEach((p, i) => {
        if (!p.query) return;
        const a = advices[i];
        if ((a.state !== "leave-in" && a.state !== "leave-now") || !a.target) return;
        judge("una-vez", p.t, a.state, a.target, p.t + (a.state === "leave-in" ? (a.leaveInMin ?? 0) * 60_000 : 0));
        // Con el aviso armado: sale cuando suena, por el bus que lo hizo sonar.
        const j = advices.findIndex((x, k) => k >= i && go(x));
        if (j >= 0) judge("aviso", p.t, advices[j].state, advices[j].target!, polls[j].t);
      });
    }
  }
  return { etas: etaSamples, advice: adviceSamples };
}

export function groupBy<T, K>(xs: T[], key: (x: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const x of xs) {
    const k = key(x);
    const list = out.get(k);
    if (list) list.push(x);
    else out.set(k, [x]);
  }
  return out;
}

const quantile = (xs: number[], q: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
};

export interface Bucket {
  label: string; n: number;
  /** Error de la llegada probable (min): mediana del absoluto, P90 del absoluto y sesgo (mediana con signo). */
  p50AbsMin: number; p90AbsMin: number; biasMin: number;
  /** Cuántas veces el bus pasó dentro del rango, y antes de lo más temprano (riesgo de perderlo). */
  coverage: number; earlyMiss: number;
  /** Ancho mediano del rango (min). */
  widthMin: number;
}

export function bucketStats(label: string, xs: EtaSample[]): Bucket {
  const err = xs.map((x) => (x.likelyAt - x.truth) / 60_000);
  return {
    label, n: xs.length,
    p50AbsMin: quantile(err.map(Math.abs), 0.5), p90AbsMin: quantile(err.map(Math.abs), 0.9), biasMin: quantile(err, 0.5),
    coverage: xs.filter((x) => x.truth >= x.earlyAt && x.truth <= x.lateAt).length / (xs.length || 1),
    earlyMiss: xs.filter((x) => x.truth < x.earlyAt).length / (xs.length || 1),
    widthMin: quantile(xs.map((x) => (x.lateAt - x.earlyAt) / 60_000), 0.5),
  };
}

export const HORIZONS: [string, number, number][] = [["0–5 min", 0, 5], ["5–10 min", 5, 10], ["10–20 min", 10, 20], ["20–40 min", 20, 40], ["40+ min", 40, Infinity]];

export function byHorizon(xs: EtaSample[]): Bucket[] {
  return HORIZONS.map(([label, a, b]) => bucketStats(label, xs.filter((x) => (x.truth - x.t0) / 60_000 >= a && (x.truth - x.t0) / 60_000 < b)));
}

export interface AdviceStats { walkMin: number; n: number; caught: number; missRate: number; p50WaitMin: number; p90WaitMin: number; unknown: number }

export function adviceStats(xs: AdviceSample[], walks: number[], policy: Policy = "aviso"): AdviceStats[] {
  return walks.map((walkMin) => {
    const w = xs.filter((x) => x.walkMin === walkMin && x.policy === policy);
    const known = w.filter((x) => x.caught !== null);
    const caught = known.filter((x) => x.caught);
    const waits = caught.map((x) => x.waitMin!);
    return {
      walkMin, n: known.length, caught: caught.length, missRate: (known.length - caught.length) / (known.length || 1),
      p50WaitMin: quantile(waits, 0.5), p90WaitMin: quantile(waits, 0.9), unknown: w.length - known.length,
    };
  });
}

/**
 * Factores del rango que habrían dado la cobertura buscada: el viaje real dividido el probable, en sus cuantiles.
 * `fast` deja afuera por temprano a `missTarget` de los casos.
 */
export function suggestFactors(xs: EtaSample[], missTarget = 0.05, lateTarget = 0.95, minN = 30): Record<SpeedSource, [number, number] | null> {
  const ratio = (x: EtaSample) => (x.truth - x.t0) / Math.max(1, x.likelyAt - x.t0);
  const pick = (src: SpeedSource) => {
    const r = xs.filter((x) => x.source === src && x.likelyAt - x.t0 > 60_000).map(ratio);
    if (r.length < minN) return null;
    return [1 / quantile(r, missTarget), 1 / quantile(r, lateTarget)] as [number, number];
  };
  return { bus: pick("bus"), peers: pick("peers"), default: pick("default") };
}

/**
 * Velocidad comercial (con paradas) por hora del día, de buses que avanzan sobre su recorrido: la que conviene como
 * `DEFAULT_KMH`. `hourOf` da la hora local de un instante.
 */
export function commercialSpeedByHour(catalog: Catalog, positions: Position[], hourOf: (t: number) => number, maxGapMs: number): { hour: number; kmh: number; n: number }[] {
  const byHour = new Map<number, number[]>();
  for (const ps of groupBy(positions, (p) => `${p.bus}|${p.key}`).values()) {
    const route = catalog.routes.get(ps[0].key);
    if (!route) continue;
    ps.sort((a, b) => a.t - b.t);
    let prev: { t: number; s: number } | undefined;
    for (const p of ps) {
      const [x, y] = toXY(catalog.frame, [p.lng, p.lat]);
      const c = nearProjections(route.path, x, y, CFG.BUS_OFFSET_M)[0];
      if (!c) continue;
      if (prev && p.t - prev.t <= maxGapMs && p.t - prev.t >= 60_000) {
        const ds = signedArc(route.path, prev.s, c.s);
        // Solo tramos hacia adelante y plausibles: el resto es otra vuelta o un salto del GPS.
        const v = ds / ((p.t - prev.t) / 1000);
        if (ds > 0 && v < CFG.MAX_PLAUSIBLE_MPS) {
          const h = hourOf(p.t);
          const list = byHour.get(h);
          if (list) list.push(v * 3.6);
          else byHour.set(h, [v * 3.6]);
        }
      }
      prev = { t: p.t, s: c.s };
    }
  }
  return [...byHour].sort((a, b) => a[0] - b[0]).map(([hour, v]) => ({ hour, kmh: quantile(v, 0.5), n: v.length }));
}
