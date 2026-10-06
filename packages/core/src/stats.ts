import { sql } from "./db";

/** Ámbito de una consulta GIS: área administrativa, polígono dibujado, categoría y rango de fechas. */
export interface Scope {
  deptId?: number;
  districtId?: number;
  polygon?: object; // GeoJSON Polygon/MultiPolygon en 4326
  category?: string;
  from?: Date;
  to?: Date;
}

function where(scope: Scope) {
  const s = sql();
  const conds = [s`r.visibility = 'published'`];
  if (scope.deptId) conds.push(s`r.dept_id = ${scope.deptId}`);
  if (scope.districtId) conds.push(s`r.district_id = ${scope.districtId}`);
  if (scope.polygon)
    conds.push(s`ST_Intersects(r.geom, ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(scope.polygon)}), 4326))`);
  if (scope.category) conds.push(s`c.slug = ${scope.category}`);
  if (scope.from) conds.push(s`r.created_at >= ${scope.from}`);
  if (scope.to) conds.push(s`r.created_at < ${scope.to}`);
  return conds.reduce((acc, c) => s`${acc} AND ${c}`);
}

export interface Summary {
  total: number;
  open: number;
  resolved: number;
  resolution_rate: number;
  median_days_to_resolve: number | null;
  by_status: { status: string; n: number }[];
  by_category: { slug: string; name: string; icon: string; color: string; n: number; resolved: number }[];
}

export async function summary(scope: Scope = {}): Promise<Summary> {
  const s = sql();
  const w = where(scope);
  const [totals] = await s<{ total: number; open: number; resolved: number; median_days: number | null }[]>`
    SELECT count(*)::int AS total,
      count(*) FILTER (WHERE r.status IN ('nuevo','verificado','en_proceso','derivado'))::int AS open,
      count(*) FILTER (WHERE r.status = 'resuelto')::int AS resolved,
      (percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM r.resolved_at - r.created_at) / 86400)
        FILTER (WHERE r.resolved_at IS NOT NULL))::float8 AS median_days
    FROM reports r JOIN categories c ON c.id = r.category_id WHERE ${w}`;
  const by_status = await s<{ status: string; n: number }[]>`
    SELECT r.status::text AS status, count(*)::int AS n
    FROM reports r JOIN categories c ON c.id = r.category_id WHERE ${w} GROUP BY 1 ORDER BY 2 DESC`;
  const by_category = await s<Summary["by_category"]>`
    SELECT c.slug, c.name, c.icon, c.color, count(*)::int AS n,
      count(*) FILTER (WHERE r.status = 'resuelto')::int AS resolved
    FROM reports r JOIN categories c ON c.id = r.category_id WHERE ${w} GROUP BY 1, 2, 3, 4 ORDER BY 5 DESC`;
  return {
    total: totals.total,
    open: totals.open,
    resolved: totals.resolved,
    resolution_rate: totals.total ? totals.resolved / totals.total : 0,
    median_days_to_resolve: totals.median_days === null ? null : Math.round(totals.median_days * 10) / 10,
    by_status,
    by_category,
  };
}

/** Conteos por área (departamentos o distritos de un departamento) para el mapa coroplético. */
export async function countsByArea(level: 1 | 2, scope: Scope = {}) {
  const s = sql();
  const col = level === 1 ? s`r.dept_id` : s`r.district_id`;
  return s<{ area_id: number; name: string; slug: string; total: number; open: number; resolved: number }[]>`
    SELECT a.id AS area_id, a.name, a.slug,
      count(r.id)::int AS total,
      count(r.id) FILTER (WHERE r.status IN ('nuevo','verificado','en_proceso','derivado'))::int AS open,
      count(r.id) FILTER (WHERE r.status = 'resuelto')::int AS resolved
    FROM admin_areas a
    LEFT JOIN (reports r JOIN categories c ON c.id = r.category_id) ON ${col} = a.id AND ${where(scope)}
    WHERE a.level = ${level} ${scope.deptId && level === 2 ? s`AND a.parent_id = ${scope.deptId}` : s``}
    GROUP BY a.id ORDER BY total DESC, a.name`;
}

/** Reportes creados y resueltos por semana. */
export async function timeseries(scope: Scope = {}, weeks = 26) {
  const s = sql();
  const w = where(scope);
  return s<{ week: Date; created: number; resolved: number }[]>`
    WITH weeks AS (
      SELECT generate_series(date_trunc('week', now()) - make_interval(weeks => ${weeks - 1}), date_trunc('week', now()), '1 week') AS week
    )
    SELECT wk.week,
      (SELECT count(*)::int FROM reports r JOIN categories c ON c.id = r.category_id
        WHERE ${w} AND date_trunc('week', r.created_at) = wk.week) AS created,
      (SELECT count(*)::int FROM reports r JOIN categories c ON c.id = r.category_id
        WHERE ${w} AND date_trunc('week', r.resolved_at) = wk.week) AS resolved
    FROM weeks wk ORDER BY wk.week`;
}

