import type { APIRoute } from "astro";
import { devLogin, safeNext } from "../../lib/server/auth";
import { config } from "../../lib/server/config";

// Solo existe con DEV_LOGIN=1 fuera de Lambda.
export const GET: APIRoute = (ctx) => {
  if (!config.devLogin) return new Response("No disponible", { status: 404 });
  devLogin(ctx.cookies, ctx.url.searchParams.get("as") === "vecino" ? "vecino" : "admin");
  return ctx.redirect(safeNext(ctx.url.searchParams.get("next")));
};
