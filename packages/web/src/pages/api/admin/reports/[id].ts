import { addComment, changeStatus, reportPath, setVisibility, subscriberEmails } from "@rc/core/reports";
import { STATUS_LABEL, STATUSES } from "@rc/core/status";
import type { APIRoute } from "astro";
import { z } from "zod";
import { config } from "../../../../lib/server/config";
import { handle, json, requireStaff } from "../../../../lib/server/http";
import { setReportMediaVisible } from "../../../../lib/server/media";
import { sendMail } from "../../../../lib/server/services";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status"), status: z.enum(STATUSES), note: z.string().max(1000).optional(), duplicateOf: z.string().optional() }),
  z.object({ action: z.literal("visibility"), visibility: z.enum(["published", "pending", "hidden"]), note: z.string().max(500).optional() }),
  z.object({ action: z.literal("comment"), note: z.string().min(1).max(1000), public: z.boolean().default(true) }),
]);

export const POST: APIRoute = handle(async (ctx) => {
  const actor = requireStaff(ctx);
  const body = schema.parse(await ctx.request.json());
  const id = ctx.params.id!;
  if (body.action === "status") {
    const r = await changeStatus(id, body.status, actor, { note: body.note, duplicateOf: body.duplicateOf });
    const emails = await subscriberEmails(id);
    await sendMail(
      emails,
      `Tu reporte ${r.public_code} ahora está: ${STATUS_LABEL[r.status]}`,
      [
        `El reporte "${r.title}" cambió de estado a ${STATUS_LABEL[r.status]}.`,
        body.note ? `\nNota: ${body.note}` : "",
        `\nSeguilo en ${config.siteUrl}${reportPath(r)}`,
        `\n\nRecibís este correo porque seguís este caso en Reporte Ciudadano.`,
      ].join(""),
    );
    return json({ ok: true, status: r.status });
  }
  if (body.action === "visibility") {
    await setVisibility(id, body.visibility, actor, body.note);
    // Ocultar retira las fotos de CloudFront (pueden ser el motivo, p. ej. datos personales); republicar las devuelve.
    if (body.visibility !== "pending") await setReportMediaVisible(id, body.visibility === "published");
    return json({ ok: true });
  }
  await addComment(id, body.note, actor, body.public);
  return json({ ok: true });
});
