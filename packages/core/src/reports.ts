import { ulid } from "ulid";
import { z } from "zod";
import { getCategoryBySlug } from "./categories";
import { sql } from "./db";
import { canTransition, type Status } from "./status";
import { randomToken, sha256, slugify } from "./util";

export const DUPLICATE_RADIUS_M = 30;
export const FLAGS_TO_HIDE = 3;

// Límites aproximados de Paraguay (con margen) para rechazar coordenadas absurdas.
// Para sumar países, ampliar a una tabla de países con su bbox.
export const COUNTRY_BBOX = { PY: { minLng: -62.8, minLat: -27.7, maxLng: -54.2, maxLat: -19.2 } } as const;

export const createReportSchema = z.object({
  category: z.string().min(1),
  title: z.string().trim().min(5).max(120),
  description: z.string().trim().max(2000).default(""),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  address: z.string().trim().max(200).optional(),
  extra: z.record(z.string(), z.string().max(200)).default({}),
});
export type CreateReportInput = z.infer<typeof createReportSchema>;

export interface ReportRow {
  id: string;
  public_code: string;
  slug: string;
  title: string;
  description: string;
  extra: Record<string, string>;
  status: Status;
  visibility: "published" | "pending" | "hidden";
  lat: number;
  lng: number;
  address: string | null;
  category_slug: string;
  category_name: string;
  category_icon: string;
  category_color: string;
  dept_name: string | null;
  dept_slug: string | null;
  district_name: string | null;
  district_slug: string | null;
  barrio_name: string | null;
  confirmations_count: number;
  flags_count: number;
  duplicate_of: string | null;
  reporter_user_id: string | null;
  created_at: Date;
  updated_at: Date;
  resolved_at: Date | null;
  cover_url: string | null;
}

export class DomainError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

export function reportPath(r: Pick<ReportRow, "public_code" | "slug">) {
  return `/r/${r.public_code.toLowerCase()}-${r.slug}`;
}

/** Acepta "py-2026-000123-bache-en-..." o el código solo. */
export function codeFromParam(param: string): string {
  const m = /^([a-z]{2}-\d{4}-\d{6})/i.exec(param);
  return m ? m[1].toUpperCase() : param.toUpperCase();
}

const SELECT_REPORT = (s: ReturnType<typeof sql>) => s`
  SELECT r.id, r.public_code, r.slug, r.title, r.description, r.extra, r.status, r.visibility,
    ST_Y(r.geom) AS lat, ST_X(r.geom) AS lng, r.address,
    c.slug AS category_slug, c.name AS category_name, c.icon AS category_icon, c.color AS category_color,
    d.name AS dept_name, d.slug AS dept_slug, di.name AS district_name, di.slug AS district_slug, b.name AS barrio_name,
    r.confirmations_count, r.flags_count, r.duplicate_of, r.reporter_user_id,
    r.created_at, r.updated_at, r.resolved_at,
    (SELECT '/media/' || substr(p.s3_key_thumb, 8) FROM report_photos p
      WHERE p.report_id = r.id AND p.status = 'approved' AND p.s3_key_thumb LIKE 'public/%'
      ORDER BY p.created_at LIMIT 1) AS cover_url
  FROM reports r
  JOIN categories c ON c.id = r.category_id
  LEFT JOIN admin_areas d ON d.id = r.dept_id
  LEFT JOIN admin_areas di ON di.id = r.district_id
  LEFT JOIN admin_areas b ON b.id = r.barrio_id`;

