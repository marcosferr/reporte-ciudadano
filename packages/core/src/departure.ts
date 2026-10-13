/**
 * ¿Cuándo salgo? Cuándo tiene que salir alguien para alcanzar el próximo colectivo en su parada, calculado en el
 * dispositivo con los buses en vivo (/api/buses) y el catálogo de recorridos (bus-catalog.ts). Es puro: lo usan
 * el navegador y el backtesting (scripts/backtest), con el mismo código y las mismas constantes.
 *
 * Por cada bus de las líneas elegidas:
 * 1. Se ubica sobre su recorrido (`s`, metros desde el inicio) y se sigue entre consultas (`trackBuses`).
 * 2. Su velocidad sale de cuánto avanzó en los últimos minutos, de los otros buses de la línea o de un valor por
 *    defecto (`speedFor`).
 * 3. Se estima cuándo llega a la parada, como un rango: lo antes y lo más tarde razonable (`etas`).
 * 4. El consejo usa lo antes: así se pierde el colectivo lo menos posible (`advise`).
 */
import { distanceM, forwardArc, nearProjections, normS, angleDiff, bearingAt, signedArc, toXY, type LngLat, type Polyline } from "./geo";
import { normLine, type Catalog, type Pass, type RouteKey, routeKey } from "./bus-catalog";

export type SpeedSource = "bus" | "peers" | "default";

/**
 * Constantes del cálculo. Los valores salen del backtesting contra el histórico (ver scripts/backtest y
 * docs/DESARROLLO.md); si se cambian, hay que volver a correrlo.
 */
export const CFG = {
  // Un bus a más de esto de su recorrido no está sobre él (GPS malo o un recorrido viejo).
  BUS_OFFSET_M: 80,
  // Va a contramano del recorrido: el bus ya está en la vuelta y sigue reportando la ida, o es otra pasada.
  HEADING_REJECT_DEG: 120,
  HEADING_M_PER_DEG: 0.5,
  // Dos lugares posibles sobre el recorrido con puntaje parecido: no se sabe en cuál está.
  AMBIGUOUS_SCORE_M: 25,
  PASS_MERGE_ARC_M: 200,
  // Seguimiento: cuánto historial se guarda y desde cuándo se confía en el avance del propio bus.
  TRACK_WINDOW_MS: 300_000,
  MIN_SPAN_S: 60,
  FULL_TRUST_SPAN_S: 300,
  PEER_MIN_SPAN_S: 120,
  // Un retroceso corto es ruido del GPS; uno largo es que el bus empezó otra vuelta o estaba mal ubicado.
  JITTER_BACK_M: 30,
  RESET_BACK_M: 200,
  // Más rápido que esto (80 km/h) es un salto del GPS: se espera a una segunda muestra que lo confirme.
  MAX_PLAUSIBLE_MPS: 22,
  // Detenido cerca del inicio del recorrido: esperando en la terminal para salir.
  TERMINAL_ZONE_M: 300,
  DWELL_MOVE_M: 30,
  DWELL_WINDOW_S: 120,
  STALLED_WINDOW_S: 240,
  // Velocidad comercial (con paradas y semáforos) cuando no hay nada mejor. Ajustada con el backtesting.
  DEFAULT_KMH: 15,
  MIN_KMH: 4,
  MAX_EST_KMH: 40,
  EARLY_CAP_KMH: 45,
  // Rango de llegada: la velocidad se multiplica por [rápido, lento] según de dónde salió. Lo rápido decide cuándo
  // salir: con 1,25 para el bus, quien caminaba 8 min y salía con el aviso perdía el 6,9 % de los colectivos; con
  // 1,4, el 4,2 %, a cambio de esperar ~1 min más en la parada.
  FACTORS: { bus: [1.4, 0.8], peers: [1.5, 0.7], default: [1.6, 0.6] } as Record<SpeedSource, [number, number]>,
  // Demora entre que el bus reporta y que el dato llega al teléfono: los reportes llegan con 30–60 s. Con 15 s, el
  // 23 % de los buses a menos de 2 min pasaba antes de lo más temprano estimado; con 45 s, el 9 %.
  // Backtesting: VMT en vivo del 12/10/2026, 18:30–19:20, 1977 paradas de prueba (ver docs/DESARROLLO.md).
  LATENCY_EARLY_S: 45,
  LATENCY_LATE_S: 60,
  MAX_EXTRAPOLATE_S: 120,
  // El bus está en la parada.
  AT_STOP_M: 40,
  // Un bus que desaparece del VMT se sigue estimando un rato (sin avisar por él).
  GHOST_MS: 180_000,
  OFF_ROUTE_DROP: 3,
  // Un circular que ya pasó vuelve después de la terminal; un bus en la terminal puede tardar en salir.
  LAYOVER_MAX_S: 600,
  DWELL_MAX_S: 600,
  // Suavizado de las llegadas entre consultas, para que "Salí en X" no salte.
  EMA_ALPHA: 0.5,
  EMA_RESET_S: 300,
  // Datos sin actualizar: primero se avisa, después no se aconseja nada.
  STALE_FEED_S: 45,
  DEAD_FEED_S: 180,
  // Más lejos que esto no se cuentan minutos: "el próximo está lejos".
  FAR_MIN: 45,
  // Caminata: las calles hacen el camino más largo que la línea recta.
  WALK_DETOUR: 1.3,
};
export type DepartureConfig = typeof CFG;

