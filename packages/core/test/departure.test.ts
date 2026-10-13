import { describe, expect, it } from "vitest";
import { buildCatalog, passesNear, type Pass } from "../src/bus-catalog";
import { advise, CFG, etaForPass, etas, indexPasses, lastCrossing, medianWalk, smoothEtas, speedFor, trackBuses, walkMinutes, type BusEta, type BusTrack, type LiveBus, type Tracks } from "../src/departure";
import { at, file, route } from "./transit-fixtures";

const T0 = Date.parse("2026-10-12T10:00:00Z");
const S = 1000;
const DEFAULT_MPS = CFG.DEFAULT_KMH / 3.6;

// El 41 va 10 km hacia el este (de x=-5000 a x=5000); la parada está en x=2000, o sea s=7000.
const straight = route(22, "00a1", [[-5000, 0], [5000, 0]]);
// El 12 va y vuelve por la misma calle (3 km hacia el este por y=10, vuelve por y=-10) y cierra el circuito.
const loop = route(8, "0200", [[-3000, 10], [3000, 10], [3000, -10], [-3000, -10], [-3000, 10]], { line: "12", direction: "circular" });
const catalog = buildCatalog(file([straight, loop]));
const stopPass = (stop: [number, number], key: string): Pass[] => passesNear(catalog, at(...stop)).filter((p) => p.key === key).map(({ route: _, ...p }) => p);
const trip = indexPasses(stopPass([2000, 0], "22:00a1"));

const bus = (id: number, x: number, t: number, extra: Partial<LiveBus> = {}): LiveBus => ({
  id, companyCode: 22, route: "00a1", line: "41 - 1", coordinates: at(x, 5), at: t, heading: 90, speed: 20, ...extra,
});

/** Corre el seguimiento con una consulta por elemento de `feeds` (cada una a la hora de su primer bus o `now`). */
function run(feeds: { buses: LiveBus[]; now: number }[], index = trip, prev: Tracks = new Map()): Map<number, BusTrack> {
  let tracks = new Map(prev);
  for (const f of feeds) tracks = trackBuses(tracks, f.buses, catalog, index, f.now);
  return tracks;
}

