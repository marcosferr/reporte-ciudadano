import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildCatalog, stopOptions, STOP_CFG } from "@rc/core/bus-catalog";
import { clearTrips, deleteTrip, getSelectedTrip, getTrips, newTrip, saveTrip, setSelectedTrip, TRIPS_KEY, updateTrip, withMeasuredWalk } from "../src/lib/client/trips";
import { effectiveWalk, measureWalk, type Fix } from "../src/lib/client/walk";
import { at, catalogFile, memoryStorage } from "./transit-fixtures";

const catalog = buildCatalog(catalogFile());
const stop = at(2000, 0);
const walk = { mode: "auto" as const, minutes: 6, paceKmh: 4.5, samples: [] as number[] };
const make = () => newTrip({ name: "Al trabajo", stop, options: stopOptions(catalog, stop).filter((o) => o.line === "41"), radiusM: STOP_CFG.STOP_RADIUS_M, walk, marginMin: 2 }, catalog);

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

describe("viajes guardados", () => {
  it("guarda la parada, las líneas y los minutos, nunca de dónde sale", () => {
    const t = make();
    expect(t.passes.map((p) => p.key)).toEqual(["22:00a1"]);
    saveTrip(t);
    saveTrip({ ...t, name: "Al centro" });
    expect(getTrips()).toEqual([{ ...t, name: "Al centro" }]);
    const stored = JSON.parse(localStorage.getItem(TRIPS_KEY)!)[0];
    expect(Object.keys(stored).sort()).toEqual(["catalogVersion", "choices", "id", "marginMin", "name", "passes", "radiusM", "stop", "updatedAt", "v", "walk"]);
    expect(Object.keys(stored.walk).sort()).toEqual(["minutes", "mode", "paceKmh", "samples"]);
  });

  it("actualizar un viaje borrado no lo hace volver", () => {
    const t = make();
    saveTrip(t);
    updateTrip({ ...t, name: "Otro" });
    expect(getTrips()[0].name).toBe("Otro");
    deleteTrip(t.id);
    updateTrip({ ...t, name: "Fantasma" });
    expect(getTrips()).toEqual([]);
  });

  it("se borran de a una o todas, y sin almacenamiento no falla", () => {
    const a = make(), b = make();
    saveTrip(a);
    saveTrip(b);
    setSelectedTrip(b.id);
    deleteTrip(a.id);
    expect(getTrips().map((t) => t.id)).toEqual([b.id]);
    clearTrips();
    expect(getTrips()).toEqual([]);
    expect(getSelectedTrip()).toBeNull();
    expect(localStorage.length).toBe(0);
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("bloqueado"); }, setItem: () => { throw new Error("bloqueado"); }, removeItem: () => {} });
    expect(getTrips()).toEqual([]);
    expect(() => saveTrip(a)).not.toThrow();
  });
});

describe("tiempo hasta la parada", () => {
  const fix = (x: number, accuracy = 10): Fix => ({ lngLat: at(x, 0), accuracy, t: 0 });

  it("usa lo puesto a mano, lo medido desde el lugar de siempre o lo estimado desde donde está", () => {
    expect(effectiveWalk({ ...walk, mode: "manual" }, stop, fix(0))).toEqual({ minutes: 6, source: "manual" });
    // 500 m en línea recta: ~9 min estimados.
    expect(effectiveWalk(walk, stop, fix(1500))).toMatchObject({ minutes: 9, source: "here", distanceM: 650 });
    expect(effectiveWalk(walk, stop, null)).toEqual({ minutes: 6, source: "saved" });
    expect(effectiveWalk(walk, stop, fix(1500, 500))).toEqual({ minutes: 6, source: "saved" });
    expect(effectiveWalk(walk, stop, fix(1990))).toMatchObject({ minutes: 0, source: "at-stop" });
    const measured = { ...walk, mode: "measured" as const, samples: [11, 10, 12] };
    expect(effectiveWalk(measured, stop, fix(1500))).toMatchObject({ minutes: 11, source: "measured" });
    // Lejos del lugar de siempre manda lo estimado desde donde está.
    expect(effectiveWalk(measured, stop, fix(-1000))).toMatchObject({ source: "here" });
    expect(effectiveWalk(measured, stop, null)).toEqual({ minutes: 11, source: "measured" });
  });

  it("mide la caminata hasta llegar a la parada y guarda las últimas 5", () => {
    let emit: (f: Fix) => void = () => {};
    const unwatch = vi.fn();
    const done = vi.fn();
    measureWalk(stop, (cb) => ((emit = cb), unwatch), done, () => 0);
    emit({ ...fix(1000), t: 4 * 60_000 });
    expect(done).not.toHaveBeenCalled();
    emit({ ...fix(1985), t: 8.4 * 60_000 });
    expect(done).toHaveBeenCalledWith(8);
    expect(unwatch).toHaveBeenCalled();
    let t = make();
    for (const m of [9, 8, 10, 7, 8, 9]) t = withMeasuredWalk(t, m);
    expect(t.walk).toMatchObject({ mode: "measured", samples: [8, 10, 7, 8, 9] });
    expect(withMeasuredWalk({ ...t, walk: { ...t.walk, mode: "manual" } }, 5).walk.mode).toBe("manual");
  });

  it("si no llega en 30 min no anota nada", () => {
    vi.useFakeTimers();
    const done = vi.fn();
    measureWalk(stop, () => () => {}, done);
    vi.advanceTimersByTime(30 * 60_000);
    expect(done).toHaveBeenCalledWith(null);
    vi.useRealTimers();
  });
});
