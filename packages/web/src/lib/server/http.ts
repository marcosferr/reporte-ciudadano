import { DomainError } from "@rc/core/reports";
import { hashIp } from "@rc/core/util";
import { timingSafeEqual } from "node:crypto";
import type { APIContext } from "astro";
import { ZodError } from "zod";
import { config } from "./config";

export function json(data: unknown, init: ResponseInit & { cache?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", init.cache ?? "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function error(status: number, code: string, message: string) {
  return json({ error: { code, message } }, { status });
}

/** Envuelve un handler y traduce errores de dominio/validación a respuestas JSON. */
export function handle(fn: (ctx: APIContext) => Promise<Response>) {
  return async (ctx: APIContext) => {
    try {
      return await fn(ctx);
    } catch (err) {
      if (err instanceof DomainError) return error(err.status, err.code, err.message);
      if (err instanceof SyntaxError) return error(400, "bad_json", "El cuerpo de la solicitud no es JSON válido.");
      if (err instanceof ZodError) return error(400, "validation", err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      console.error(err);
      return error(500, "internal", "Ocurrió un error inesperado.");
    }
  };
}

/**
 * IP del visitante. En AWS solo vale el header que agrega nuestra CloudFront Function (`event.viewer.ip`,
 * ver infra/web.ts), y solo si viene con el secreto compartido. X-Forwarded-For nunca se usa porque su primer
 * valor lo escribe el cliente. Un pedido que no pasó por CloudFront (la URL de la Lambda es pública) queda
 * como "0.0.0.0": todos esos pedidos comparten un mismo cupo en los límites de frecuencia y en las denuncias.
 */
export function clientIp(ctx: APIContext): string {
  const secret = config.edgeSecret;
  if (secret) {
    const got = Buffer.from(ctx.request.headers.get(EDGE_SECRET_HEADER) ?? "");
    const want = Buffer.from(secret);
    const viaCloudFront = got.length === want.length && timingSafeEqual(got, want);
    return (viaCloudFront && ctx.request.headers.get(VIEWER_IP_HEADER)) || "0.0.0.0";
  }
  try {
    return ctx.clientAddress;
  } catch {
    return "0.0.0.0";
  }
}

export const VIEWER_IP_HEADER = "x-rc-viewer-ip";
export const EDGE_SECRET_HEADER = "x-rc-edge";

export function ipHash(ctx: APIContext) {
  return hashIp(clientIp(ctx), config.ipSalt);
}

/**
 * Identidad para confirmaciones: el usuario si inició sesión; si no, IP + navegador (para que dos
 * personas detrás de la misma IP puedan confirmar). Los límites de frecuencia van por `actorKey`.
 */
export function voterId(ctx: APIContext): string {
  if (ctx.locals.user) return `u:${ctx.locals.user.id}`;
  const ua = ctx.request.headers.get("user-agent") ?? "";
  return `a:${hashIp(`${clientIp(ctx)}|${ua}`, config.ipSalt)}`;
}

/** Clave para límites de frecuencia y denuncias: el usuario o la IP. Sin datos que el cliente pueda rotar. */
export function actorKey(ctx: APIContext): string {
  return ctx.locals.user ? `u:${ctx.locals.user.id}` : `a:${ipHash(ctx)}`;
}

export function requireStaff(ctx: APIContext) {
  const u = ctx.locals.user;
  if (!u?.isStaff) throw new DomainError("forbidden", "Necesitás permisos de moderación.", 403);
  return { id: u.id, role: u.role! };
}