/**
 * Hotspots: agrupaciones densas de reportes abiertos (DBSCAN en metros).
 * eps = distancia máxima entre vecinos, minPoints = mínimo para formar un foco.
 */
export async function hotspots(scope: Scope = {}, epsM = 200, minPoints = 3, limit = 20) {
  const s = sql();
  return s<{ cluster: number; n: number; lat: number; lng: number; radius_m: number; top_category: string; top_icon: string }[]>`
    WITH pts AS (
      SELECT r.id, c.slug, c.icon, ST_Transform(r.geom, 32721) AS g,
        ST_ClusterDBSCAN(ST_Transform(r.geom, 32721), eps => ${epsM}, minpoints => ${minPoints}) OVER () AS cluster
      FROM reports r JOIN categories c ON c.id = r.category_id
      WHERE ${where(scope)} AND r.status IN ('nuevo','verificado','en_proceso','derivado')
    ),
    agg AS (
      SELECT cluster, count(*)::int AS n,
        ST_Transform(ST_Centroid(ST_Collect(g)), 4326) AS center,
        ST_MaxDistance(ST_Centroid(ST_Collect(g)), ST_Collect(g))::int AS radius_m,
        mode() WITHIN GROUP (ORDER BY slug) AS top_category,
        mode() WITHIN GROUP (ORDER BY icon) AS top_icon
      FROM pts WHERE cluster IS NOT NULL GROUP BY cluster
    )
    SELECT cluster, n, ST_Y(center) AS lat, ST_X(center) AS lng, radius_m, top_category, top_icon
    FROM agg ORDER BY n DESC LIMIT ${limit}`;
}

/** Exportación de datos abiertos (sin datos personales). */
export async function exportGeoJSON(scope: Scope = {}, limit = 50000) {
  const s = sql();
  const [row] = await s<{ fc: unknown }[]>`
    SELECT json_build_object('type', 'FeatureCollection', 'features', coalesce(json_agg(json_build_object(
      'type', 'Feature',
      'geometry', ST_AsGeoJSON(r.geom, 6)::json,
      'properties', json_build_object(
        'codigo', r.public_code, 'titulo', r.title, 'categoria', c.slug, 'estado', r.status,
        'departamento', d.name, 'distrito', di.name, 'confirmaciones', r.confirmations_count,
        'creado', r.created_at, 'resuelto', r.resolved_at,
        'url', 'https://ciudadano.tereredev.com/r/' || lower(r.public_code) || '-' || r.slug)
    )), '[]'::json)) AS fc
    FROM (SELECT r.* FROM reports r JOIN categories c ON c.id = r.category_id WHERE ${where(scope)}
          ORDER BY r.created_at DESC LIMIT ${limit}) r
    JOIN categories c ON c.id = r.category_id
    LEFT JOIN admin_areas d ON d.id = r.dept_id
    LEFT JOIN admin_areas di ON di.id = r.district_id`;
  return row.fc;
}

export async function exportCSV(scope: Scope = {}, limit = 50000): Promise<string> {
  const s = sql();
  const rows = await s<Record<string, unknown>[]>`
    SELECT r.public_code AS codigo, r.title AS titulo, c.slug AS categoria, r.status::text AS estado,
      ST_Y(r.geom) AS lat, ST_X(r.geom) AS lng, d.name AS departamento, di.name AS distrito,
      r.confirmations_count AS confirmaciones, r.created_at AS creado, r.resolved_at AS resuelto
    FROM reports r JOIN categories c ON c.id = r.category_id
    LEFT JOIN admin_areas d ON d.id = r.dept_id
    LEFT JOIN admin_areas di ON di.id = r.district_id
    WHERE ${where(scope)} ORDER BY r.created_at DESC LIMIT ${limit}`;
  const cols = ["codigo", "titulo", "categoria", "estado", "lat", "lng", "departamento", "distrito", "confirmaciones", "creado", "resuelto"];
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return "";
    let str = v instanceof Date ? v.toISOString() : String(v);
    // Excel y LibreOffice ejecutan como fórmula un texto que empieza con = + - @: se neutraliza con un apóstrofo.
    // Solo en texto: las coordenadas son números negativos y tienen que quedar como números.
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(str)) str = `'${str}`;
    return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}
