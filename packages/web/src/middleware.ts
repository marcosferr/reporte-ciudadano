import { defineMiddleware } from "astro:middleware";
import { getUser } from "./lib/server/auth";
import { config } from "./lib/server/config";

// Rutas cacheables públicamente: no se lee la sesión para que CloudFront pueda compartirlas.
// Ninguna de estas rutas depende de quién la pide (los GET de reportes y de ubicación tampoco).
const PUBLIC_CACHEABLE = [
  /^\/tiles\//, /^\/sitemap/, /^\/robots\.txt$/, /^\/api\/stats\//, /^\/api\/categories/, /^\/api\/areas$/,
  /^\/api\/locate$/, /^\/api\/reports(\/nearby)?$/,
];

/**
 * CSRF: las escrituras de la API solo aceptan JSON (un formulario de otro sitio no puede enviarlo sin
 * preflight CORS, que no habilitamos) y, si viene Origin, debe ser el propio sitio.
 */
function isCrossSiteWrite(req: Request, url: URL): boolean {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return false;
  if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) return true;
  const origin = req.headers.get("origin");
  if (!origin) return false;
  let host: string;
  try {
    host = new URL(origin).host; // "null" (iframes con sandbox, redirecciones) no es un origen válido
  } catch {
    return true;
  }
  return host !== url.host && host !== new URL(config.siteUrl).host;
}

export const onRequest = defineMiddleware(async (ctx, next) => {
  const path = ctx.url.pathname;
  if (path.startsWith("/api/") && isCrossSiteWrite(ctx.request, ctx.url)) {
    return new Response(JSON.stringify({ error: { code: "forbidden", message: "Solicitud no permitida." } }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  const cacheable = PUBLIC_CACHEABLE.some((r) => r.test(path)) && ctx.request.method === "GET";
  if (!cacheable) {
    ctx.locals.user = await getUser(ctx.cookies).catch(() => undefined);
  }
  if (path.startsWith("/admin") && !ctx.locals.user?.isStaff) {
    return ctx.redirect(ctx.locals.user ? "/?e=permisos" : `/auth/login?next=${encodeURIComponent(path)}`);
  }
  const res = await next();
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("Permissions-Policy", "geolocation=(self), camera=(self)");
  if (ctx.locals.user && !res.headers.has("Cache-Control")) res.headers.set("Cache-Control", "private, no-store");
  // Red de seguridad: una respuesta que fija cookies (p. ej. al renovar la sesión) nunca se cachea en
  // CloudFront, o le entregaría la sesión de una persona a la siguiente.
  // Astro agrega las cookies de ctx.cookies después del middleware, por eso se miran las dos fuentes.
  if (res.headers.has("Set-Cookie") || !ctx.cookies.headers().next().done) res.headers.set("Cache-Control", "private, no-store");
  return res;
});
