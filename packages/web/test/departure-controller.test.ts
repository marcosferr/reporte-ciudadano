import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCatalog, stopOptions, STOP_CFG } from "@rc/core/bus-catalog";
import { createDepartureController, type ControllerDeps } from "../src/lib/client/departure-controller";
import { fetchLiveBuses } from "../src/lib/client/live-buses";
import { loadCatalog } from "../src/lib/client/route-catalog";
import { newTrip } from "../src/lib/client/trips";
import type { BusFeature } from "../src/lib/server/buses";
import { at, busFeature, catalogFile } from "./transit-fixtures";

// La parada está en x=2000 del 41 (10 km hacia el este). Caminata 5 min + 2 de margen.
const T0 = Date.parse("2026-10-12T10:00:00Z");
const stop = at(2000, 0);
const catalog = buildCatalog(catalogFile());
const trip = newTrip({ name: "Al trabajo", stop, options: stopOptions(catalog, stop).filter((o) => o.line === "41"), radiusM: STOP_CFG.STOP_RADIUS_M, walk: { mode: "manual", minutes: 5, paceKmh: 4.5, samples: [] }, marginMin: 2 }, catalog, T0);

let feed: () => BusFeature[];
let delayed: () => { companyCode: number; company: string; buses: number; lastAt: string }[];
const calls: { url: string; init: RequestInit | undefined }[] = [];
const doc = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });

