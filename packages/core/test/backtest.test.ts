import { describe, expect, it } from "vitest";
import { parseClock, parseRow } from "../scripts/backtest/prepare-billetaje";
import { adviceStats, byHorizon, commercialSpeedByHour, crossingsAndBreaks, crossingTimes, DEFAULT_SIM, simulateStop, suggestFactors, type Position } from "../scripts/backtest/simulate";
import { buildCatalog } from "../src/bus-catalog";
import { at, file, route } from "./transit-fixtures";

// El 41 va 10 km hacia el este; la parada de prueba está en x=2000 (s=7000 m).
const catalog = buildCatalog(file([route(22, "00a1", [[-5000, 0], [5000, 0]])]));
const path = catalog.routes.get("22:00a1")!.path;
const DAY = Date.parse("2026-10-12T03:00:00Z"); // medianoche en Paraguay
const H = 3_600_000;

/** Un bus que sale del inicio a `startH` horas y va a `mps` constantes, reportando cada `everyS`. */
function trip(bus: number, startH: number, mps: number, everyS = 60): Position[] {
  const out: Position[] = [];
  const t0 = DAY + startH * H;
  for (let s = 0; s <= 10_000; s += mps * everyS) {
    const [lng, lat] = at(-5000 + s, 3);
    out.push({ bus, key: "22:00a1", t: t0 + (s / mps) * 1000, lng, lat, speed: mps * 3.6, heading: 90 });
  }
  return out;
}

describe("cuándo pasó de verdad", () => {
  it("interpola el cruce entre la posición de antes y la de después", () => {
    const [t] = crossingTimes(path, catalog.frame, trip(1, 5, 5), 7000, 5 * 60_000);
    expect(t).toBeCloseTo(DAY + 5 * H + 1400_000, -3);
  });

  it("si se cortó el seguimiento antes de la parada, no lo compara con el cruce de la vuelta siguiente", () => {
    // Primera vuelta con un hueco de 20 min justo antes de la parada; segunda vuelta completa.
    const lap1 = trip(1, 5, 5).filter((p) => p.t < DAY + 5 * H + 1000_000 || p.t > DAY + 5 * H + 2200_000);
    const lap2 = trip(1, 6, 5);
    const { crossings, breaks } = crossingsAndBreaks(path, catalog.frame, [...lap1, ...lap2], 7000, 5 * 60_000);
    expect(crossings).toHaveLength(1);
    expect(crossings[0]).toBeGreaterThan(DAY + 6 * H);
    expect(breaks.some((t) => t > DAY + 5 * H && t < crossings[0])).toBe(true);
  });

  it("no inventa un cruce si hay un hueco muy largo o el bus va para atrás", () => {
    const sparse = trip(1, 5, 5).filter((_, i) => i % 20 === 0);
    expect(crossingTimes(path, catalog.frame, sparse, 7000, 5 * 60_000)).toEqual([]);
    expect(crossingTimes(path, catalog.frame, [...trip(1, 5, 5)].reverse().map((p, i) => ({ ...p, t: DAY + i * 60_000 })), 7000, 5 * 60_000)).toEqual([]);
  });
});

