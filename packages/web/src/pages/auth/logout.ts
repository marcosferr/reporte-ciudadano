import type { APIRoute } from "astro";
import { logout } from "../../lib/server/auth";

// Solo POST (formulario del menú, protegido por checkOrigin): un enlace o imagen de otro sitio no puede cerrar la sesión.
export const POST: APIRoute = async (ctx) => {
  const res = ctx.redirect(await logout(ctx.cookies), 303);
  // Borra páginas personales que el service worker haya guardado (p. ej. "Mis reportes").
  res.headers.set("Clear-Site-Data", '"cache"');
  return res;
};

export const GET: APIRoute = (ctx) => ctx.redirect("/");
