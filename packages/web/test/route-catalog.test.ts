import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearCatalog, loadCatalog } from "../src/lib/client/route-catalog";
import { catalogFile } from "./transit-fixtures";

const NOW = Date.parse("2026-10-12T21:00:00Z");
const HOUR = 3_600_000;
const ok = (version: string) => vi.fn(async () => new Response(JSON.stringify(catalogFile(version))));
const offline = () => vi.fn(async () => {
  throw new TypeError("Failed to fetch");
});

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
});

describe("catálogo de recorridos en el teléfono", () => {
  it("lo baja entero una vez por día, sin cookies, y lo guarda", async () => {
    const f = ok("v1");
    const first = await loadCatalog({ now: NOW, fetch: f as unknown as typeof fetch });
    expect(first).toMatchObject({ fetchedAt: NOW, stale: false });
    expect(first.catalog?.routes.size).toBe(2);
    expect(f).toHaveBeenCalledWith("/api/buses/routes", { credentials: "omit", referrerPolicy: "no-referrer" });

    const again = await loadCatalog({ now: NOW + 23 * HOUR, fetch: f as unknown as typeof fetch });
    expect(again.catalog?.version).toBe("v1");
    expect(f).toHaveBeenCalledTimes(1);

    const next = ok("v2");
    expect((await loadCatalog({ now: NOW + 25 * HOUR, fetch: next as unknown as typeof fetch })).catalog?.version).toBe("v2");
  });

  it("sin conexión usa la última copia, y sin copia no hay catálogo", async () => {
    expect(await loadCatalog({ now: NOW, fetch: offline() as unknown as typeof fetch })).toEqual({ catalog: null, fetchedAt: null, stale: true });
    await loadCatalog({ now: NOW, fetch: ok("v1") as unknown as typeof fetch });
    const old = await loadCatalog({ now: NOW + 48 * HOUR, fetch: offline() as unknown as typeof fetch });
    expect(old).toMatchObject({ fetchedAt: NOW, stale: true });
    expect(old.catalog?.version).toBe("v1");
  });

  it("una copia guardada que no se puede armar se descarta y se baja de nuevo", async () => {
    await loadCatalog({ now: NOW, fetch: ok("v1") as unknown as typeof fetch });
    // Una copia de un formato viejo: los recorridos no tienen geometría.
    const db = await new Promise<IDBDatabase>((r) => { const q = indexedDB.open("rc-transit", 1); q.onsuccess = () => r(q.result); });
    await new Promise((r) => { const t = db.transaction("catalog", "readwrite"); t.objectStore("catalog").put({ file: { type: "FeatureCollection", version: "v0", features: [{ properties: {} }] }, fetchedAt: NOW }, "current"); t.oncomplete = r; });
    db.close();
    const f = ok("v2");
    const l = await loadCatalog({ now: NOW + 1000, fetch: f as unknown as typeof fetch });
    expect(f).toHaveBeenCalledTimes(1);
    expect(l.catalog?.version).toBe("v2");
  });

  it("descarta una respuesta que no es un catálogo y se puede borrar", async () => {
    const bad = vi.fn(async () => new Response(JSON.stringify({ hola: 1 })));
    expect((await loadCatalog({ now: NOW, fetch: bad as unknown as typeof fetch })).catalog).toBeNull();
    await loadCatalog({ now: NOW, fetch: ok("v1") as unknown as typeof fetch });
    await clearCatalog();
    expect((await loadCatalog({ now: NOW, fetch: offline() as unknown as typeof fetch })).catalog).toBeNull();
  });
});
