import { ulid } from "ulid";
import { sql } from "./db";

export const MAX_PHOTOS_PER_REPORT = 4;

/** "public/abc/def.jpg" → "/media/abc/def.jpg" (ruta servida por CloudFront). Solo public/ es público. */
export function mediaUrl(key: string | null): string | null {
  return key?.startsWith("public/") ? `/media/${key.slice("public/".length)}` : null;
}

/** Prefijos del bucket para versiones procesadas (ver infra/storage.ts). */
export type MediaPrefix = "review" | "public" | "withheld";

/** "review/abc/def.jpg" → "public/abc/def.jpg". */
export function withPrefix(key: string, prefix: MediaPrefix): string {
  return key.replace(/^[a-z]+\//, `${prefix}/`);
}

export interface Photo {
  id: string;
  report_id: string;
  kind: "report" | "resolution";
  s3_key_original: string;
  s3_key_public: string | null;
  s3_key_thumb: string | null;
  width: number | null;
  height: number | null;
  status: "processing" | "approved" | "rejected" | "review";
  moderation: Record<string, unknown>;
  created_at: Date;
}

/** Reserva filas para fotos que el cliente va a subir; devuelve las keys de S3. */
export async function reservePhotos(reportId: string, count: number, kind: Photo["kind"] = "report") {
  const [{ n }] = await sql()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM report_photos WHERE report_id = ${reportId} AND kind = ${kind}`;
  const allowed = Math.max(0, Math.min(count, MAX_PHOTOS_PER_REPORT - n));
  const rows = Array.from({ length: allowed }, () => {
    const id = ulid();
    return { id, report_id: reportId, kind, s3_key_original: `uploads/${reportId}/${id}.jpg` };
  });
  if (rows.length) await sql()`INSERT INTO report_photos ${sql()(rows)}`;
  return rows;
}

export async function getPhotoByKey(key: string): Promise<Photo | undefined> {
  const [row] = await sql()<Photo[]>`SELECT * FROM report_photos WHERE s3_key_original = ${key}`;
  return row;
}

export async function completePhoto(
  id: string,
  r: { status: Photo["status"]; publicKey?: string; thumbKey?: string; width?: number; height?: number; moderation: object },
) {
  await sql()`
    UPDATE report_photos SET status = ${r.status}, s3_key_public = ${r.publicKey ?? null},
      s3_key_thumb = ${r.thumbKey ?? null}, width = ${r.width ?? null}, height = ${r.height ?? null},
      moderation = ${sql().json(r.moderation as any)}
    WHERE id = ${id}`;
  if (r.status === "approved") {
    const [p] = await sql()<{ report_id: string; kind: string }[]>`SELECT report_id, kind FROM report_photos WHERE id = ${id}`;
    await sql()`INSERT INTO report_events (report_id, type, note, actor_role)
      VALUES (${p.report_id}, 'photo', ${p.kind === "resolution" ? "Foto de la resolución" : null}, 'sistema')`;
  }
}

export async function listPhotos(reportId: string, includeAll = false): Promise<Photo[]> {
  return sql()<Photo[]>`
    SELECT * FROM report_photos WHERE report_id = ${reportId}
      ${includeAll ? sql()`` : sql()`AND status = 'approved'`}
    ORDER BY kind, created_at`;
}

export async function photoReviewQueue(): Promise<(Photo & { public_code: string; title: string })[]> {
  return sql()`
    SELECT p.*, r.public_code, r.title FROM report_photos p JOIN reports r ON r.id = p.report_id
    WHERE p.status = 'review' ORDER BY p.created_at LIMIT 100` as any;
}

export async function getPhoto(id: string): Promise<Photo | undefined> {
  const [row] = await sql()<Photo[]>`SELECT * FROM report_photos WHERE id = ${id}`;
  return row;
}

/**
 * Decisión de un moderador sobre una foto en revisión (solo esas: las rechazadas no tienen versión pública
 * y las que se procesan todavía las pisa la moderación automática). Devuelve false si ya no estaba en revisión.
 */
export async function decideReviewedPhoto(
  id: string,
  decision: { status: "approved" | "rejected"; publicKey: string | null; thumbKey: string | null },
  actor: { id: string; role: string },
): Promise<boolean> {
  return sql().begin(async (tx) => {
    const [p] = await tx<{ report_id: string; kind: string }[]>`
      UPDATE report_photos SET status = ${decision.status}, s3_key_public = ${decision.publicKey}, s3_key_thumb = ${decision.thumbKey}
      WHERE id = ${id} AND status = 'review' RETURNING report_id, kind`;
    if (!p) return false;
    await tx`INSERT INTO report_events (report_id, type, note, actor_id, actor_role, public)
      VALUES (${p.report_id}, 'photo', ${decision.status === "approved" ? (p.kind === "resolution" ? "Foto de la resolución" : null) : "Foto rechazada en moderación"},
        ${actor.id}, ${actor.role}, ${decision.status === "approved"})`;
    return true;
  });
}

/** Fotos aprobadas de un reporte cuyas versiones están bajo `prefix` (para ocultarlas o volver a publicarlas). */
export async function approvedPhotosUnder(reportId: string, prefix: MediaPrefix): Promise<Photo[]> {
  return sql()<Photo[]>`
    SELECT * FROM report_photos WHERE report_id = ${reportId} AND status = 'approved' AND s3_key_public LIKE ${prefix + "/%"}`;
}

export async function setPhotoKeys(id: string, publicKey: string | null, thumbKey: string | null) {
  await sql()`UPDATE report_photos SET s3_key_public = ${publicKey}, s3_key_thumb = ${thumbKey} WHERE id = ${id}`;
}