describe("simulación de consultas", () => {
  // Un bus cada 15 min de 5 a 7 h, a 18 km/h constantes.
  const positions = Array.from({ length: 8 }, (_, i) => trip(i + 1, 5 + i / 4, 5)).flat();
  const opts = { ...DEFAULT_SIM, dayStarts: [DAY], fromMs: 5.25 * H, toMs: 7 * H };
  const result = simulateStop(catalog, { id: "p", key: "22:00a1", stop: at(2000, 0) }, positions, opts);

  it("compara cada llegada estimada con la real", () => {
    expect(result.etas.length).toBeGreaterThan(20);
    const [near] = byHorizon(result.etas);
    expect(near.n).toBeGreaterThan(0);
    // Con velocidad constante y la app abierta 5 min, el error es chico y el bus pasa dentro del rango.
    for (const b of byHorizon(result.etas).filter((x) => x.n)) {
      expect(b.p50AbsMin).toBeLessThan(3);
      expect(b.coverage).toBeGreaterThan(0.9);
    }
  });

  it("siguiendo el consejo no se pierde el colectivo", () => {
    for (const policy of ["aviso", "una-vez"] as const) {
      const stats = adviceStats(result.advice, opts.walksMin, policy);
      expect(stats.every((s) => s.missRate === 0)).toBe(true);
      expect(stats.filter((s) => s.walkMin <= 8).every((s) => s.n > 0)).toBe(true);
    }
  });

  it("sugiere factores y la velocidad comercial por hora", () => {
    const [fast, slow] = suggestFactors(result.etas, 0.05, 0.95, 10).bus!;
    // A velocidad constante, lo real coincide con lo probable (salvo el suavizado): los factores quedan cerca de 1.
    expect(Math.abs(fast - 1)).toBeLessThan(0.15);
    expect(Math.abs(slow - 1)).toBeLessThan(0.15);
    const speed = commercialSpeedByHour(catalog, positions, (t) => new Date(t - 3 * H).getUTCHours(), 5 * 60_000);
    expect(speed.map((s) => s.hour)).toEqual([5, 6, 7]);
    for (const s of speed) expect(s.kmh).toBeCloseTo(18, 0);
  });

  it("no compara llegadas que los datos no alcanzan a cubrir (si no, solo contarían los buses rápidos)", () => {
    const end = DAY + 6 * H;
    const cut = simulateStop(catalog, { id: "p", key: "22:00a1", stop: at(2000, 0) }, positions.filter((p) => p.t <= end), opts);
    expect(cut.etas.length).toBeGreaterThan(0);
    for (const e of cut.etas) expect(e.lateAt).toBeLessThanOrEqual(end);
  });

  it("no evalúa paradas por las que el recorrido pasa dos veces o ninguna", () => {
    expect(simulateStop(catalog, { id: "lejos", key: "22:00a1", stop: at(0, 500) }, positions, opts)).toEqual({ etas: [], advice: [] });
  });
});

describe("preparación del billetaje", () => {
  const col = Object.fromEntries(["serialtarjeta", "idsam", "fechahoraevento", "producto", "montoevento", "consecutivoevento", "identidad", "tipoevento", "latitude", "longitude", "idrutaestacion", "tipotransporte"].map((n, i) => [n, i]));
  const row = (over: Partial<Record<string, string>> = {}) => {
    const base: Record<string, string> = {
      serialtarjeta: '"d41d8cd98f00b204e9800998ecf8427e"', idsam: "0A1B2C", fechahoraevento: "2023-03-01 07:15:30.000", producto: "MO",
      montoevento: "2300", consecutivoevento: "15", identidad: "1", tipoevento: "4", latitude: "-25.30", longitude: "-57.60", idrutaestacion: "00D2", tipotransporte: "1",
    };
    return Object.keys(col).map((k) => over[k] ?? base[k]);
  };

  it("se queda con el validador, la hora, el lugar y el recorrido, nunca con la tarjeta", () => {
    const r = parseRow(row(), col);
    expect(r).toEqual({ idsam: "0A1B2C", t: Date.parse("2023-03-01T10:15:30Z"), day: "2023-03-01", lng: -57.6, lat: -25.3, route: "00d2" });
    expect(JSON.stringify(r)).not.toContain("d41d8cd9");
    expect(JSON.stringify(r)).not.toContain("2300");
  });

  it("acepta latitud y longitud en cualquier orden y descarta lo que no sirve", () => {
    expect(parseRow(row({ latitude: "-57.60", longitude: "-25.30" }), col)).toMatchObject({ lat: -25.3, lng: -57.6 });
    expect(parseRow(row({ tipoevento: "8" }), col)).toBe("evento");
    expect(parseRow(row({ latitude: "0", longitude: "0" }), col)).toBe("coordenadas");
    expect(parseRow(row({ fechahoraevento: "2022-10-02 10:00:00" }), col)).toBe("cambio de hora");
    expect(parseRow(row({ idrutaestacion: "" }), col)).toBe("recorrido");
  });

  it("entiende las fechas del billetaje como hora de reloj de Paraguay", () => {
    expect(parseClock("01/03/2023 07:15:30")).toEqual({ t: Date.parse("2023-03-01T10:15:30Z"), day: "2023-03-01" });
    expect(parseClock("ayer")).toBeNull();
  });
});