export async function createReport(
  input: CreateReportInput,
  ctx: { userId?: string; ipHash?: string; country?: keyof typeof COUNTRY_BBOX },
): Promise<{ report: ReportRow; anonToken?: string }> {
  const data = createReportSchema.parse(input);
  const country = ctx.country ?? "PY";
  const bbox = COUNTRY_BBOX[country];
  if (data.lng < bbox.minLng || data.lng > bbox.maxLng || data.lat < bbox.minLat || data.lat > bbox.maxLat) {
    throw new DomainError("out_of_bounds", "La ubicación está fuera del país.");
  }
  const category = await getCategoryBySlug(data.category);
  if (!category) throw new DomainError("bad_category", "Categoría inválida.");
  if (!category.accepting) throw new DomainError("category_closed", "Esta categoría no recibe reportes en este momento.");

  const allowedExtra = new Set(category.extra_fields.map((f) => f.key));
  const extra = Object.fromEntries(Object.entries(data.extra).filter(([k, v]) => allowedExtra.has(k) && v.trim()));

  const id = ulid();
  const anonToken = ctx.userId ? undefined : randomToken();
  const year = new Date().getFullYear();
  const slug = slugify(data.title) || category.slug;

  await sql().begin(async (tx) => {
    const [{ n }] = await tx<{ n: string }[]>`SELECT nextval('report_code_seq') AS n`;
    const code = `${country}-${year}-${String(n).padStart(6, "0")}`;
    await tx`
      INSERT INTO reports (id, public_code, slug, category_id, title, description, extra, geom, address,
        country_code, reporter_user_id, anon_token_hash, ip_hash)
      VALUES (${id}, ${code}, ${slug}, ${category.id}, ${data.title}, ${data.description}, ${tx.json(extra)},
        ST_SetSRID(ST_MakePoint(${data.lng}, ${data.lat}), 4326), ${data.address ?? null},
        ${country}, ${ctx.userId ?? null}, ${anonToken ? sha256(anonToken) : null}, ${ctx.ipHash ?? null})`;
    await tx`INSERT INTO report_events (report_id, type, to_status, actor_id)
      VALUES (${id}, 'created', 'nuevo', ${ctx.userId ?? null})`;
  });

  const report = (await getReportById(id))!;
  return { report, anonToken };
}

export async function getReportById(id: string): Promise<ReportRow | undefined> {
  const s = sql();
  const [row] = await s<ReportRow[]>`${SELECT_REPORT(s)} WHERE r.id = ${id}`;
  return row;
}

export async function getReportByCode(code: string): Promise<ReportRow | undefined> {
  const s = sql();
  const [row] = await s<ReportRow[]>`${SELECT_REPORT(s)} WHERE r.public_code = ${code}`;
  return row;
}

export interface ReportFilters {
  bbox?: [number, number, number, number]; // minLng, minLat, maxLng, maxLat
  category?: string;
  status?: Status | "abiertos";
  deptSlug?: string;
  districtSlug?: string;
  userId?: string;
  visibility?: "published" | "pending" | "hidden" | "any";
  q?: string;
  limit?: number;
  before?: Date; // paginación por created_at
}

export async function listReports(f: ReportFilters = {}): Promise<ReportRow[]> {
  const s = sql();
  const limit = Math.min(f.limit ?? 30, 200);
  const conds = [s`TRUE`];
  if (!f.visibility || f.visibility === "published") conds.push(s`r.visibility = 'published'`);
  else if (f.visibility !== "any") conds.push(s`r.visibility = ${f.visibility}`);
  if (f.bbox) conds.push(s`r.geom && ST_MakeEnvelope(${f.bbox[0]}, ${f.bbox[1]}, ${f.bbox[2]}, ${f.bbox[3]}, 4326)`);
  if (f.category) conds.push(s`c.slug = ${f.category}`);
  if (f.status === "abiertos") conds.push(s`r.status IN ('nuevo','verificado','en_proceso','derivado')`);
  else if (f.status) conds.push(s`r.status = ${f.status}`);
  if (f.deptSlug) conds.push(s`d.slug = ${f.deptSlug}`);
  if (f.districtSlug) conds.push(s`di.slug = ${f.districtSlug}`);
  if (f.userId) conds.push(s`r.reporter_user_id = ${f.userId}`);
  if (f.q) conds.push(s`(r.title ILIKE ${"%" + f.q + "%"} OR r.public_code = ${f.q.toUpperCase()})`);
  if (f.before) conds.push(s`r.created_at < ${f.before}`);
  const where = conds.reduce((acc, c) => s`${acc} AND ${c}`);
  return s<ReportRow[]>`${SELECT_REPORT(s)} WHERE ${where} ORDER BY r.created_at DESC LIMIT ${limit}`;
}

/** Reportes abiertos de la misma categoría cerca del punto (posibles duplicados). */
export async function findNearbyDuplicates(lat: number, lng: number, category: string, radiusM = DUPLICATE_RADIUS_M) {
  const s = sql();
  return s<(ReportRow & { distance_m: number })[]>`
    SELECT * FROM (
      ${SELECT_REPORT(s)}
      WHERE c.slug = ${category}
        AND r.visibility = 'published'
        AND r.status IN ('nuevo','verificado','en_proceso','derivado')
        AND ST_DWithin(r.geom::geography, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography, ${radiusM})
    ) x
    CROSS JOIN LATERAL (
      SELECT ST_Distance(ST_SetSRID(ST_MakePoint(x.lng, x.lat), 4326)::geography,
                         ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography)::int AS distance_m
    ) d
    ORDER BY distance_m LIMIT 5`;
}