const kmh = (v: number) => v / 3.6;

/** Un colectivo como llega del VMT, reducido a lo que usa el cálculo. `at`: cuándo reportó (ms). */
export interface LiveBus {
  id: number; companyCode: number; route: string | null; line: string | null;
  coordinates: LngLat; at: number; heading?: number; speed: number;
}

/** Las pasadas de un viaje por recorrido, para buscar rápido. */
export interface TripIndex { keys: Set<RouteKey>; byKey: Map<RouteKey, Pass[]> }

export function indexPasses(passes: Pass[]): TripIndex {
  const byKey = new Map<RouteKey, Pass[]>();
  for (const p of passes) byKey.set(p.key, [...(byKey.get(p.key) ?? []), p].sort((a, b) => a.s - b.s));
  return { keys: new Set(byKey.keys()), byKey };
}

interface Sample { t: number; s: number }

export interface BusTrack {
  id: number; key: RouteKey;
  /** Empresa y línea: los otros buses de la línea dan la velocidad cuando el bus recién aparece. */
  lineKey: string;
  line: string | null;
  lngLat: LngLat;
  /** `s` sin dar la vuelta (en un circular sigue creciendo): para medir cuánto avanzó. */
  samples: Sample[];
  /** `s` sobre el recorrido, en [0, largo]. */
  lastRaw: number;
  /** Un salto imposible que espera confirmación. */
  pending?: Sample;
  lastSeen: number;
  offRoute: number;
  ambiguous: boolean;
  /** Si es ambiguo, el otro lugar posible sobre el recorrido. */
  alt?: number;
  ghost: boolean;
  dwell: boolean;
  stalled: boolean;
  speedKmh: number;
  /** Cuándo cruzó por última vez cada pasada del viaje (índice de la pasada → ms). */
  crossed: Map<number, number>;
}
export type Tracks = ReadonlyMap<number, BusTrack>;

interface Pick { s: number; offsetM: number; ambiguous: boolean; alt?: number }

