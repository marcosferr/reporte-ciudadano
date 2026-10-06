import { hit } from "@rc/core/ratelimit";
import { FLAG_REASONS, flagReport } from "@rc/core/reports";
import type { APIRoute } from "astro";
import { z } from "zod";
import { actorKey, error, handle, json } from "../../../../lib/server/http";

const schema = z.object({ reason: z.enum(FLAG_REASONS), note: z.string().max(500).optional() });

export const POST: APIRoute = handle(async (ctx) => {
  const body = schema.parse(await ctx.request.json());
  // Una denuncia por persona con cuenta o por IP: cambiar de navegador no suma denuncias.
  const actor = actorKey(ctx);
  if (!(await hit(`flag:${actor}`, ctx.locals.user ? 20 : 10, 3600))) return error(429, "rate_limited", "Demasiadas denuncias.");
  await flagReport(ctx.params.id!, actor, body.reason, body.note);
  return json({ ok: true });
});
