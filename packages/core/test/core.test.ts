import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