describe("seguimiento de los buses", () => {
  it("ubica al bus sobre su recorrido y mide cuánto avanza", () => {
    const tracks = run([0, 60, 120, 180, 240].map((sec, i) => ({ buses: [bus(1, -2000 + i * 300, T0 + sec * S)], now: T0 + sec * S })));
    const t = tracks.get(1)!;
    expect(t.lastRaw).toBeCloseTo(4200, -1);
    expect(t.samples).toHaveLength(5);
    // 1200 m en 240 s = 5 m/s, mezclado con el valor por defecto según cuánto historial hay.
    const sp = speedFor(t, tracks);
    expect(sp.source).toBe("bus");
    expect(sp.v).toBeCloseTo(0.75 * 5 + 0.25 * DEFAULT_MPS, 2);
  });

  it("ignora el mismo reporte repetido y el ruido del GPS hacia atrás", () => {
    const tracks = run([
      { buses: [bus(1, 0, T0)], now: T0 },
      { buses: [bus(1, 0, T0)], now: T0 + 10 * S },
      { buses: [bus(1, -20, T0 + 20 * S)], now: T0 + 20 * S },
    ]);
    const t = tracks.get(1)!;
    expect(t.samples.map((x) => Math.round(x.s))).toEqual([5000, 5000]);
    expect(t.lastRaw).toBeCloseTo(5000, 0);
  });

  it("vuelve a empezar si el bus aparece muy atrás y espera confirmación ante un salto imposible", () => {
    const back = run([{ buses: [bus(1, 0, T0)], now: T0 }, { buses: [bus(1, -500, T0 + 30 * S)], now: T0 + 30 * S }]).get(1)!;
    expect(back.samples).toHaveLength(1);
    expect(back.lastRaw).toBeCloseTo(4500, 0);

    const jump = run([{ buses: [bus(1, -3000, T0)], now: T0 }, { buses: [bus(1, 0, T0 + 10 * S)], now: T0 + 10 * S }]);
    expect(jump.get(1)!.lastRaw).toBeCloseTo(2000, 0);
    expect(jump.get(1)!.pending).toBeDefined();
    const confirmed = run([{ buses: [bus(1, 100, T0 + 30 * S)], now: T0 + 30 * S }], trip, jump).get(1)!;
    expect(confirmed.pending).toBeUndefined();
    expect(confirmed.samples.map((x) => Math.round(x.s))).toEqual([5000, 5100]);
  });

  it("descarta buses fuera del recorrido, a contramano, sin recorrido o de recorridos que no son del viaje", () => {
    const tracks = run([{
      buses: [
        bus(1, 0, T0, { coordinates: at(0, 200) }),
        bus(2, 0, T0, { heading: 270 }),
        bus(3, 0, T0, { route: null }),
        bus(4, 0, T0, { route: "0fff" }),
        bus(5, 0, T0, { companyCode: 8, route: "0200" }),
        bus(6, 0, T0, { at: T0 + 10 * 60 * S }),
      ],
      now: T0,
    }]);
    expect([...tracks.keys()]).toEqual([]);
  });

  it("un bus que sale del recorrido se descarta a la tercera consulta", () => {
    let tracks = run([{ buses: [bus(1, 0, T0)], now: T0 }]);
    for (let i = 1; i <= 3; i++) tracks = run([{ buses: [bus(1, 0, T0 + i * 10 * S, { coordinates: at(0, 300) })], now: T0 + i * 10 * S }], trip, tracks);
    expect(tracks.has(1)).toBe(false);
  });

  it("en un recorrido que va y vuelve por la misma calle, el rumbo decide de qué lado está", () => {
    const loopTrip = indexPasses(stopPass([0, 0], "8:0200"));
    const loopBus = (heading?: number) => bus(1, 0, T0, { companyCode: 8, route: "0200", line: "12", coordinates: at(0, 0), heading });
    const east = run([{ buses: [loopBus(90)], now: T0 }], loopTrip).get(1)!;
    const west = run([{ buses: [loopBus(270)], now: T0 }], loopTrip).get(1)!;
    expect(east.lastRaw).toBeCloseTo(3000, -1);
    expect(west.lastRaw).toBeCloseTo(9020, -1);
    const unknown = run([{ buses: [loopBus(undefined)], now: T0 }], loopTrip).get(1)!;
    expect(unknown.ambiguous).toBe(true);
    expect(unknown.alt).toBeDefined();
  });

  it("un bus detenido al inicio del recorrido está esperando en la terminal", () => {
    const t = run([{ buses: [bus(1, -4950, T0, { speed: 0 })], now: T0 }]).get(1)!;
    expect(t.dwell).toBe(true);
    const moving = run([{ buses: [bus(1, -4950, T0, { speed: 25 })], now: T0 }]).get(1)!;
    expect(moving.dwell).toBe(false);
  });

  it("un bus que desaparece del VMT queda unos minutos como fantasma", () => {
    let tracks = run([{ buses: [bus(1, 0, T0)], now: T0 }]);
    tracks = run([{ buses: [], now: T0 + 60 * S }], trip, tracks);
    expect(tracks.get(1)?.ghost).toBe(true);
    tracks = run([{ buses: [], now: T0 + 200 * S }], trip, tracks);
    expect(tracks.has(1)).toBe(false);
  });

  it("registra cuándo pasó un bus por la parada", () => {
    const tracks = run([{ buses: [bus(1, 1900, T0)], now: T0 }, { buses: [bus(1, 2100, T0 + 40 * S)], now: T0 + 40 * S }]);
    expect(lastCrossing(tracks)).toBeCloseTo(T0 + 20 * S, -2);
  });
});

describe("velocidad", () => {
  it("un bus nuevo usa la mediana de los otros de la línea; sin ellos, el valor por defecto", () => {
    const feeds = [0, 60, 120, 180].map((sec) => ({
      buses: [bus(1, -4000 + sec * 4, T0 + sec * S), bus(2, -3000 + sec * 6, T0 + sec * S), ...(sec === 180 ? [bus(3, 0, T0 + sec * S)] : [])],
      now: T0 + sec * S,
    }));
    const tracks = run(feeds);
    const sp = speedFor(tracks.get(3)!, tracks);
    expect(sp.source).toBe("peers");
    expect(sp.v).toBeCloseTo(5, 1);
    const alone = run([{ buses: [bus(3, 0, T0)], now: T0 }]);
    expect(speedFor(alone.get(3)!, alone)).toEqual({ v: DEFAULT_MPS, prior: DEFAULT_MPS, source: "default", w: 0, priorSource: "default" });
  });
});

