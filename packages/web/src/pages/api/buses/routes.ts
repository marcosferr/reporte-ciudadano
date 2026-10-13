import type { APIRoute } from "astro";
import { routesCatalog } from "../../../lib/server/buses";
import { handle } from "../../../lib/server/http";

// Todos los recorridos de una vez, igual para cualquiera que los pida: el teléfono elige las líneas de su parada
// sin decirle al servidor cuáles son (ver /cuando-salgo). Cambian una vez por día como mucho.
export const GET: APIRoute = handle(async () => {
  const { body, etag } = await routesCatalog();
  return new Response(body, {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=3600, s-maxage=3600", ETag: etag },
  });
});
