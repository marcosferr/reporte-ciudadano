import { afterEach, describe, expect, it, vi } from "vitest";
import { bestOffset, clockOffsetFrom, fetchLiveBuses, startPolling, toLiveBus } from "../src/lib/client/live-buses";
import { busFeature } from "./transit-fixtures";

afterEach(() => {
  vi.useRealTimers();
});

describe("colectivos en vivo en el navegador", () => {
  it("pide /api/buses sin cookies ni Referer", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ features: [] }), { headers: { Date: new Date().toUTCString() } }));
    const feed = await fetchLiveBuses(undefined, f as unknown as typeof fetch);
    expect(feed?.features).toEqual([]);
    expect(f).toHaveBeenCalledWith("/api/buses", { credentials: "omit", referrerPolicy: "no-referrer", signal: undefined });
    const down = vi.fn(async () => new Response("", { status: 502 }));
    expect(await fetchLiveBuses(undefined, down as unknown as typeof fetch)).toBeNull();
  });

  it("mide cuánto adelanta el reloj del teléfono con la hora del servidor y la cache", () => {
    const server = Date.parse("2026-10-12T21:00:00Z");
    const headers = new Headers({ Date: new Date(server).toUTCString(), Age: "4" });
    // El teléfono está 5 min adelantado y la respuesta tardó 200 ms.
    const offset = clockOffsetFrom(headers, server + 4000 + 5 * 60_000 + 200)!;
    expect(offset).toBeCloseTo(5 * 60_000 - 300, -2);
    expect(clockOffsetFrom(new Headers(), Date.now())).toBeUndefined();
    expect(bestOffset([offset + 900, offset, offset + 300])).toBe(offset);
    expect(bestOffset([1200])).toBe(0);
    expect(bestOffset([-40 * 60_000])).toBe(-40 * 60_000);
    expect(bestOffset([])).toBe(0);
  });

  it("convierte un bus de /api/buses al formato del cálculo", () => {
    const at = Date.parse("2026-10-12T21:00:00Z");
    expect(toLiveBus(busFeature(7, 0, at))).toMatchObject({ id: 7, companyCode: 22, route: "00a1", line: "41 - 1", at, heading: 90, speed: 20 });
  });

  it("consulta cada 10 s solo con la página a la vista, salvo que se pida seguir", async () => {
    vi.useFakeTimers();
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
    const run = vi.fn(async () => {});
    let keep = false;
    const p = startPolling(run, { intervalMs: 10_000, keepWhenHidden: () => keep, doc: doc as unknown as Document });
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(2);
    doc.visibilityState = "hidden";
    await vi.advanceTimersByTimeAsync(30_000);
    expect(run).toHaveBeenCalledTimes(2);
    keep = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(3);
    keep = false;
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(run).toHaveBeenCalledTimes(4);
    p.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(run).toHaveBeenCalledTimes(4);
  });
});