describe("llegada a la parada", () => {
  const one = (x: number, t = T0, extra: Partial<LiveBus> = {}) => run([{ buses: [bus(1, x, t, extra)], now: t }]);
  const pass = trip.byKey.get("22:00a1")![0];

  it("da un rango según la distancia y la velocidad", () => {
    const tracks = one(-1000);
    const e = etaForPass(tracks.get(1)!, pass, catalog.routes.get("22:00a1")!.path, speedFor(tracks.get(1)!, tracks), T0)!;
    const [fast, slow] = CFG.FACTORS.default;
    expect(e.distanceM).toBeCloseTo(3000, -1);
    expect(e.early).toBeCloseTo(3000 / (DEFAULT_MPS * fast) - CFG.LATENCY_EARLY_S, -1);
    expect(e.likely).toBeCloseTo(3000 / DEFAULT_MPS, -1);
    expect(e.late).toBeCloseTo(3000 / (DEFAULT_MPS * slow) + CFG.LATENCY_LATE_S, -1);
  });

  it("adelanta al bus según la edad de su reporte", () => {
    const tracks = one(-1000, T0 - 60 * S);
    const [eta] = etas(trip, catalog, tracks, T0);
    expect(eta.distanceM).toBeCloseTo(3000 - DEFAULT_MPS * 60, -1);
  });

  it("un bus en la parada llega ya; uno que ya pasó no cuenta", () => {
    expect(etas(trip, catalog, one(1980), T0)[0]).toMatchObject({ earlyAt: T0, flags: { atStop: true } });
    expect(etas(trip, catalog, one(2500), T0)).toEqual([]);
  });

  it("en un circular, el bus que ya pasó vuelve en la próxima vuelta", () => {
    const loopTrip = indexPasses(stopPass([0, 0], "8:0200").filter((p) => Math.abs(p.bearing - 90) < 30));
    const tracks = run([{ buses: [bus(1, 500, T0, { companyCode: 8, route: "0200", line: "12", coordinates: at(500, 10) })], now: T0 }], loopTrip);
    const [eta] = etas(loopTrip, catalog, tracks, T0);
    expect(eta.flags.wrap).toBe(true);
    expect(eta.confidence).toBe("low");
    expect(eta.distanceM).toBeCloseTo(catalog.routes.get("8:0200")!.path.length - 500, -2);
  });

  it("en un circular solo suma la vuelta si el bus pasa por el inicio del recorrido antes de llegar", () => {
    // Circuito de 12 km: 3 km al este por y=10, 20 m, 3 km al oeste por y=-10, 20 m. Parada en la vuelta, x=0 (s≈9020).
    const westTrip = indexPasses(stopPass([0, 0], "8:0200").filter((p) => Math.abs(p.bearing - 270) < 30));
    const loopBus = (x: number, y: number) => bus(1, x, T0, { companyCode: 8, route: "0200", line: "12", coordinates: at(x, y), heading: y > 0 ? 90 : 270 });
    // A más de media vuelta pero sin pasar por el inicio: no es "dar la vuelta" ni baja la confianza.
    const ahead = etas(westTrip, catalog, run([{ buses: [loopBus(-2500, 10)], now: T0 }], westTrip), T0)[0];
    expect(ahead.flags.wrap).toBeUndefined();
    expect(ahead.distanceM).toBeCloseTo(8520, -2);
    // Ya pasó la parada en la vuelta: tiene que llegar al inicio y dar otra vuelta.
    const passed = etas(westTrip, catalog, run([{ buses: [loopBus(-1000, -10)], now: T0 }], westTrip), T0)[0];
    expect(passed.flags.wrap).toBe(true);
    expect(passed.distanceM).toBeCloseTo(catalog.routes.get("8:0200")!.path.length - 1000, -2);
  });

  it("ordena por la llegada más temprana y baja la confianza de fantasmas y buses en la terminal", () => {
    const tracks = run([{ buses: [bus(1, -3000, T0), bus(2, 0, T0), bus(3, -4950, T0, { speed: 0 })], now: T0 }]);
    const list = etas(trip, catalog, tracks, T0);
    expect(list.map((e) => e.busId)).toEqual([2, 1, 3]);
    expect(list[2]).toMatchObject({ confidence: "low", flags: { dwell: true } });
    expect(list[0].confidence).toBe("medium");
  });
});

