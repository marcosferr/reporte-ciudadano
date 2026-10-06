import { hit } from "@rc/core/ratelimit";
import type { APIContext, AstroGlobal } from "astro";
import { AuthError } from "./cognito";
import { config } from "./config";
import { clientIp, ipHash } from "./http";
import { verifyTurnstile } from "./services";

type Ctx = AstroGlobal | APIContext;

/**
 * Formulario enviado por POST a la propia página. Los formularios HTML no pasan por el control CSRF de
 * /api, así que acá se exige que Origin, si viene, sea el sitio.
 */
export async function postedForm(ctx: Ctx): Promise<FormData | undefined> {
  if (ctx.request.method !== "POST") return undefined;
  const origin = ctx.request.headers.get("origin");
  if (origin && origin !== "null") {
    const host = new URL(origin).host;
    if (host !== ctx.url.host && host !== new URL(config.siteUrl).host) throw new AuthError("Forbidden", "Solicitud no permitida.");
  }
  return ctx.request.formData();
}

export const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

/** Límite por IP para cada acción de cuenta (además del que aplica Cognito). Sin base local, no limita. */
export async function allow(ctx: Ctx, action: string, max: number, windowSeconds: number): Promise<void> {
  const ok = await hit(`auth:${action}:${ipHash(ctx as APIContext)}`, max, windowSeconds).catch(() => true);
  if (!ok) throw new AuthError("TooManyRequestsException", "Demasiados intentos. Esperá unos minutos y volvé a probar.");
}

export async function requireCaptcha(ctx: Ctx, form: FormData): Promise<void> {
  const token = String(form.get("cf-turnstile-response") ?? "") || undefined;
  if (!(await verifyTurnstile(token, clientIp(ctx as APIContext)))) {
    throw new AuthError("Captcha", "No pudimos verificar que no sos un robot. Intentá de nuevo.");
  }
}

// Dominio solo con letras, números, puntos y guiones: además de validar, impide colar HTML en el correo.
export const isEmail = (s: string) => s.length <= 254 && /^[^\s@<>"'`()\\,;:]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(s);

/** Mensaje para mostrar a partir de cualquier error del formulario. */
export const errorMessage = (err: unknown) =>
  err instanceof AuthError ? err.message : (console.error(err), "No pudimos completar la operación. Intentá de nuevo en un rato.");

/** m•••@gmail.com: para confirmar a qué correo se envió el código sin mostrarlo entero. */
export function maskEmail(email: string): string {
  const [user, domain] = email.split("@");
  if (!domain) return email;
  return `${user.slice(0, Math.min(2, user.length - 1) || 1)}•••@${domain}`;
}

/** Querystring con solo los valores definidos. */
export const qs = (params: Record<string, string | undefined>) => {
  const p = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
  return p ? `?${p}` : "";
};

/** `next` para propagar entre pasos; se omite cuando es la portada. */
export const keepNext = (next: string) => (next === "/" ? undefined : next);