/** Dónde está el bus sobre su recorrido; con dos lugares posibles, decide el rumbo y dónde estaba antes. */
function choose(path: Polyline, xy: [number, number], bus: LiveBus, old: BusTrack | undefined, cfg: DepartureConfig): Pick | null {
  const cands = nearProjections(path, xy[0], xy[1], cfg.BUS_OFFSET_M, { mergeArcM: cfg.PASS_MERGE_ARC_M });
  const scored: { s: number; offsetM: number; score: number }[] = [];
  for (const c of cands) {
    let score = c.offsetM;
    if (bus.heading !== undefined) {
      const diff = angleDiff(bus.heading, bearingAt(path, c.s));
      if (diff > cfg.HEADING_REJECT_DEG) continue;
      score += diff * cfg.HEADING_M_PER_DEG;
    }
    const last = old?.samples.at(-1);
    if (old && last) {
      const dt = (bus.at - last.t) / 1000;
      const ds = signedArc(path, old.lastRaw, c.s);
      const v = observedSpeed(old, cfg) ?? kmh(cfg.DEFAULT_KMH);
      if (ds < -cfg.JITTER_BACK_M || ds > cfg.MAX_PLAUSIBLE_MPS * Math.max(dt, 1) + 100) score += 500;
      else score += Math.abs(ds - v * dt) * 0.05;
    }
    scored.push({ s: c.s, offsetM: c.offsetM, score });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => a.score - b.score);
  const [best, second] = scored;
  const ambiguous = !!second && second.score - best.score < cfg.AMBIGUOUS_SCORE_M && Math.abs(signedArc(path, best.s, second.s)) > cfg.PASS_MERGE_ARC_M;
  return { s: best.s, offsetM: best.offsetM, ambiguous, ...(ambiguous ? { alt: second.s } : {}) };
}

/** Cuánto se movió el bus en los últimos `windowS` segundos, si el historial alcanza para saberlo. */
function recentMove(samples: Sample[], windowS: number): number | undefined {
  const last = samples.at(-1);
  if (!last) return undefined;
  const from = samples.find((x) => x.t >= last.t - windowS * 1000);
  if (!from || (last.t - from.t) / 1000 < windowS * 0.75) return undefined;
  return last.s - from.s;
}

function withState(t: BusTrack, path: Polyline, cfg: DepartureConfig): BusTrack {
  const inZone = t.lastRaw < cfg.TERMINAL_ZONE_M || (path.closed && t.lastRaw > path.length - cfg.TERMINAL_ZONE_M);
  const moved = recentMove(t.samples, cfg.DWELL_WINDOW_S);
  const dwell = inZone && (moved !== undefined ? moved < cfg.DWELL_MOVE_M : t.speedKmh === 0);
  const longMove = recentMove(t.samples, cfg.STALLED_WINDOW_S);
  const stalled = !dwell && longMove !== undefined && longMove < cfg.DWELL_MOVE_M;
  return { ...t, dwell, stalled };
}

function newTrack(bus: LiveBus, key: RouteKey, pick: Pick, samples: Sample[], path: Polyline, now: number, cfg: DepartureConfig): BusTrack {
  return withState({
    id: bus.id, key, lineKey: `${bus.companyCode}|${normLine(bus.line)}`, line: bus.line, lngLat: bus.coordinates,
    samples, lastRaw: pick.s, lastSeen: now, offRoute: 0, ambiguous: pick.ambiguous, alt: pick.alt,
    ghost: false, dwell: false, stalled: false, speedKmh: bus.speed, crossed: new Map(),
  }, path, cfg);
}

function addSample(old: BusTrack, bus: LiveBus, pick: Pick, path: Polyline, passes: Pass[], now: number, cfg: DepartureConfig): BusTrack {
  const last = old.samples.at(-1)!;
  const dt = (bus.at - last.t) / 1000;
  let ds = signedArc(path, old.lastRaw, pick.s);
  // Volvió muy atrás: empezó otra vuelta o estaba mal ubicado. Se arranca de nuevo.
  if (ds < -cfg.RESET_BACK_M) return newTrack(bus, old.key, pick, [{ t: bus.at, s: pick.s }], path, now, cfg);
  // Un retroceso corto es ruido del GPS: el bus no va para atrás.
  const raw = ds < 0 ? old.lastRaw : pick.s;
  if (ds < 0) ds = 0;
  if (ds > cfg.MAX_PLAUSIBLE_MPS * Math.max(dt, 1) + 50) {
    const p = old.pending;
    const confirmed = p && Math.abs(signedArc(path, p.s, pick.s)) <= cfg.MAX_PLAUSIBLE_MPS * Math.max((bus.at - p.t) / 1000, 1) + 50;
    if (confirmed) return newTrack(bus, old.key, pick, [p, { t: bus.at, s: p.s + Math.max(0, signedArc(path, p.s, pick.s)) }], path, now, cfg);
    return { ...old, pending: { t: bus.at, s: pick.s }, lastSeen: now, ghost: false };
  }
  const crossed = new Map(old.crossed);
  passes.forEach((pass, i) => {
    const d0 = forwardArc(path, old.lastRaw, pass.s);
    if (ds > 0 && d0 > 0 && d0 <= ds) crossed.set(i, last.t + (d0 / ds) * (bus.at - last.t));
  });
  const samples = [...old.samples, { t: bus.at, s: last.s + ds }].filter((x, i, all) => i === all.length - 1 || x.t >= bus.at - cfg.TRACK_WINDOW_MS);
  return withState({
    ...old, lngLat: bus.coordinates, samples, lastRaw: raw, pending: undefined, lastSeen: now, offRoute: 0,
    ambiguous: pick.ambiguous, alt: pick.alt, ghost: false, speedKmh: bus.speed, crossed, line: bus.line ?? old.line,
  }, path, cfg);
}

