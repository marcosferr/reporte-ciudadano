import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const ADMIN_URL = process.env.TEST_ADMIN_URL ?? "postgres://postgres:password@localhost:5433/postgres";
const TEST_DB = "reporte_test";
process.env.DATABASE_URL = ADMIN_URL.replace(/\/[^/]+$/, `/${TEST_DB}`);

const { sql, closeDb } = await import("../src/db");
const { runMigrations } = await import("../src/migrate");
const reports = await import("../src/reports");
const { reportTile } = await import("../src/tiles");
const stats = await import("../src/stats");
const { locate } = await import("../src/areas");
const { pendingPhotos, reservePhotos } = await import("../src/photos");
const { hit } = await import("../src/ratelimit");

const admin = { id: "admin-1", role: "admin" as const };
// Cuadrado alrededor del centro de Asunción.
const square = (lng: number, lat: number, d: number) =>
  `MULTIPOLYGON(((${lng - d} ${lat - d},${lng + d} ${lat - d},${lng + d} ${lat + d},${lng - d} ${lat + d},${lng - d} ${lat - d})))`;

beforeAll(async () => {
  const root = postgres(ADMIN_URL, { onnotice: () => {} });
  await root.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await root.unsafe(`CREATE DATABASE ${TEST_DB}`);
  await root.end();
  await runMigrations(sql(), path.join(__dirname, "../migrations"));
  const s = sql();
  const [dept] = await s`INSERT INTO admin_areas (level, name, slug, geom)
    VALUES (1, 'Asunción', 'asuncion', ST_GeomFromText(${square(-57.6, -25.3, 0.1)}, 4326)) RETURNING id`;
  await s`INSERT INTO admin_areas (level, name, slug, parent_id, geom)
    VALUES (2, 'Asunción', 'asuncion', ${dept.id}, ST_GeomFromText(${square(-57.6, -25.3, 0.05)}, 4326))`;
});

afterAll(async () => {
  await closeDb();
});