export async function confirmReport(reportId: string, voter: string): Promise<{ added: boolean; count: number }> {
  return sql().begin(async (tx) => {
    const ins = await tx`INSERT INTO confirmations (report_id, voter) VALUES (${reportId}, ${voter}) ON CONFLICT DO NOTHING`;
    const added = ins.count === 1;
    const [{ confirmations_count }] = added
      ? await tx<{ confirmations_count: number }[]>`
          UPDATE reports SET confirmations_count = confirmations_count + 1 WHERE id = ${reportId} RETURNING confirmations_count`
      : await tx<{ confirmations_count: number }[]>`SELECT confirmations_count FROM reports WHERE id = ${reportId}`;
    return { added, count: confirmations_count };
  });
}

export const FLAG_REASONS = ["falso", "ofensivo", "datos_personales", "spam", "duplicado", "otro"] as const;

export async function flagReport(reportId: string, reporter: string, reason: (typeof FLAG_REASONS)[number], note?: string) {
  await sql().begin(async (tx) => {
    const ins = await tx`INSERT INTO flags (report_id, reporter, reason, note)
      VALUES (${reportId}, ${reporter}, ${reason}, ${note ?? null}) ON CONFLICT DO NOTHING`;
    if (ins.count === 0) return;
    const [r] = await tx<{ visibility: string }[]>`
      UPDATE reports SET flags_count = flags_count + 1 WHERE id = ${reportId} RETURNING visibility`;
    // Solo cuentan las denuncias que ningún moderador resolvió todavía: si un moderador ya lo republicó,
    // hacen falta otras FLAGS_TO_HIDE denuncias nuevas. Y al menos una tiene que venir de una cuenta, para que
    // nadie pueda ocultar reportes solo cambiando de IP.
    const [pending] = await tx<{ total: number; from_accounts: number }[]>`
      SELECT count(*)::int AS total, count(*) FILTER (WHERE reporter LIKE 'u:%')::int AS from_accounts
      FROM flags WHERE report_id = ${reportId} AND NOT resolved`;
    if (pending.total >= FLAGS_TO_HIDE && pending.from_accounts >= 1 && r.visibility === "published") {
      await tx`UPDATE reports SET visibility = 'pending' WHERE id = ${reportId}`;
      await tx`INSERT INTO report_events (report_id, type, note, actor_role, public)
        VALUES (${reportId}, 'visibility', 'En revisión por denuncias de la comunidad', 'sistema', false)`;
    }
  });
}

export interface Actor {
  id: string;
  role: "admin" | "moderador";
}

export async function changeStatus(
  reportId: string,
  to: Status,
  actor: Actor,
  opts: { note?: string; duplicateOf?: string } = {},
): Promise<ReportRow> {
  await sql().begin(async (tx) => {
    const [cur] = await tx<{ status: Status }[]>`SELECT status FROM reports WHERE id = ${reportId} FOR UPDATE`;
    if (!cur) throw new DomainError("not_found", "Reporte no encontrado.", 404);
    if (!canTransition(cur.status, to)) {
      throw new DomainError("bad_transition", `No se puede pasar de ${cur.status} a ${to}.`);
    }
    let duplicateOf: string | null = null;
    if (to === "duplicado") {
      if (!opts.duplicateOf) throw new DomainError("missing_duplicate", "Indicá el reporte original.");
      const [orig] = await tx<{ id: string }[]>`
        SELECT id FROM reports WHERE (id = ${opts.duplicateOf} OR public_code = ${opts.duplicateOf.toUpperCase()}) AND id <> ${reportId}`;
      if (!orig) throw new DomainError("missing_duplicate", "No existe el reporte original.");
      duplicateOf = orig.id;
    }
    await tx`UPDATE reports SET status = ${to}, duplicate_of = ${duplicateOf} WHERE id = ${reportId}`;
    await tx`INSERT INTO report_events (report_id, type, from_status, to_status, note, actor_id, actor_role)
      VALUES (${reportId}, 'status_change', ${cur.status}, ${to}, ${opts.note ?? null}, ${actor.id}, ${actor.role})`;
  });
  return (await getReportById(reportId))!;
}

