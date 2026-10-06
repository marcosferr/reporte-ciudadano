import { hit } from "@rc/core/ratelimit";
import { confirmReport } from "@rc/core/reports";
import type { APIRoute } from "astro";
import { actorKey, error, handle, json, voterId } from "../../../../lib/server/http";

export const POST: APIRoute = handle(async (ctx) => {
  if (!(await hit(`confirm:${actorKey(ctx)}`, 60, 3600))) return error(429, "rate_limited", "Demasiadas confirmaciones.");
  return json(await confirmReport(ctx.params.id!, voterId(ctx)));
});