function deps(): ControllerDeps & { notify: ReturnType<typeof vi.fn>; keepScreenOn: ReturnType<typeof vi.fn> } {
  // Las funciones de verdad del navegador (fetchLiveBuses, loadCatalog), con la red y el reloj simulados.
  return {
    fetchFeed: (signal) => fetchLiveBuses(signal),
    loadCatalog: (o) => loadCatalog(o),
    now: () => Date.now(),
    doc: doc as unknown as Document,
    notify: vi.fn(async () => true),
    keepScreenOn: vi.fn(async () => {}),
    saveTrip: vi.fn(),
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0, toFake: ["Date", "setInterval", "clearInterval"] });
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("navigator", { sendBeacon: vi.fn() });
  doc.visibilityState = "visible";
  calls.length = 0;
  feed = () => [];
  delayed = () => [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const headers = { Date: new Date().toUTCString() };
    if (url === "/api/buses/routes") return new Response(JSON.stringify(catalogFile()), { headers });
    if (url === "/api/buses") return new Response(JSON.stringify({ type: "FeatureCollection", features: feed(), delayed: delayed() }), { headers });
    throw new Error(`fetch inesperado: ${url}`);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Espera a que terminen los pedidos simulados (IndexedDB y fetch van con temporizadores reales). */
const settle = () => new Promise((r) => setTimeout(r, 30));

async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

describe("¿Cuándo salgo? en el navegador", () => {
  it("dice cuándo salir a medida que el colectivo se acerca, sin que la cuenta vuelva para atrás", async () => {
    // El bus avanza 50 m cada 10 s (18 km/h) desde x=-3000: le faltan 5 km.
    feed = () => [busFeature(1, -3000 + ((Date.now() - T0) / 10_000) * 50, Date.now() - 5_000)];
    const ctrl = createDepartureController(trip, deps());
    await ctrl.start();
    await settle();
    const s = ctrl.getSnapshot();
    expect(s.catalog).toBe("ready");
    expect(s.buses).toHaveLength(1);
    expect(s.advice).toMatchObject({ state: "leave-in", target: { busId: 1 } });
    expect(s.advice.leaveInMin!).toBeGreaterThanOrEqual(3);
    const seen: number[] = [s.advice.leaveInMin!];
    for (let i = 0; i < 60 && ctrl.getSnapshot().advice.state === "leave-in"; i++) {
      await advance(10_000);
      const a = ctrl.getSnapshot().advice;
      if (a.state === "leave-in") seen.push(a.leaveInMin!);
    }
    expect(ctrl.getSnapshot().advice.state).toBe("leave-now");
    expect(seen).toEqual([...seen].sort((x, y) => y - x));
    expect(ctrl.getSnapshot().buses[0].confidence).toBe("high");
    ctrl.stop();
  });

  it("solo pide los dos datos públicos, sin cookies, Referer, query ni cuerpo", async () => {
    feed = () => [busFeature(1, 0, Date.now() - 5_000)];
    const ctrl = createDepartureController(trip, deps());
    await ctrl.start();
    ctrl.setFix({ lngLat: at(1500, 0), accuracy: 10, t: Date.now() });
    await advance(60_000);
    ctrl.arm(true);
    await advance(60_000);
    ctrl.stop();
    expect(new Set(calls.map((c) => c.url))).toEqual(new Set(["/api/buses/routes", "/api/buses"]));
    for (const c of calls) {
      expect(c.init?.credentials).toBe("omit");
      expect(c.init?.referrerPolicy).toBe("no-referrer");
      expect(c.init?.body).toBeUndefined();
      expect(c.init?.headers).toBeUndefined();
      expect(c.init?.method ?? "GET").toBe("GET");
    }
    expect(navigator.sendBeacon).not.toHaveBeenCalled();
  });

  it("con el aviso armado sigue en segundo plano, avisa una sola vez por bus y se desarma", async () => {
    // A 4 km y a 18 km/h: con 7 min entre caminata y margen, hay que salir en un par de minutos.
    feed = () => [busFeature(1, -2000 + ((Date.now() - T0) / 10_000) * 50, Date.now() - 5_000)];
    const d = deps();
    const ctrl = createDepartureController(trip, d);
    await ctrl.start();
    await settle();
    ctrl.arm(true);
    expect(d.keepScreenOn).toHaveBeenCalledWith(true);
    doc.visibilityState = "hidden";
    const before = calls.length;
    expect(d.notify).not.toHaveBeenCalled();
    for (let i = 0; i < 30 && !d.notify.mock.calls.length; i++) await advance(10_000);
    expect(calls.length).toBeGreaterThan(before);
    expect(d.notify).toHaveBeenCalledTimes(1);
    expect(d.notify.mock.calls[0][0]).toMatchObject({ title: "Salí ya para el 41", tag: "rc-departure" });
    expect(ctrl.getSnapshot().armed).toBe(false);
    // Desarmado y oculta: deja de consultar.
    const after = calls.length;
    await advance(60_000);
    expect(calls.length).toBe(after);
    expect(d.notify).toHaveBeenCalledTimes(1);
    ctrl.stop();
  });

  it("no avisa por un bus esperando en la terminal", async () => {
    feed = () => [busFeature(1, -4950, Date.now() - 5_000, { speed: 0 })];
    const short = { ...trip, walk: { ...trip.walk, minutes: 40 } };
    const d = deps();
    const ctrl = createDepartureController(short, d);
    await ctrl.start();
    await settle();
    ctrl.arm(true);
    await advance(30_000);
    expect(ctrl.getSnapshot().buses[0]).toMatchObject({ confidence: "low", flags: { dwell: true } });
    expect(d.notify).not.toHaveBeenCalled();
    ctrl.stop();
  });

  it("si cambió el catálogo, rearma el viaje y lo guarda", async () => {
    const d = deps();
    const old = { ...trip, catalogVersion: "v0" };
    const ctrl = createDepartureController(old, d);
    await ctrl.start();
    await settle();
    expect(d.saveTrip).toHaveBeenCalledWith(expect.objectContaining({ id: trip.id, catalogVersion: "v1" }));
    expect(ctrl.getSnapshot().tripStatus).toBe("same");
    ctrl.stop();
  });

  it("si el VMT está atrasado con la empresa de la línea, lo dice en vez de 'no hay colectivos'", async () => {
    delayed = () => [{ companyCode: 22, company: "LINCE SRL", buses: 3, lastAt: new Date(Date.now() - 15 * 60_000).toISOString() }];
    const ctrl = createDepartureController(trip, deps());
    await ctrl.start();
    await settle();
    expect(ctrl.getSnapshot()).toMatchObject({ delayedMin: 15, advice: { state: "none" } });
    // Otra empresa atrasada no es asunto de este viaje.
    delayed = () => [{ companyCode: 44, company: "VANGUARDIA SACI", buses: 3, lastAt: new Date(Date.now() - 15 * 60_000).toISOString() }];
    await advance(10_000);
    expect(ctrl.getSnapshot().delayedMin).toBeNull();
    ctrl.stop();
  });

  it("si se detiene mientras baja el catálogo, no guarda nada ni empieza a consultar", async () => {
    const d = deps();
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    d.loadCatalog = async () => {
      await slow;
      return { catalog: buildCatalog(catalogFile("v2")), fetchedAt: Date.now(), stale: false };
    };
    const ctrl = createDepartureController(trip, d);
    const started = ctrl.start();
    ctrl.stop();
    release();
    await started;
    await advance(30_000);
    expect(d.saveTrip).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("una edición hecha sobre el viaje viejo se rearma con el catálogo nuevo", async () => {
    const d = deps();
    const ctrl = createDepartureController(trip, d);
    await ctrl.start();
    await settle();
    ctrl.setTrip({ ...trip, catalogVersion: "v0", passes: [], marginMin: 4 });
    expect(ctrl.getSnapshot().trip).toMatchObject({ catalogVersion: "v1", marginMin: 4, passes: trip.passes });
    ctrl.stop();
  });
});

describe("pantalla prendida", () => {
  it("si se desarma mientras el navegador la concede, la suelta", async () => {
    vi.useRealTimers();
    const release = vi.fn(async () => {});
    let grant!: (s: unknown) => void;
    vi.stubGlobal("navigator", { wakeLock: { request: () => new Promise((r) => (grant = r)) } });
    vi.resetModules();
    const { keepScreenOn } = await import("../src/lib/client/departure-alert");
    const on = keepScreenOn(true);
    await keepScreenOn(false);
    grant({ released: false, release });
    await on;
    expect(release).toHaveBeenCalledTimes(1);
  });
});
