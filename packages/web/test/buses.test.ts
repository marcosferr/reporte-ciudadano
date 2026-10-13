import type { APIContext } from "astro";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BusFeature } from "../src/lib/server/buses";

const { getBusRoute, listBusRoutes } = vi.hoisted(() => ({ getBusRoute: vi.fn(), listBusRoutes: vi.fn() }));
vi.mock("@rc/core/bus-routes", () => ({ getBusRoute, listBusRoutes }));

// Cada test importa el módulo de nuevo: guarda en memoria la lista de empresas y los últimos buses.
async function load() {
  vi.resetModules();
  const route = await import("../src/pages/api/buses/route");
  const routes = await import("../src/pages/api/buses/routes");
  return { ...(await import("../src/lib/server/buses")), ...(await import("../src/pages/api/buses/index")), routeGet: route.GET, routesGet: routes.GET };
}

// /api/buses no lee nada del pedido; /api/buses/route solo la URL.
const ctx = {} as APIContext;
const routeRequest = (query: string) => ({ url: new URL(`https://ciudadano.test/api/buses/route?${query}`) }) as APIContext;
const NOW = Date.parse("2026-10-11T15:00:00Z");
const bus = (id: number, secondsAgo: number, extra: object = {}) => ({
  id_bus: id, latitude: -25.3, longitude: -57.6, rumbo: 90, velocidad: 20, route_id: "00d2", tiene_rampa: true, company_code: 22,
  fecha_hora: new Date(NOW - secondsAgo * 1000).toISOString(), linea_label: "41 - 1", eot_nombre: "1° DE DICIEMBRE SRL", ...extra,
});
const ok = (data: unknown[]) => new Response(JSON.stringify({ success: true, data }));

let routes: Record<string, () => Response | Promise<Response>>;
beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  routes = {};
  vi.stubGlobal("fetch", async (url: string) => {
    const path = url.replace("https://sistemas.mopc.gov.py/prototipo_vmt/api", "");
    const route = routes[path];
    if (!route) throw new Error(`fetch inesperado: ${path}`);
    return route();
  });
});