describe("reportes", () => {
  it("crea un reporte, asigna áreas y registra el evento inicial", async () => {
    const { report, anonToken } = await reports.createReport(
      { category: "bache", title: "Bache en la esquina", description: "", lat: -25.3, lng: -57.6, extra: {} },
      { ipHash: "x" },
    );
    expect(report.public_code).toMatch(/^PY-\d{4}-\d{6}$/);
    expect(report.dept_slug).toBe("asuncion");
    expect(report.district_slug).toBe("asuncion");
    expect(report.status).toBe("nuevo");
    expect(anonToken).toBeTruthy();
    expect(await reports.verifyAnonToken(report.id, anonToken!)).toBe(true);
    expect(await reports.verifyAnonToken(report.id, "otro")).toBe(false);
    const events = await reports.listEvents(report.id);
    expect(events.map((e) => e.type)).toEqual(["created"]);
    expect(reports.reportPath(report)).toBe(`/r/${report.public_code.toLowerCase()}-bache-en-la-esquina`);
    expect(reports.codeFromParam(`${report.public_code.toLowerCase()}-bache`)).toBe(report.public_code);
  });

  it("rechaza ubicaciones fuera del país y categorías cerradas", async () => {
    await expect(
      reports.createReport({ category: "bache", title: "Fuera de PY", description: "", lat: 40, lng: -3, extra: {} }, {}),
    ).rejects.toMatchObject({ code: "out_of_bounds" });
    await sql()`UPDATE categories SET active_from = now() + interval '1 day' WHERE slug = 'propaganda-electoral'`;
    await expect(
      reports.createReport({ category: "propaganda-electoral", title: "Cartel viejo", description: "", lat: -25.3, lng: -57.6, extra: {} }, {}),
    ).rejects.toMatchObject({ code: "category_closed" });
    await sql()`UPDATE categories SET active_from = NULL WHERE slug = 'propaganda-electoral'`;
  });

  it("guarda solo los campos extra definidos por la categoría", async () => {
    const { report } = await reports.createReport(
      { category: "propaganda-electoral", title: "Cartel viejo en la rotonda", description: "", lat: -25.3, lng: -57.6,
        extra: { partido: "Partido X", hack: "no" } },
      {},
    );
    expect(report.extra).toEqual({ partido: "Partido X" });
  });

  it("detecta duplicados cercanos de la misma categoría", async () => {
    await reports.createReport({ category: "raudal", title: "Raudal en la avenida", description: "", lat: -25.31, lng: -57.61, extra: {} }, {});
    const near = await reports.findNearbyDuplicates(-25.3101, -57.6101, "raudal");
    expect(near).toHaveLength(1);
    expect(near[0].distance_m).toBeLessThan(30);
    expect(await reports.findNearbyDuplicates(-25.32, -57.61, "raudal")).toHaveLength(0);
    expect(await reports.findNearbyDuplicates(-25.3101, -57.6101, "bache")).toHaveLength(0);
  });

  it("aplica el flujo de estados con línea de tiempo y fecha de resolución", async () => {
    const { report } = await reports.createReport(
      { category: "alumbrado", title: "Calle sin luz", description: "", lat: -25.29, lng: -57.59, extra: {} }, {});
    await reports.changeStatus(report.id, "en_proceso", admin, { note: "Cuadrilla asignada" });
    await expect(reports.changeStatus(report.id, "nuevo", admin)).rejects.toMatchObject({ code: "bad_transition" });
    const done = await reports.changeStatus(report.id, "resuelto", admin, { note: "Focos cambiados" });
    expect(done.resolved_at).toBeInstanceOf(Date);
    const reopened = await reports.changeStatus(report.id, "en_proceso", admin);
    expect(reopened.resolved_at).toBeNull();
    const events = await reports.listEvents(report.id);
    expect(events.filter((e) => e.type === "status_change").map((e) => e.to_status)).toEqual(["en_proceso", "resuelto", "en_proceso"]);
  });

  it("marca duplicados apuntando al original", async () => {
    const a = await reports.createReport({ category: "bache", title: "Pozo original", description: "", lat: -25.28, lng: -57.58, extra: {} }, {});
    const b = await reports.createReport({ category: "bache", title: "Pozo repetido", description: "", lat: -25.28, lng: -57.58, extra: {} }, {});
    await expect(reports.changeStatus(b.report.id, "duplicado", admin)).rejects.toMatchObject({ code: "missing_duplicate" });
    const dup = await reports.changeStatus(b.report.id, "duplicado", admin, { duplicateOf: a.report.public_code });
    expect(dup.duplicate_of).toBe(a.report.id);
  });

  it("cuenta confirmaciones una sola vez por persona", async () => {
    const { report } = await reports.createReport({ category: "ruido", title: "Ruido toda la noche", description: "", lat: -25.3, lng: -57.6, extra: {} }, {});
    expect(await reports.confirmReport(report.id, "v1")).toEqual({ added: true, count: 1 });
    expect(await reports.confirmReport(report.id, "v1")).toEqual({ added: false, count: 1 });
    expect(await reports.confirmReport(report.id, "v2")).toEqual({ added: true, count: 2 });
  });

  it("pasa a revisión tras varias denuncias y vuelve a publicarse", async () => {
    const { report } = await reports.createReport({ category: "otros", title: "Reporte dudoso", description: "", lat: -25.3, lng: -57.6, extra: {} }, {});
    for (const who of ["a:1", "u:b", "a:1", "a:3"]) await reports.flagReport(report.id, who, "falso");
    let r = await reports.getReportById(report.id);
    expect(r!.flags_count).toBe(3);
    expect(r!.visibility).toBe("pending");
    expect((await reports.listReports()).some((x) => x.id === report.id)).toBe(false);
    expect((await reports.flagQueue()).some((x) => x.report_id === report.id)).toBe(true);
    await reports.setVisibility(report.id, "published", admin, "Revisado");
    r = await reports.getReportById(report.id);
    expect(r!.visibility).toBe("published");
    expect((await reports.flagQueue()).some((x) => x.report_id === report.id)).toBe(false);
  });

  it("las denuncias solo anónimas no ocultan el reporte, pero quedan para moderar", async () => {
    const { report } = await reports.createReport({ category: "otros", title: "Reporte legítimo", description: "", lat: -25.3, lng: -57.6, extra: {} }, {});
    for (const who of ["a:1", "a:2", "a:3", "a:4"]) await reports.flagReport(report.id, who, "spam");
    expect((await reports.getReportById(report.id))!.visibility).toBe("published");
    expect((await reports.flagQueue()).some((x) => x.report_id === report.id)).toBe(true);
  });

  it("un reporte republicado necesita denuncias nuevas para volver a revisión", async () => {
    const { report } = await reports.createReport({ category: "otros", title: "Reporte revisado", description: "", lat: -25.3, lng: -57.6, extra: {} }, {});
    for (const who of ["u:1", "u:2", "u:3"]) await reports.flagReport(report.id, who, "falso");
    expect((await reports.getReportById(report.id))!.visibility).toBe("pending");
    await reports.setVisibility(report.id, "published", admin, "Revisado");
    await reports.flagReport(report.id, "u:4", "falso");
    expect((await reports.getReportById(report.id))!.visibility).toBe("published");
    for (const who of ["u:5", "a:6"]) await reports.flagReport(report.id, who, "falso");
    expect((await reports.getReportById(report.id))!.visibility).toBe("pending");
  });

  it("ocultar un reporte también lo saca de la cola de denuncias", async () => {
    const { report } = await reports.createReport({ category: "otros", title: "Reporte ofensivo", description: "", lat: -25.3, lng: -57.6, extra: {} }, {});
    await reports.flagReport(report.id, "u:1", "ofensivo");
    await reports.setVisibility(report.id, "hidden", admin, "Ofensivo");
    expect((await reports.flagQueue()).some((x) => x.report_id === report.id)).toBe(false);
  });

  it("filtra listados por categoría, estado, área y bbox", async () => {
    expect((await reports.listReports({ category: "raudal" })).every((r) => r.category_slug === "raudal")).toBe(true);
    expect((await reports.listReports({ status: "abiertos" })).every((r) => ["nuevo", "verificado", "en_proceso", "derivado"].includes(r.status))).toBe(true);
    expect((await reports.listReports({ deptSlug: "asuncion" })).length).toBeGreaterThan(0);
    expect(await reports.listReports({ bbox: [-50, -20, -49, -19] })).toHaveLength(0);
  });
});

