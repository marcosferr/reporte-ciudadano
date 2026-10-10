import { reservePhotos } from "@rc/core/photos";
import { hit } from "@rc/core/ratelimit";
import { createReport, createReportSchema, listReports, reportPath } from "@rc/core/reports";
import type { APIRoute } from "astro";
import { z } from "zod";
import { clientIp, error, handle, ipHash, json } from "../../../lib/server/http";
import { nonEmptyParams, reportQuerySchema } from "../../../lib/server/report-query";
import { captchaEnabled, presignUpload, verifyTurnstile } from "../../../lib/server/services";

const bodySchema = createReportSchema.extend({
  photos: z.number().int().min(0).max(4).default(0),
  turnstile: z.string().optional(),
});

export const POST: APIRoute = handle(async (ctx) => {
  const body = bodySchema.parse(await ctx.request.json());
  const ip = ipHash(ctx);
  const user = ctx.locals.user;
  const key = user ? `u:${user.id}` : `ip:${ip}`;
  // Sin sesión ni captcha no se publica: se responde antes de gastar el límite por IP. La cola sin conexión
  // envía así lo que guardó y se entera en ese momento si la sesión sigue abierta o hace falta el captcha.
  if (!user && !body.turnstile && captchaEnabled()) return captchaError();
  if (!(await hit(`report:h:${key}`, user ? 20 : 8, 3600)) || !(await hit(`report:d:${key}`, user ? 60 : 25, 86400))) {
    return error(429, "rate_limited", "Hiciste muchos reportes seguidos. Probá de nuevo más tarde.");
  }
  if (!user && !(await verifyTurnstile(body.turnstile, clientIp(ctx)))) return captchaError();
  const { report, anonToken } = await createReport(body, { userId: user?.id, ipHash: ip });
  const reserved = await reservePhotos(report.id, body.photos);
  const uploads = (await Promise.all(reserved.map((p) => presignUpload(p.s3_key_original)))).filter(Boolean);
  return json(
    { report: { id: report.id, code: report.public_code, path: reportPath(report), title: report.title }, anonToken, uploads },
    { status: 201 },
  );
});

const captchaError = () => error(400, "captcha", "No pudimos verificar que seas una persona. Recargá la página.");

export const GET: APIRoute = handle(async (ctx) => {
  const rows = await listReports(reportQuerySchema.parse(nonEmptyParams(ctx.url.searchParams)));
  return json(
    rows.map((r) => ({
      code: r.public_code, path: reportPath(r), title: r.title, status: r.status, category: r.category_slug,
      icon: r.category_icon, color: r.category_color, lat: r.lat, lng: r.lng, created_at: r.created_at,
      place: [r.district_name, r.dept_name].filter(Boolean).join(", "), cover: r.cover_url, confirmations: r.confirmations_count,
    })),
    { cache: "public, max-age=15, s-maxage=30" },
  );
});