export async function setVisibility(reportId: string, visibility: "published" | "pending" | "hidden", actor: Actor, note?: string) {
  await sql().begin(async (tx) => {
    await tx`UPDATE reports SET visibility = ${visibility} WHERE id = ${reportId}`;
    // Publicar u ocultar es la decisión del moderador sobre las denuncias pendientes: salen de la cola.
    if (visibility !== "pending") await tx`UPDATE flags SET resolved = true WHERE report_id = ${reportId}`;
    await tx`INSERT INTO report_events (report_id, type, note, actor_id, actor_role, public)
      VALUES (${reportId}, 'visibility', ${note ?? visibility}, ${actor.id}, ${actor.role}, false)`;
  });
}

export async function addComment(reportId: string, note: string, actor: Actor, isPublic = true) {
  await sql()`INSERT INTO report_events (report_id, type, note, actor_id, actor_role, public)
    VALUES (${reportId}, 'comment', ${note}, ${actor.id}, ${actor.role}, ${isPublic})`;
}

export interface ReportEvent {
  id: string;
  type: string;
  from_status: Status | null;
  to_status: Status | null;
  note: string | null;
  actor_role: string;
  public: boolean;
  created_at: Date;
}

export async function listEvents(reportId: string, includePrivate = false): Promise<ReportEvent[]> {
  return sql()<ReportEvent[]>`
    SELECT id, type, from_status, to_status, note, actor_role, public, created_at
    FROM report_events WHERE report_id = ${reportId} ${includePrivate ? sql()`` : sql()`AND public`}
    ORDER BY created_at, id`;
}

export async function verifyAnonToken(reportId: string, token: string): Promise<boolean> {
  const [r] = await sql()<{ ok: boolean }[]>`
    SELECT anon_token_hash = ${sha256(token)} AS ok FROM reports WHERE id = ${reportId}`;
  return !!r?.ok;
}

export async function subscribe(reportId: string, userId: string, email: string) {
  await sql()`INSERT INTO subscriptions (report_id, user_id, email) VALUES (${reportId}, ${userId}, ${email})
    ON CONFLICT (report_id, user_id) DO UPDATE SET email = EXCLUDED.email`;
}

export async function unsubscribe(reportId: string, userId: string) {
  await sql()`DELETE FROM subscriptions WHERE report_id = ${reportId} AND user_id = ${userId}`;
}

export async function isSubscribed(reportId: string, userId: string) {
  const [r] = await sql()`SELECT 1 FROM subscriptions WHERE report_id = ${reportId} AND user_id = ${userId}`;
  return !!r;
}

export async function subscriberEmails(reportId: string): Promise<string[]> {
  const rows = await sql()<{ email: string }[]>`SELECT email FROM subscriptions WHERE report_id = ${reportId}`;
  return rows.map((r) => r.email);
}

export interface FlagQueueItem {
  report_id: string;
  public_code: string;
  title: string;
  visibility: string;
  flags: { reason: string; note: string | null; created_at: Date }[];
}

export async function flagQueue(): Promise<FlagQueueItem[]> {
  return sql()<FlagQueueItem[]>`
    SELECT r.id AS report_id, r.public_code, r.title, r.visibility,
      json_agg(json_build_object('reason', f.reason, 'note', f.note, 'created_at', f.created_at) ORDER BY f.created_at) AS flags
    FROM flags f JOIN reports r ON r.id = f.report_id
    WHERE NOT f.resolved
    GROUP BY r.id ORDER BY max(f.created_at) DESC LIMIT 100`;
}

export const SITEMAP_PAGE = 5000;

export async function countPublishedReports(): Promise<number> {
  const [{ n }] = await sql()<{ n: number }[]>`SELECT count(*)::int AS n FROM reports WHERE visibility = 'published' AND status <> 'duplicado'`;
  return n;
}

export async function sitemapReports(page: number) {
  return sql()<{ public_code: string; slug: string; updated_at: Date }[]>`
    SELECT public_code, slug, updated_at FROM reports
    WHERE visibility = 'published' AND status <> 'duplicado'
    ORDER BY created_at LIMIT ${SITEMAP_PAGE} OFFSET ${page * SITEMAP_PAGE}`;
}