describe("colectivos en vivo", () => {
  it("deja afuera los buses que no reportan hace más de 2 minutos y los repetidos", async () => {
    const { liveBuses } = await load();
    const out = liveBuses([bus(1, 600), bus(2, 600), bus(1, 30), bus(1, 45), bus(3, 10, { latitude: null })], NOW);
    expect(out.map((f) => [f.properties.id, f.properties.at])).toEqual([[1, new Date(NOW - 30_000).toISOString()]]);
    expect(out[0]).toMatchObject({ geometry: { coordinates: [-57.6, -25.3] }, properties: { line: "41 - 1", speed: 20, companyCode: 22, route: "00d2", ramp: true } });
  });

  it("manda el rumbo calculado por el VMT solo si el bus se movió desde su reporte anterior", async () => {
    const { toFeature } = await load();
    const prev = { latitude: -25.3, longitude: -57.601, fecha_hora: new Date(NOW - 40_000).toISOString() };
    const feature = (extra: object) => toFeature(bus(1, 30, extra) as never).properties;
    expect(feature({ punto_anterior: prev, rumbo_calculado: 95, distancia_entre_puntos_m: 100 }).heading).toBe(95);
    // Detenido: el VMT manda 0 o ruido del GPS.
    expect(feature({ punto_anterior: prev, rumbo_calculado: 0, distancia_entre_puntos_m: 3 })).not.toHaveProperty("heading");
    // Sin punto anterior, rumbo_calculado viene en 0 o viejo.
    expect(feature({ punto_anterior: null, rumbo_calculado: 108 })).not.toHaveProperty("heading");
    expect(feature({})).not.toHaveProperty("heading");
  });

  it("junta los buses de todas las empresas aunque una no responda", async () => {
    routes["/empresas"] = () => ok([{ cod_catalogo: 22 }, { cod_catalogo: 44 }, { cod_catalogo: 8 }]);
    routes["/buses?cod_catalogo=22"] = () => ok([bus(1, 5)]);
    routes["/buses?cod_catalogo=44"] = () => ok([bus(2, 5)]);
    routes["/buses?cod_catalogo=8"] = () => new Response("", { status: 500 });
    const { GET } = await load();
    const res = await GET(ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=10");
    const body = (await res.json()) as { features: BusFeature[] };
    expect(body.features.map((f) => [f.properties.id, f.properties.companyCode])).toEqual([[1, 22], [2, 44]]);
  });

  it("si el prototipo no responde devuelve 502 y el siguiente pedido vuelve a intentar", async () => {
    routes["/empresas"] = () => new Response("", { status: 503 });
    const { GET } = await load();
    expect((await GET(ctx)).status).toBe(502);
    routes["/empresas"] = () => ok([{ cod_catalogo: 22 }]);
    routes["/buses?cod_catalogo=22"] = () => ok([bus(1, 5)]);
    expect((await GET(ctx)).status).toBe(200);
  });

  it("descarta un reporte con fecha ilegible y manda la hora en UTC", async () => {
    const { liveBuses } = await load();
    const out = liveBuses([bus(1, 5, { fecha_hora: "ayer" }), bus(2, 5, { fecha_hora: "2026-10-11T11:59:50-03:00" })], NOW);
    expect(out.map((f) => [f.properties.id, f.properties.at])).toEqual([[2, "2026-10-11T14:59:50.000Z"]]);
  });

  it("avisa qué empresas en servicio tiene atrasadas el VMT, en vez de dejarlas afuera sin decir nada", async () => {
    const { delayedCompanies } = await load();
    const rows = [
      // Empresa 22: todos sus buses con 15 min de atraso (el VMT está atrasado con ella).
      bus(1, 15 * 60), bus(2, 16 * 60),
      // Empresa 44: uno al día y otro apagado hace rato (normal).
      bus(3, 5, { company_code: 44 }), bus(4, 20 * 60, { company_code: 44 }),
      // Empresa 8: su último reporte es de hace dos horas (fuera de servicio, no atrasada).
      bus(5, 2 * 3600, { company_code: 8 }),
    ];
    expect(delayedCompanies(rows, NOW)).toEqual([
      { companyCode: 22, company: "1° DE DICIEMBRE SRL", buses: 2, lastAt: new Date(NOW - 15 * 60_000).toISOString() },
    ]);
    routes["/empresas"] = () => ok([{ cod_catalogo: 22 }, { cod_catalogo: 44 }]);
    routes["/buses?cod_catalogo=22"] = () => ok([bus(1, 15 * 60)]);
    routes["/buses?cod_catalogo=44"] = () => ok([bus(3, 5)]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { GET } = await load();
    const body = (await (await GET(ctx)).json()) as { features: BusFeature[]; delayed: { companyCode: number }[] };
    expect(body.features.map((f) => f.properties.id)).toEqual([3]);
    expect(body.delayed.map((d) => d.companyCode)).toEqual([22]);
  });

  it("un bus sin recorrido asignado no tiene route", async () => {
    const { liveBuses } = await load();
    expect(liveBuses([bus(1, 5, { route_id: "0000", linea_label: null })], NOW)[0].properties).toMatchObject({ route: null, line: null });
  });

  it("devuelve el recorrido guardado de un bus por empresa y ruta", async () => {
    const route = { type: "Feature", geometry: { type: "MultiLineString", coordinates: [[[-57.6, -25.3], [-57.61, -25.31]]] }, properties: { line: "41", direction: "ida", from: "LAMBARÉ", to: "ASUNCIÓN" } };
    getBusRoute.mockImplementation(async (company: number, hex: string) => (company === 22 && hex === "00D2" ? route : null));
    const { routeGet } = await load();
    const res = await routeGet(routeRequest("company=22&route=00D2"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=3600");
    expect(await res.json()).toEqual(route);
    expect((await routeGet(routeRequest("company=22&route=0abc"))).status).toBe(404);
  });

  it.each(["company=22", "company=x&route=00d2", "company=22&route=../x"])("rechaza %s con 400", async (query) => {
    const { routeGet } = await load();
    expect((await routeGet(routeRequest(query))).status).toBe(400);
  });
});

describe("catálogo de recorridos", () => {
  const feature = (hex: string, x = -57.6) => ({
    type: "Feature", geometry: { type: "LineString", coordinates: [[x, -25.3], [-57.61, -25.31]] },
    properties: { company: 22, companyName: "LINCE SRL", route: hex, line: "41", direction: "ida", from: "LAMBARÉ", to: "ASUNCIÓN" },
  });

  it("devuelve todos los recorridos con una versión, cacheables por una hora y armados una sola vez", async () => {
    listBusRoutes.mockReset().mockResolvedValue([feature("00d2"), feature("00d3")]);
    const { routesGet } = await load();
    const res = await routesGet(ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600, s-maxage=3600");
    const body = (await res.json()) as { version: string; features: unknown[] };
    expect(body.features).toHaveLength(2);
    expect(body.version).toMatch(/^[\w-]{12}$/);
    expect(res.headers.get("ETag")).toBe(`"${body.version}"`);
    await routesGet(ctx);
    expect(listBusRoutes).toHaveBeenCalledTimes(1);
  });

  it("la versión cambia si cambia un recorrido, y un error de la base no queda guardado", async () => {
    listBusRoutes.mockReset().mockResolvedValue([feature("00d2")]);
    const v1 = ((await (await (await load()).routesGet(ctx)).json()) as { version: string }).version;
    listBusRoutes.mockReset().mockResolvedValue([feature("00d2", -57.59)]);
    const v2 = ((await (await (await load()).routesGet(ctx)).json()) as { version: string }).version;
    expect(v2).not.toBe(v1);

    listBusRoutes.mockReset().mockRejectedValueOnce(new Error("sin base")).mockResolvedValue([feature("00d2")]);
    const { routesGet } = await load();
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await routesGet(ctx)).status).toBe(500);
    expect((await routesGet(ctx)).status).toBe(200);
  });
});