/**
 * Sigue a los buses de las líneas del viaje entre una consulta y la siguiente. `now` es la hora real (el reloj del
 * teléfono corregido con la hora del servidor). Un bus que desaparece queda unos minutos como "fantasma".
 */
export function trackBuses(prev: Tracks, buses: LiveBus[], catalog: Catalog, trip: TripIndex, now: number, cfg: DepartureConfig = CFG): Map<number, BusTrack> {
  const next = new Map<number, BusTrack>();
  const inFeed = new Set(buses.map((b) => b.id));
  for (const bus of buses) {
    if (!bus.route) continue;
    const key = routeKey(bus.companyCode, bus.route);
    if (!trip.keys.has(key)) continue;
    const route = catalog.routes.get(key);
    if (!route || !Number.isFinite(bus.at) || bus.at > now + 60_000) continue;
    let old = prev.get(bus.id);
    // Cambió de recorrido (de la ida a la vuelta): es otro seguimiento.
    if (old && old.key !== key) old = undefined;
    const last = old?.samples.at(-1);
    // El mismo reporte de antes (el VMT y la cache repiten): no hay nada nuevo.
    if (old && last && bus.at <= Math.max(last.t, old.pending?.t ?? -Infinity)) {
      next.set(bus.id, { ...old, lastSeen: now, ghost: false });
      continue;
    }
    const pick = choose(route.path, toXY(catalog.frame, bus.coordinates), bus, old, cfg);
    if (!pick) {
      if (old && old.offRoute + 1 < cfg.OFF_ROUTE_DROP) next.set(bus.id, { ...old, offRoute: old.offRoute + 1, lastSeen: now });
      continue;
    }
    const passes = trip.byKey.get(key) ?? [];
    next.set(bus.id, old ? addSample(old, bus, pick, route.path, passes, now, cfg) : newTrack(bus, key, pick, [{ t: bus.at, s: pick.s }], route.path, now, cfg));
  }
  // Solo es fantasma el que no vino en el VMT; uno que vino fuera de su recorrido ya se decidió arriba.
  for (const [id, t] of prev) {
    if (!inFeed.has(id) && now - t.lastSeen <= cfg.GHOST_MS) next.set(id, { ...t, ghost: true });
  }
  return next;
}

