import { decideReviewedPhoto, getPhoto } from "@rc/core/photos";
import { DomainError } from "@rc/core/reports";
import type { APIRoute } from "astro";
import { z } from "zod";
import { handle, json, requireStaff } from "../../../../../lib/server/http";
import { deleteObjects, invalidateReportMedia, movePhoto } from "../../../../../lib/server/media";

/** Aprobar publica la versión difuminada (review/ → public/); rechazar la borra. */
export const POST: APIRoute = handle(async (ctx) => {
  const actor = requireStaff(ctx);
  const { status } = z.object({ status: z.enum(["approved", "rejected"]) }).parse(await ctx.request.json());
  const photo = await getPhoto(ctx.params.id!);
  if (!photo) throw new DomainError("not_found", "Foto no encontrada.", 404);
  if (photo.status !== "review") throw new DomainError("not_in_review", "Solo se pueden decidir fotos en revisión.", 409);

  if (status === "approved") {
    const keys = await movePhoto(photo, "public");
    if (!(await decideReviewedPhoto(photo.id, { status, ...keys }, actor))) {
      throw new DomainError("not_in_review", "Otra persona ya decidió esta foto.", 409);
    }
  } else {
    if (!(await decideReviewedPhoto(photo.id, { status, publicKey: null, thumbKey: null }, actor))) {
      throw new DomainError("not_in_review", "Otra persona ya decidió esta foto.", 409);
    }
    await deleteObjects([photo.s3_key_public, photo.s3_key_thumb]);
    if (photo.s3_key_public?.startsWith("public/")) await invalidateReportMedia(photo.report_id);
  }
  return json({ ok: true });
});