describe("GIS", () => {
  it("genera tiles MVT con puntos y clusters", async () => {
    // Tile que contiene Asunción en z14 y z5.
    const tile = (z: number) => {
      const n = 2 ** z;
      const x = Math.floor(((-57.6 + 180) / 360) * n);
      const lat = (-25.3 * Math.PI) / 180;
      const y = Math.floor(((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n);
      return [z, x, y] as const;
    };
    const detail = await reportTile(...tile(14));
    expect(detail!.length).toBeGreaterThan(50);
    expect(detail!.toString("latin1")).toContain("reports");
    const clusters = await reportTile(...tile(5));
    expect(clusters!.toString("latin1")).toContain("clusters");
    expect(await reportTile(3, 99, 0)).toBeNull();
    expect(await reportTile(Number.NaN, 0, 0)).toBeNull();
    expect(await reportTile(3, 1.5, 0)).toBeNull();
  });

  it("ubica un punto en su departamento y distrito", async () => {
    const loc = await locate(-25.3, -57.6);
    expect(loc.dept?.slug).toBe("asuncion");
    expect(loc.district?.slug).toBe("asuncion");
  });

  it("calcula resumen, conteos por área, series y hotspots", async () => {
    const sum = await stats.summary();
    expect(sum.total).toBeGreaterThan(5);
    expect(sum.by_category.length).toBeGreaterThan(2);
    const byDept = await stats.countsByArea(1);
    expect(byDept[0]).toMatchObject({ slug: "asuncion" });
    const ts = await stats.timeseries({}, 4);
    expect(ts).toHaveLength(4);
    expect(ts.at(-1)!.created).toBeGreaterThan(0);
    const spots = await stats.hotspots({}, 2000, 3);
    expect(spots.length).toBeGreaterThan(0);
    const polygon = { type: "Polygon", coordinates: [[[-57.62, -25.32], [-57.6, -25.32], [-57.6, -25.3], [-57.62, -25.3], [-57.62, -25.32]]] };
    const inPoly = await stats.summary({ polygon });
    expect(inPoly.total).toBeGreaterThan(0);
    expect(inPoly.total).toBeLessThan(sum.total);
    const csv = await stats.exportCSV({ category: "raudal" });
    expect(csv.split("\n")[0]).toContain("codigo");
    const geo = (await stats.exportGeoJSON()) as { features: unknown[] };
    expect(geo.features.length).toBe(sum.total);
  });

  it("el CSV neutraliza fórmulas en los títulos y deja las coordenadas como números", async () => {
    await reports.createReport({ category: "vereda", title: '=HYPERLINK("http://x","clic")', description: "", lat: -25.3, lng: -57.6, extra: {} }, {});
    const line = (await stats.exportCSV({ category: "vereda" })).split("\n")[1];
    expect(line).toContain(`"'=HYPERLINK(""http://x"",""clic"")"`);
    expect(line).toMatch(/,-25\.3,-57\.6,/);
  });
});

describe("infra", () => {
  it("reserva como máximo 4 fotos por reporte", async () => {
    const { report } = await reports.createReport({ category: "bache", title: "Con fotos", description: "", lat: -25.3, lng: -57.6, extra: {} }, {});
    expect(await reservePhotos(report.id, 3)).toHaveLength(3);
    const more = await reservePhotos(report.id, 3);
    expect(more).toHaveLength(1);
    expect(more[0].s3_key_original).toMatch(new RegExp(`^uploads/${report.id}/`));
  });

  it("devuelve solo las reservas del reporte que siguen esperando su archivo", async () => {
    const { report } = await reports.createReport({ category: "bache", title: "Reintento tardío", description: "", lat: -25.3, lng: -57.6, extra: {} }, {});
    const { report: other } = await reports.createReport({ category: "bache", title: "Otro reporte", description: "", lat: -25.3, lng: -57.6, extra: {} }, {});
    const [uploaded, pending] = await reservePhotos(report.id, 2);
    const [foreign] = await reservePhotos(other.id, 1);
    await sql()`UPDATE report_photos SET status = 'approved' WHERE id = ${uploaded.id}`;
    const keys = [uploaded, pending, foreign].map((p) => p.s3_key_original);
    expect(await pendingPhotos(report.id, keys)).toEqual([{ id: pending.id, s3_key_original: pending.s3_key_original }]);
    expect(await pendingPhotos(report.id, keys, "resolution")).toEqual([]);
    expect(await pendingPhotos(report.id, [])).toEqual([]);
  });

  it("limita la tasa de acciones por clave", async () => {
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await hit("test-key", 3, 3600));
    expect(results).toEqual([true, true, true, false]);
  });
});

describe("categorías", () => {
  it("el admin crea una categoría nueva con slug y claves de campos extra derivadas", async () => {
    const { createCategory, listCategories } = await import("../src/categories");
    const c = await createCategory({
      name: "Obra abandonada", icon: "🏗️", color: "#AA5500", sort_order: 150,
      extra_fields: [{ label: "Empresa responsable" }],
    });
    expect(c).toMatchObject({ slug: "obra-abandonada", color: "#aa5500", accepting: true,
      extra_fields: [{ key: "empresa_responsable", label: "Empresa responsable", type: "text" }] });
    expect((await listCategories()).map((x) => x.slug)).toContain("obra-abandonada");

    const { report } = await reports.createReport(
      { category: "obra-abandonada", title: "Obra parada hace un año", description: "", lat: -25.3, lng: -57.6,
        extra: { empresa_responsable: "Constructora X", otro: "ignorado" } }, {});
    expect(report.extra).toEqual({ empresa_responsable: "Constructora X" });
  });

  it("rechaza slugs repetidos y datos inválidos", async () => {
    const { createCategory } = await import("../src/categories");
    await expect(createCategory({ name: "Bache", icon: "🕳️", color: "#000000" })).rejects.toMatchObject({ code: "category_exists" });
    await expect(createCategory({ name: "Color raro", icon: "x", color: "rojo" })).rejects.toThrow();
    await expect(createCategory({ name: "Campos dobles", icon: "x", color: "#000000",
      extra_fields: [{ label: "Calle" }, { label: "calle" }] })).rejects.toMatchObject({ code: "validation" });
  });

  it("edita una categoría sin cambiar el slug y conserva las claves de campos existentes", async () => {
    const { updateCategory } = await import("../src/categories");
    const c = await updateCategory("obra-abandonada", {
      name: "Obra abandonada o paralizada", icon: "🚧", color: "#123456",
      extra_fields: [{ key: "empresa_responsable", label: "Empresa" }, { label: "Monto" }],
    });
    expect(c).toMatchObject({ slug: "obra-abandonada", name: "Obra abandonada o paralizada", icon: "🚧",
      extra_fields: [{ key: "empresa_responsable", label: "Empresa" }, { key: "monto", label: "Monto" }] });
    await expect(updateCategory("no-existe", { name: "Nada", icon: "x", color: "#000000" })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("ciudad del usuario", () => {
  it("infiere la ciudad de los reportes, la guarda y la borra", async () => {
    const { getHome, setHome, clearHome } = await import("../src/users");
    expect(await getHome("sin-nada")).toBeUndefined();

    await reports.createReport({ category: "bache", title: "Bache frente a mi casa", description: "", lat: -25.3, lng: -57.6, extra: {} }, { userId: "vecina-1" });
    expect(await getHome("vecina-1")).toMatchObject({ source: "reportes", area: { level: 2, slug: "asuncion" } });

    const [d] = await sql()<{ id: number }[]>`SELECT id FROM admin_areas WHERE level = 2 AND slug = 'asuncion'`;
    const area = await setHome("vecina-1", d.id);
    expect(area.bbox).toHaveLength(4);
    expect(await getHome("vecina-1")).toMatchObject({ source: "elegida", area: { id: d.id } });

    await clearHome("vecina-1");
    expect((await getHome("vecina-1"))?.source).toBe("reportes");
  });

  it("solo acepta distritos", async () => {
    const { setHome } = await import("../src/users");
    const [dept] = await sql()<{ id: number }[]>`SELECT id FROM admin_areas WHERE level = 1 LIMIT 1`;
    await expect(setHome("vecina-2", dept.id)).rejects.toMatchObject({ code: "validation" });
    await expect(setHome("vecina-2", 999999)).rejects.toMatchObject({ code: "validation" });
  });
});

describe("recorridos de colectivos", () => {
  const VMT = "https://sistemas.mopc.gov.py/prototipo_vmt/api";
  const ok = (data: unknown[]) => new Response(JSON.stringify({ success: true, data }));
  const line = { type: "LineString", coordinates: [[-57.6, -25.3], [-57.61, -25.31]] };
  const itinerary = (hex: string, destino: string) => ({ ruta_hex: hex, ruta_linea: "41", sentido: "ida", origen: "LAMBARÉ", destino, vigente: true, geojson: line });
  const stubVmt = (routes: Record<string, () => Response | Promise<Response>>) =>
    vi.stubGlobal("fetch", async (url: string) => {
      const route = routes[url.replace(VMT, "")];
      if (!route) throw new Error(`fetch inesperado: ${url}`);
      return route();
    });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("guarda los recorridos del VMT y los devuelve por empresa y ruta", async () => {
    const { syncBusRoutes, getBusRoute } = await import("../src/bus-routes");
    stubVmt({
      "/empresas": () => ok([{ cod_catalogo: 22 }, { cod_catalogo: 44 }]),
      "/itinerarios?cod_catalogo=22": () => ok([itinerary("00D2", "ASUNCIÓN"), itinerary("00d3", "LAMBARÉ")]),
      "/itinerarios?cod_catalogo=44": () => ok([
        { ...itinerary("0100", "LUQUE"), ruta_linea: null, sentido: null },
        { ...itinerary("0101", "LUQUE"), geojson: null },
        // Ninguno de estos sirve para dibujar un recorrido.
        { ...itinerary("0102", "LUQUE"), vigente: false },
        { ...itinerary("0103", "LUQUE"), geojson: { type: "Point", coordinates: [-57.6, -25.3] } },
        { ...itinerary("0104", "LUQUE"), geojson: { type: "LineString", coordinates: [[-57.6, -25.3]] } },
        { ...itinerary("0105", "LUQUE"), geojson: { type: "MultiLineString", coordinates: [line.coordinates, [[-57.6, -25.3]]] } },
      ]),
    });
    const result = await syncBusRoutes();
    expect(result).toMatchObject({ routes: 3, failed: [], skipped: [] });
    // La foto cruda guarda todo lo que mandó el VMT, también lo que no se usa para el mapa.
    expect(result.snapshot.companies.map((c) => [c.code, c.status, c.itineraries?.length])).toEqual([[22, 200, 2], [44, 200, 6]]);
    expect(await getBusRoute(22, "00d2")).toEqual({
      type: "Feature",
      geometry: { type: "MultiLineString", coordinates: [line.coordinates] },
      properties: { line: "41", direction: "ida", from: "LAMBARÉ", to: "ASUNCIÓN" },
    });
    expect((await getBusRoute(22, "00D3"))?.properties.to).toBe("LAMBARÉ");
    expect(await getBusRoute(22, "0100")).toBeNull();
    expect(await getBusRoute(999, "00d2")).toBeNull();
    expect((await getBusRoute(44, "0100"))?.properties).toEqual({ line: null, direction: null, from: "LAMBARÉ", to: "LUQUE" });
    for (const hex of ["0101", "0102", "0103", "0104", "0105"]) expect(await getBusRoute(44, hex)).toBeNull();
  });

  it("una empresa que falla o vuelve vacía conserva sus recorridos; una que ya no está se borra", async () => {
    const { syncBusRoutes, getBusRoute } = await import("../src/bus-routes");
    stubVmt({
      "/empresas": () => ok([{ cod_catalogo: 22 }, { cod_catalogo: 8 }]),
      "/itinerarios?cod_catalogo=22": () => new Response("", { status: 503 }),
      "/itinerarios?cod_catalogo=8": () => ok([itinerary("0200", "CAPIATÁ")]),
    });
    expect(await syncBusRoutes()).toMatchObject({ routes: 1, failed: [22] });
    expect(await getBusRoute(22, "00d2")).not.toBeNull();
    expect(await getBusRoute(8, "0200")).not.toBeNull();
    expect(await getBusRoute(44, "0100")).toBeNull();

    stubVmt({
      "/empresas": () => ok([{ cod_catalogo: 22 }, { cod_catalogo: 8 }]),
      "/itinerarios?cod_catalogo=22": () => ok([]),
      "/itinerarios?cod_catalogo=8": () => ok([itinerary("0201", "CAPIATÁ")]),
    });
    await syncBusRoutes();
    expect(await getBusRoute(22, "00d2")).not.toBeNull();
    expect(await getBusRoute(8, "0200")).toBeNull();
    expect(await getBusRoute(8, "0201")).not.toBeNull();
  });

  it("pasado el plazo no pide más empresas y las que faltan conservan sus recorridos", async () => {
    const { syncBusRoutes, getBusRoute } = await import("../src/bus-routes");
    const slow = (r: Response) => new Promise<Response>((done) => setTimeout(() => done(r), 100));
    // Se piden de a 4: la quinta empresa recién se pide cuando termina alguna de las primeras, ya pasado el plazo.
    stubVmt({
      "/empresas": () => ok([1, 2, 3, 8, 22].map((cod_catalogo) => ({ cod_catalogo }))),
      "/itinerarios?cod_catalogo=1": () => slow(ok([itinerary("0001", "A")])),
      "/itinerarios?cod_catalogo=2": () => slow(ok([itinerary("0002", "B")])),
      "/itinerarios?cod_catalogo=3": () => slow(ok([itinerary("0003", "C")])),
      "/itinerarios?cod_catalogo=8": () => slow(ok([itinerary("0202", "CAPIATÁ")])),
    });
    expect(await syncBusRoutes({ deadline: Date.now() + 30 })).toMatchObject({ routes: 4, failed: [], skipped: [22] });
    expect(await getBusRoute(22, "00d2")).not.toBeNull();
    expect(await getBusRoute(8, "0202")).not.toBeNull();
  });

  it("si no llega ningún recorrido falla sin tocar los guardados", async () => {
    const { syncBusRoutes, getBusRoute } = await import("../src/bus-routes");
    stubVmt({ "/empresas": () => ok([{ cod_catalogo: 22 }]), "/itinerarios?cod_catalogo=22": () => new Response("", { status: 503 }) });
    await expect(syncBusRoutes()).rejects.toThrow("ningún recorrido");
    expect(await getBusRoute(22, "00d2")).not.toBeNull();
  });
});

describe("histórico del VMT", () => {
  const VMT = "https://sistemas.mopc.gov.py/prototipo_vmt/api";
  const NOW = new Date("2026-10-11T15:00:00Z");
  const ok = (data: unknown[]) => new Response(JSON.stringify({ success: true, data }));
  const bus = (id: number, reportedAt: string, extra: object = {}) => ({
    id_bus: id, latitude: -25.3, longitude: -57.6, rumbo: 270, velocidad: 20, fecha_hora: reportedAt, route_id: "00D2",
    linea_label: "41 - 1", eot_nombre: "1° DE DICIEMBRE SRL", tiene_rampa: true, driver_id: "00", ...extra,
  });
  const stubVmt = (routes: Record<string, () => Response>) =>
    vi.stubGlobal("fetch", async (url: string) => {
      const route = routes[url.replace(VMT, "")];
      if (!route) throw new TypeError("fetch failed");
      return route();
    });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("arma las claves con la fecha y hora de Paraguay", async () => {
    const h = await import("../src/vmt-history");
    // 02:30 UTC del 12 son las 23:30 del 11 en Paraguay.
    expect(h.rawBusesKey(new Date("2026-10-12T02:30:00Z"))).toBe("vmt/raw/buses/date=2026-10-11/233000.json.gz");
    expect(h.rawItinerariesKey(new Date("2026-10-12T02:30:00Z"))).toBe("vmt/raw/itineraries/date=2026-10-11.json.gz");
    expect(h.positionsKey("2026-10-11")).toBe("vmt/positions/date=2026-10-11/positions.parquet");
    expect(h.dayBounds("2026-10-11").map((d) => d.toISOString())).toEqual(["2026-10-11T03:00:00.000Z", "2026-10-12T03:00:00.000Z"]);
    expect(h.addDays("2026-12-31", 1)).toBe("2027-01-01");
    const keys = ["date=2026-10-10/235901", "date=2026-10-11/000002", "date=2026-10-11/235958", "date=2026-10-12/001459", "date=2026-10-12/001500"]
      .map((k) => `vmt/raw/buses/${k}.json.gz`);
    expect(h.pollKeysForDay("2026-10-11", keys).map((k) => k.slice(14, 36))).toEqual(["date=2026-10-11/000002", "date=2026-10-11/235958", "date=2026-10-12/001459"]);
  });

  it("guarda cómo respondió cada empresa, sin driver_id", async () => {
    const { collectBuses, savePoll } = await import("../src/vmt-history");
    const ago = (s: number) => new Date(NOW.getTime() - s * 1000).toISOString();
    stubVmt({
      "/empresas": () => ok([{ cod_catalogo: 22 }, { cod_catalogo: 8 }]),
      "/buses?cod_catalogo=22": () => ok([bus(1, ago(30)), bus(2, ago(200))]),
      "/buses?cod_catalogo=8": () => new Response("", { status: 503 }),
    });
    const poll = await collectBuses(NOW);
    expect(poll.companies.map((c) => [c.code, c.status, c.buses?.length])).toEqual([[8, 503, undefined], [22, 200, 2]]);
    expect(poll.companies[1].buses![0]).not.toHaveProperty("driver_id");
    expect(await savePoll(poll)).toBe(2);
    const rows = await sql()`SELECT company_code, http_status, buses, fresh_buses, median_age_s, error FROM vmt_polls WHERE polled_at = ${NOW} ORDER BY company_code`;
    expect(rows).toEqual([
      { company_code: 8, http_status: 503, buses: null, fresh_buses: null, median_age_s: null, error: "VMT /buses?cod_catalogo=8: HTTP 503" },
      { company_code: 22, http_status: 200, buses: 2, fresh_buses: 1, median_age_s: 115, error: null },
    ]);
  });

  it("si el VMT no devuelve ni la lista de empresas, registra la caída de las conocidas", async () => {
    const { collectBuses, savePoll } = await import("../src/vmt-history");
    stubVmt({});
    const at = new Date(NOW.getTime() + 60_000);
    const poll = await collectBuses(at);
    expect(poll.companies.map((c) => c.code)).toEqual(expect.arrayContaining([8, 22]));
    expect(poll.companies.every((c) => c.status === null && c.error?.includes("/empresas"))).toBe(true);
    await savePoll(poll);
    const [{ n }] = await sql()`SELECT count(*)::int AS n FROM vmt_polls WHERE polled_at = ${at} AND http_status IS NULL`;
    expect(n).toBe(poll.companies.length);
  });

  it("compacta un día: un reporte por fila, del día de Paraguay, y su actividad por hora", async () => {
    const { DayCompactor, saveRouteActivity } = await import("../src/vmt-history");
    const { parquetReadObjects } = await import("hyparquet");
    const moving = { punto_anterior: { latitude: -25.3, longitude: -57.601, fecha_hora: "2026-10-11T11:59:20Z" }, rumbo_calculado: 90, velocidad_calculada: 22, distancia_entre_puntos_m: 100 };
    const poll = (polledAt: string, buses: object[]) => ({ polled_at: polledAt, companies: [{ code: 22, status: 200, latency_ms: 800, buses: buses as never[] }] });
    const day = new DayCompactor("2026-10-11");
    // En cualquier orden: el reporte del bus 2 aparece en las dos consultas y vale la primera.
    day.add(poll("2026-10-11T12:01:00.000Z", [bus(1, "2026-10-11T12:00:40.000Z", { velocidad: 30 }), bus(2, "2026-10-11T11:58:00.000Z", { velocidad: 0, route_id: "0000", linea_label: null })]));
    day.add(poll("2026-10-11T12:00:00.000Z", [bus(1, "2026-10-11T11:59:30.000Z", moving), bus(2, "2026-10-11T11:58:00.000Z", { velocidad: 0, route_id: "0000", linea_label: null })]));
    // 23:58 del día anterior y 00:01 del siguiente (hora de Paraguay) quedan afuera; 23:59 del día entra.
    day.add(poll("2026-10-11T03:01:00.000Z", [bus(5, "2026-10-11T02:58:00.000Z")]));
    day.add(poll("2026-10-12T03:05:00.000Z", [bus(3, "2026-10-12T02:59:00.000Z", { latitude: -25.4 }), bus(4, "2026-10-12T03:01:00.000Z"), bus(6, "2026-10-11T12:00:00.000Z", { latitude: null })]));
    expect(day.size).toBe(4);

    const rows = await parquetReadObjects({ file: day.parquet() });
    expect(rows.map((r) => [r.bus_id, new Date(r.reported_at as Date).toISOString()])).toEqual([
      [1, "2026-10-11T11:59:30.000Z"], [1, "2026-10-11T12:00:40.000Z"], [2, "2026-10-11T11:58:00.000Z"], [3, "2026-10-12T02:59:00.000Z"],
    ]);
    expect(rows[0]).toMatchObject({ company_code: 22, route_hex: "00d2", line: "41 - 1", speed: 20, heading: 270, calc_heading: 90, calc_speed: 22, prev_distance_m: 100, ramp: true });
    expect(rows[1]).toMatchObject({ calc_heading: null, calc_speed: null });
    expect(rows[2]).toMatchObject({ route_hex: "0000", line: null });
    expect(new Date(rows[2].seen_at as Date).toISOString()).toBe("2026-10-11T12:00:00.000Z");
    expect(Object.keys(rows[0])).not.toContain("driver_id");

    const activity = day.activity();
    expect(activity.map((a) => [a.hour.toISOString(), a.route_hex, a.buses, a.moving_buses, a.reports, a.avg_speed])).toEqual([
      ["2026-10-11T11:00:00.000Z", "0000", 1, 0, 1, null],
      ["2026-10-11T11:00:00.000Z", "00d2", 1, 1, 1, 20],
      ["2026-10-11T12:00:00.000Z", "00d2", 1, 1, 1, 30],
      ["2026-10-12T02:00:00.000Z", "00d2", 1, 1, 1, 20],
    ]);
    // Volver a compactar el día reemplaza su actividad en vez de duplicarla.
    await saveRouteActivity("2026-10-11", activity);
    await saveRouteActivity("2026-10-11", activity);
    const [{ n }] = await sql()`SELECT count(*)::int AS n FROM bus_route_activity`;
    expect(n).toBe(4);
  });
});