/** Metros por segundo que avanzó el bus en su historial, si es suficiente y no está esperando en la terminal. */
function observedSpeed(t: BusTrack, cfg: DepartureConfig): number | undefined {
  if (t.dwell) return undefined;
  const first = t.samples[0], last = t.samples.at(-1)!;
  const span = (last.t - first.t) / 1000;
  if (span < cfg.MIN_SPAN_S) return undefined;
  return (last.s - first.s) / span;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

/**
 * `w`: cuánto pesa el avance del propio bus (0 a 1). `priorSource`: de dónde salió lo demás (otros buses de la
 * línea o el valor por defecto).
 */
export interface Speed { v: number; prior: number; source: SpeedSource; w: number; priorSource: Exclude<SpeedSource, "bus"> }

/** Velocidad para estimar la llegada: la del bus si hay historial, mezclada con la de los otros buses de la línea. */
export function speedFor(t: BusTrack, tracks: Tracks, cfg: DepartureConfig = CFG): Speed {
  const peers: number[] = [];
  for (const o of tracks.values()) {
    if (o.id === t.id || o.lineKey !== t.lineKey || o.ghost || o.dwell) continue;
    const span = (o.samples.at(-1)!.t - o.samples[0].t) / 1000;
    const v = span >= cfg.PEER_MIN_SPAN_S ? observedSpeed(o, cfg) : undefined;
    if (v !== undefined) peers.push(v);
  }
  const fromPeers = peers.length >= 2;
  const prior = fromPeers ? Math.min(Math.max(median(peers), kmh(cfg.MIN_KMH)), kmh(cfg.MAX_EST_KMH)) : kmh(cfg.DEFAULT_KMH);
  const priorSource = fromPeers ? "peers" : "default";
  const vObs = observedSpeed(t, cfg);
  if (vObs === undefined) return { v: prior, prior, source: priorSource, w: 0, priorSource };
  const span = (t.samples.at(-1)!.t - t.samples[0].t) / 1000;
  const w = Math.min(1, Math.max(0, (span - cfg.MIN_SPAN_S) / (cfg.FULL_TRUST_SPAN_S - cfg.MIN_SPAN_S)));
  const v = Math.min(kmh(cfg.MAX_EST_KMH), Math.max(kmh(cfg.MIN_KMH), w * vObs + (1 - w) * prior));
  return { v, prior, source: w >= 0.5 ? "bus" : priorSource, w, priorSource };
}

export interface PassEta {
  /** Segundos desde ahora: lo antes, lo probable y lo más tarde razonable. */
  early: number; likely: number; late: number;
  distanceM: number; atStop: boolean; wrap: boolean;
}

/** Cuándo llega el bus a una pasada; `null` si ya pasó (y el recorrido no es circular). */
export function etaForPass(t: BusTrack, pass: Pass, path: Polyline, sp: Speed, now: number, cfg: DepartureConfig = CFG, sOverride?: number): PassEta | null {
  const last = t.samples.at(-1)!;
  const age = Math.min(cfg.MAX_EXTRAPOLATE_S, Math.max(0, (now - last.t) / 1000));
  const s0 = sOverride ?? t.lastRaw;
  const dObs = signedArc(path, s0, pass.s);
  if (Math.abs(dObs) <= cfg.AT_STOP_M && age <= 30) {
    return { early: 0, likely: 0, late: t.dwell ? cfg.DWELL_MAX_S : 30, distanceM: Math.max(0, dObs), atStop: true, wrap: false };
  }
  const sNow = normS(path, s0 + (t.dwell ? 0 : sp.v * age));
  let d: number;
  let wrap = false;
  if (!path.closed) {
    d = pass.s - sNow;
    if (d < -cfg.AT_STOP_M) return null;
  } else if (signedArc(path, sNow, pass.s) <= 0 && signedArc(path, sNow, pass.s) >= -cfg.AT_STOP_M) {
    // Recién pasó por la parada (dentro de la tolerancia): está llegando.
    d = 0;
  } else {
    // En un circular siempre se llega yendo hacia adelante; da la vuelta (y espera en la terminal) solo si en el
    // camino pasa por el inicio del recorrido.
    d = forwardArc(path, sNow, pass.s);
    wrap = sNow > pass.s;
  }
  d = Math.max(0, d);
  // Los factores pasan de a poco de los del valor previo a los del bus a medida que hay historial: con un cambio de
  // golpe, "Salí en 2 min" podía volver a "Salí en 3 min".
  const [pf, ps] = cfg.FACTORS[sp.priorSource], [bf, bs] = cfg.FACTORS.bus;
  const fast = pf + (bf - pf) * sp.w, slow = ps + (bs - ps) * sp.w;
  const vEarly = Math.min(Math.max(sp.v, sp.prior) * fast, kmh(cfg.EARLY_CAP_KMH));
  const vLate = Math.max(Math.min(sp.v, sp.prior) * slow, kmh(cfg.MIN_KMH));
  const extra = (wrap ? cfg.LAYOVER_MAX_S : 0) + (t.dwell ? cfg.DWELL_MAX_S : 0);
  return {
    early: Math.max(0, d / vEarly - cfg.LATENCY_EARLY_S),
    likely: d / sp.v + (wrap ? cfg.LAYOVER_MAX_S / 2 : 0),
    late: d / vLate + cfg.LATENCY_LATE_S + extra,
    distanceM: d, atStop: false, wrap,
  };
}

export type Confidence = "high" | "medium" | "low";

export interface BusEta {
  busId: number; key: RouteKey; line: string | null; lngLat: LngLat;
  /** Índice de la pasada del viaje (orden de `TripIndex.byKey`). */
  pass: number;
  /** Hora absoluta (ms) de llegada: lo antes, lo probable y lo más tarde. */
  earlyAt: number; likelyAt: number; lateAt: number;
  distanceM: number; confidence: Confidence;
  flags: { atStop?: true; wrap?: true; dwell?: true; ghost?: true; ambiguous?: true; stalled?: true };
}

/** La próxima llegada de cada bus a la parada del viaje, de la más temprana a la más tardía. */
export function etas(trip: TripIndex, catalog: Catalog, tracks: Tracks, now: number, cfg: DepartureConfig = CFG): BusEta[] {
  const out: BusEta[] = [];
  for (const t of tracks.values()) {
    const route = catalog.routes.get(t.key);
    const passes = trip.byKey.get(t.key);
    if (!route || !passes) continue;
    const sp = speedFor(t, tracks, cfg);
    let best: { e: PassEta; i: number } | undefined;
    passes.forEach((pass, i) => {
      for (const s of t.ambiguous && t.alt !== undefined ? [t.lastRaw, t.alt] : [t.lastRaw]) {
        const e = etaForPass(t, pass, route.path, sp, now, cfg, s);
        if (e && (!best || e.early < best.e.early)) best = { e, i };
      }
    });
    if (!best) continue;
    const { e, i } = best;
    const span = (t.samples.at(-1)!.t - t.samples[0].t) / 1000;
    const low = t.ghost || t.ambiguous || e.wrap || t.dwell || t.stalled;
    const flags: BusEta["flags"] = {};
    if (e.atStop) flags.atStop = true;
    if (e.wrap) flags.wrap = true;
    if (t.dwell) flags.dwell = true;
    if (t.ghost) flags.ghost = true;
    if (t.ambiguous) flags.ambiguous = true;
    if (t.stalled) flags.stalled = true;
    out.push({
      busId: t.id, key: t.key, line: t.line, lngLat: t.lngLat, pass: i,
      earlyAt: now + e.early * 1000, likelyAt: now + e.likely * 1000, lateAt: now + e.late * 1000,
      distanceM: e.distanceM,
      confidence: low ? "low" : sp.source === "bus" && span >= cfg.PEER_MIN_SPAN_S ? "high" : "medium",
      flags,
    });
  }
  return out.sort((a, b) => a.earlyAt - b.earlyAt);
}

/** La última vez que un bus del viaje pasó por la parada (ms), para "el último pasó hace N min". */
export function lastCrossing(tracks: Tracks): number | undefined {
  let at: number | undefined;
  for (const t of tracks.values()) for (const c of t.crossed.values()) at = Math.max(at ?? c, c);
  return at;
}

/**
 * Suaviza las llegadas entre consultas (media exponencial) para que "Salí en X" no salte con cada reporte. Un cambio
 * muy grande se toma tal cual: el bus se destrabó o cambió de situación. Lo más temprano nunca queda después de lo
 * recién estimado (ni lo más tarde antes): suavizar no puede hacer perder el colectivo.
 */
export function smoothEtas(prev: ReadonlyMap<string, BusEta>, next: BusEta[], cfg: DepartureConfig = CFG): { list: BusEta[]; byId: Map<string, BusEta> } {
  const byId = new Map<string, BusEta>();
  const a = cfg.EMA_ALPHA, reset = cfg.EMA_RESET_S * 1000;
  const list = next.map((e) => {
    const id = `${e.busId}:${e.pass}`;
    const p = prev.get(id);
    const mix = (n: number, o: number | undefined) => (o === undefined || Math.abs(n - o) > reset ? n : a * n + (1 - a) * o);
    const s = p ? { ...e, earlyAt: Math.min(e.earlyAt, mix(e.earlyAt, p.earlyAt)), likelyAt: mix(e.likelyAt, p.likelyAt), lateAt: Math.max(e.lateAt, mix(e.lateAt, p.lateAt)) } : e;
    byId.set(id, s);
    return s;
  });
  return { list: list.sort((x, y) => x.earlyAt - y.earlyAt), byId };
}

export type AdviceState = "loading" | "no-data" | "none" | "leave-in" | "leave-now" | "hurry" | "far";

export interface Advice {
  state: AdviceState;
  /** Hace rato que no llegan datos nuevos (se sigue estimando). */
  stale: boolean;
  /** Minutos hasta salir (`leave-in`), o hasta salir para el siguiente (`hurry`). */
  leaveInMin?: number;
  target?: BusEta;
  /** Los que ya no se alcanzan. */
  missed: BusEta[];
  /** Los siguientes, con cuándo salir para cada uno. */
  later: (BusEta & { leaveInMin: number })[];
  lastPassedAgoMin?: number;
}

export interface AdviceInput {
  now: number;
  walkS: number;
  marginS: number;
  /** Segundos desde la última respuesta de /api/buses; `null`: todavía no llegó ninguna. */
  feedAgeS: number | null;
  lastPassedAt?: number;
}

/**
 * Qué hacer: salir en X minutos, salir ya, salir ya y quizá alcanzarlo, o que no viene ninguno. Se calcula con la
 * llegada más temprana del rango menos la caminata y el margen.
 */
export function advise(list: BusEta[], { now, walkS, marginS, feedAgeS, lastPassedAt }: AdviceInput, cfg: DepartureConfig = CFG): Advice {
  const lastPassedAgoMin = lastPassedAt !== undefined && now - lastPassedAt < 20 * 60_000 ? Math.max(0, Math.floor((now - lastPassedAt) / 60_000)) : undefined;
  const base = { stale: feedAgeS !== null && feedAgeS > cfg.STALE_FEED_S, missed: [] as BusEta[], later: [] as Advice["later"], ...(lastPassedAgoMin === undefined ? {} : { lastPassedAgoMin }) };
  if (feedAgeS === null) return { ...base, state: "loading" };
  if (feedAgeS > cfg.DEAD_FEED_S) return { ...base, state: "no-data" };
  const leaveIn = (e: BusEta) => (e.earlyAt - now) / 1000 - walkS - marginS;
  const missed: BusEta[] = [];
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e.flags.atStop && walkS > 60) {
      missed.push(e);
      continue;
    }
    const early = leaveIn(e);
    const lateLeave = (e.lateAt - now) / 1000 - walkS;
    const rest = list.slice(i + 1).filter((x) => leaveIn(x) >= 0);
    const later = rest.slice(0, 2).map((x) => ({ ...x, leaveInMin: Math.floor(leaveIn(x) / 60) }));
    if (early >= 60) {
      const state: AdviceState = (e.earlyAt - now) / 60_000 > cfg.FAR_MIN ? "far" : "leave-in";
      return { ...base, state, leaveInMin: Math.floor(early / 60), target: e, missed, later };
    }
    if (early >= -60) return { ...base, state: "leave-now", target: e, missed, later };
    if (lateLeave >= 0) return { ...base, state: "hurry", target: e, missed, later, ...(later[0] ? { leaveInMin: later[0].leaveInMin } : {}) };
    missed.push(e);
  }
  return { ...base, state: "none", missed };
}

/** Minutos caminando de `from` a `to` a `paceKmh`, con el rodeo de las calles. */
export function walkMinutes(from: LngLat, to: LngLat, paceKmh: number, cfg: DepartureConfig = CFG): number {
  const m = distanceM(from, to) * cfg.WALK_DETOUR;
  return Math.max(1, Math.ceil(m / ((paceKmh * 1000) / 60)));
}

/** Lo que tarda de verdad: la mediana de las últimas caminatas medidas. */
export function medianWalk(samplesMin: number[]): number | undefined {
  const last = samplesMin.filter((x) => Number.isFinite(x) && x > 0).slice(-5);
  return last.length ? Math.round(median(last)) : undefined;
}