describe("consejo", () => {
  const eta = (busId: number, earlyMin: number, lateMin = earlyMin * 2, extra: Partial<BusEta> = {}): BusEta => ({
    busId, key: "22:00a1", line: "41", lngLat: at(0), pass: 0, earlyAt: T0 + earlyMin * 60 * S, likelyAt: T0 + earlyMin * 1.4 * 60 * S,
    lateAt: T0 + lateMin * 60 * S, distanceM: 1000, confidence: "medium", flags: {}, ...extra,
  });
  const base = { now: T0, walkS: 5 * 60, marginS: 2 * 60, feedAgeS: 5 };

  it("dice cuándo salir con la llegada más temprana menos la caminata y el margen", () => {
    const a = advise([eta(1, 12), eta(2, 25)], base);
    expect(a).toMatchObject({ state: "leave-in", leaveInMin: 5, target: { busId: 1 } });
    expect(a.later.map((x) => [x.busId, x.leaveInMin])).toEqual([[2, 18]]);
    expect(advise([eta(1, 7.5)], base).state).toBe("leave-now");
  });

  it("si no llega a este pero quizá sí, avisa y da el siguiente; si no llega, pasa al próximo", () => {
    expect(advise([eta(1, 4, 10), eta(2, 20)], base)).toMatchObject({ state: "hurry", target: { busId: 1 }, leaveInMin: 13 });
    const a = advise([eta(1, 2, 4), eta(2, 20)], base);
    expect(a).toMatchObject({ state: "leave-in", target: { busId: 2 }, leaveInMin: 13 });
    expect(a.missed.map((x) => x.busId)).toEqual([1]);
  });

  it("sin buses en camino, con datos viejos o lejos", () => {
    expect(advise([], { ...base, lastPassedAt: T0 - 4 * 60 * S })).toMatchObject({ state: "none", lastPassedAgoMin: 4 });
    expect(advise([eta(1, 12)], { ...base, feedAgeS: null }).state).toBe("loading");
    expect(advise([eta(1, 12)], { ...base, feedAgeS: 400 }).state).toBe("no-data");
    expect(advise([eta(1, 12)], { ...base, feedAgeS: 60 })).toMatchObject({ state: "leave-in", stale: true });
    expect(advise([eta(1, 60)], base).state).toBe("far");
  });

  it("un bus en la parada solo sirve si ya estás ahí", () => {
    const atStop = eta(1, 0, 1, { flags: { atStop: true } });
    expect(advise([atStop], base)).toMatchObject({ state: "none", missed: [atStop] });
    expect(advise([atStop], { ...base, walkS: 0, marginS: 0 })).toMatchObject({ state: "leave-now", target: atStop });
  });
});

describe("suavizado", () => {
  it("lo más temprano nunca queda después de lo recién estimado", () => {
    const e = (early: number): BusEta => ({ busId: 1, key: "k", line: null, lngLat: at(0), pass: 0, earlyAt: early, likelyAt: early, lateAt: early, distanceM: 0, confidence: "high", flags: {} });
    const first = smoothEtas(new Map(), [e(T0 + 600 * S)]);
    expect(smoothEtas(first.byId, [e(T0 + 400 * S)]).list[0]).toMatchObject({ earlyAt: T0 + 400 * S, lateAt: T0 + 500 * S });
  });

  it("promedia con la estimación anterior salvo un cambio grande", () => {
    const e = (early: number): BusEta => ({ busId: 1, key: "k", line: null, lngLat: at(0), pass: 0, earlyAt: early, likelyAt: early, lateAt: early, distanceM: 0, confidence: "high", flags: {} });
    const first = smoothEtas(new Map(), [e(T0 + 600 * S)]);
    expect(smoothEtas(first.byId, [e(T0 + 700 * S)]).list[0].earlyAt).toBe(T0 + 650 * S);
    expect(smoothEtas(first.byId, [e(T0 + 1300 * S)]).list[0].earlyAt).toBe(T0 + 1300 * S);
  });
});

describe("caminata hasta la parada", () => {
  it("estima con el rodeo de las calles y aprende de lo medido", () => {
    // 500 m en línea recta, 650 m por las calles: a 4,5 km/h (75 m/min) son 9 min.
    expect(walkMinutes(at(0), at(500), 4.5)).toBe(9);
    expect(walkMinutes(at(0), at(0), 4.5)).toBe(1);
    expect(medianWalk([20, 7, 8, 9, 6, 8])).toBe(8);
    expect(medianWalk([])).toBeUndefined();
  });
});
