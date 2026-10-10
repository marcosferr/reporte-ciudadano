import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMyReports } from "../src/lib/client/my-reports";
import { discardOutbox, flushOutbox, listOutbox, newOutboxItem, queueReport } from "../src/lib/client/outbox";

// La cola corre en el navegador: acá IndexedDB es fake-indexeddb y la red, un fetch simulado por URL.
const S3 = "https://s3.test/bucket";
const upload = (key: string) => ({ url: S3, fields: { key } });
const photo = () => new Blob([new Uint8Array(2048)], { type: "image/jpeg" });
const data = (title: string) => ({ category: "bache", title, description: "", lat: -25.3, lng: -57.6, extra: {} });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const apiError = (status: number, code: string) => json({ error: { code, message: code } }, status);

type Handler = (body: any) => Response | Promise<Response>;
let routes: Record<string, Handler>;
const calls: { url: string; body: any }[] = [];

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("navigator", { onLine: true, locks: globalThis.navigator.locks });
  vi.stubGlobal("localStorage", memoryStorage());
  calls.length = 0;
  routes = {};
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    calls.push({ url, body });
    const route = routes[url];
    if (!route) throw new Error(`fetch inesperado: ${url}`);
    return route(body);
  });
});

/** POST /api/reports que crea `id` con un permiso por foto pedida. */
function created(id: string): Handler {
  return (body) => json({
    report: { id, code: `PY-2026-${id}`, path: `/r/${id}`, title: body.title },
    anonToken: `token-${id}`,
    uploads: Array.from({ length: body.photos }, (_, i) => upload(`uploads/${id}/${i}.jpg`)),
  }, 201);
}

const count = (url: string) => calls.filter((c) => c.url === url).length;

describe("cola sin conexión", () => {
  it("crea el reporte una sola vez y sube sus fotos", async () => {
    routes["/api/reports"] = created("r1");
    routes[S3] = () => new Response(null, { status: 204 });
    await queueReport(newOutboxItem(data("Bache"), [photo(), photo()]));
    await flushOutbox();
    expect(await listOutbox()).toEqual([]);
    expect(count("/api/reports")).toBe(1);
    expect(count(S3)).toBe(2);
  });

  it("si se corta en una foto, el reintento sube solo lo que falta sin volver a crear el reporte", async () => {
    routes["/api/reports"] = created("r1");
    let s3 = 0;
    routes[S3] = () => {
      if (++s3 === 2) throw new TypeError("Failed to fetch");
      return new Response(null, { status: 204 });
    };
    await queueReport(newOutboxItem(data("Bache"), [photo(), photo()]));
    await flushOutbox();
    const [stuck] = await listOutbox();
    expect(stuck).toMatchObject({ created: { id: "r1" }, uploaded: 1 });
    await flushOutbox();
    expect(await listOutbox()).toEqual([]);
    expect(count("/api/reports")).toBe(1);
  });

  it("una foto que S3 rechaza se deja de lado y no traba los reportes de atrás", async () => {
    let n = 0;
    routes["/api/reports"] = (body) => created(`r${++n}`)(body);
    routes[S3] = (form: FormData) => new Response(null, { status: form.get("key") === "uploads/r1/0.jpg" ? 400 : 204 });
    await queueReport(newOutboxItem(data("Primero"), [photo()]));
    await queueReport(newOutboxItem(data("Segundo"), [photo()]));
    await flushOutbox();
    expect(await listOutbox()).toEqual([]);
    expect(getMyReports().find((r) => r.id === "r1")?.photos_missing).toBe(1);
    expect(getMyReports().find((r) => r.id === "r2")?.photos_missing).toBeUndefined();
  });

  it("sin sesión el servidor pide captcha: ese ítem espera y los demás salen", async () => {
    let n = 0;
    routes["/api/reports"] = (body) => (++n === 1 ? apiError(400, "captcha") : created("r2")(body));
    await queueReport(newOutboxItem(data("Anónimo"), []));
    await queueReport(newOutboxItem(data("Otro"), []));
    await flushOutbox();
    const queue = await listOutbox();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ data: { title: "Anónimo" }, status: "captcha" });
    // Sin un captcha nuevo no se vuelve a intentar.
    await flushOutbox();
    expect(count("/api/reports")).toBe(2);
  });

  it("un 429 corta el envío y deja todo para la próxima", async () => {
    routes["/api/reports"] = () => apiError(429, "rate_limited");
    await queueReport(newOutboxItem(data("Uno"), []));
    await queueReport(newOutboxItem(data("Dos"), []));
    await flushOutbox();
    expect((await listOutbox()).map((i) => i.status)).toEqual(["pending", "pending"]);
    expect(count("/api/reports")).toBe(1);
  });

  it("con los permisos vencidos vuelve a firmar las mismas reservas en vez de pedir nuevas", async () => {
    routes["/api/reports/r1/photos"] = (body) => json({ uploads: body.renew.map(upload) });
    routes[S3] = () => new Response(null, { status: 204 });
    const item = newOutboxItem(data("Viejo"), [photo()]);
    Object.assign(item, {
      created: { id: "r1", code: "PY-2026-r1", path: "/r/r1", title: "Viejo", anonToken: "token-r1" },
      uploads: [upload("uploads/r1/0.jpg")], uploads_at: Date.now() - 60 * 60 * 1000,
    });
    await queueReport(item);
    await flushOutbox();
    expect(calls.find((c) => c.url === "/api/reports/r1/photos")?.body).toEqual({ renew: ["uploads/r1/0.jpg"], anonToken: "token-r1" });
    expect(await listOutbox()).toEqual([]);
  });

  it("un ítem descartado mientras sube una foto no vuelve a aparecer", async () => {
    routes["/api/reports"] = created("r1");
    let release!: () => void;
    routes[S3] = () => new Promise((resolve) => (release = () => resolve(new Response(null, { status: 204 }))));
    await queueReport(newOutboxItem(data("Bache"), [photo()]));
    const flushing = flushOutbox();
    await vi.waitFor(() => expect(count(S3)).toBe(1));
    const [item] = await listOutbox();
    await discardOutbox(item.id!);
    release();
    await flushing;
    expect(await listOutbox()).toEqual([]);
  });
});
