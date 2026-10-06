import { getPhoto } from "@rc/core/photos";
import type { APIRoute } from "astro";
import { requireStaff } from "../../../../../lib/server/http";
import { readObject } from "../../../../../lib/server/media";

/** Muestra al staff fotos que no están en public/ (en revisión o de reportes ocultos). ?thumb=1 para la miniatura. */
export const GET: APIRoute = async (ctx) => {
  try {
    requireStaff(ctx);
  } catch {
    return new Response("No autorizado", { status: 403 });
  }
  const photo = await getPhoto(ctx.params.id!);
  const key = ctx.url.searchParams.has("thumb") ? photo?.s3_key_thumb : photo?.s3_key_public;
  const body = key && (await readObject(key).catch(() => undefined));
  if (!body) return new Response("No encontrada", { status: 404 });
  return new Response(body, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, no-store" } });
};
