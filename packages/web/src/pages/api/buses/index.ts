import type { APIRoute } from "astro";
import { currentBuses } from "../../../lib/server/buses";
import { error, handle, json } from "../../../lib/server/http";

export const GET: APIRoute = handle(async () => {
  try {
    const { features, delayed } = await currentBuses();
    // `delayed`: empresas en servicio cuyos datos el VMT manda atrasados (sus buses no van en `features`).
    return json({ type: "FeatureCollection", features, delayed }, { cache: "public, max-age=10, s-maxage=10" });
  } catch (err) {
    console.error(err);
    return error(502, "upstream", "No pudimos obtener la ubicación de los colectivos.");
  }
});
