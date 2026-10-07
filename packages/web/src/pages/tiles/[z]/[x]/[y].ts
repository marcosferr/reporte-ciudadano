import { reportTile } from "@rc/core/tiles";
import type { APIRoute } from "astro";

// /tiles/{z}/{x}/{y}.pbf?category=&status=  — cacheado 60 s en CloudFront.
export const GET: APIRoute = async (ctx) => {
  const z = Number(ctx.params.z), x = Number(ctx.params.x), y = Number(String(ctx.params.y).replace(/\.pbf$/, ""));
  const p = ctx.url.searchParams;
  const tile = await reportTile(z, x, y, { category: p.get("category") ?? undefined, status: p.get("status") ?? undefined });
  if (tile === null) return new Response("Tile inválido", { status: 400 });
  return new Response(tile.length ? new Uint8Array(tile) : null, {
    status: tile.length ? 200 : 204,
    headers: {
      // No "application/vnd.mapbox-vector-tile": astro-sst solo codifica en base64 los tipos de su lista de
      // binarios y trata el resto como texto UTF-8, lo que rompe el protobuf en Lambda (en `pnpm dev` no se nota).
      // MapLibre no mira este header para decodificar el tile.
      "Content-Type": "application/octet-stream",
      "Cache-Control": "public, max-age=30, s-maxage=60, stale-while-revalidate=300",
      "Access-Control-Allow-Origin": "*",
    },
  });
};
