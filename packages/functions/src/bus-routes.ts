import { syncBusRoutes } from "@rc/core/bus-routes";
import { rawItinerariesKey } from "@rc/core/vmt-history";
import type { Context } from "aws-lambda";
import { putJsonGz } from "./vmt-store";

// Lo que puede tardar la última empresa pedida (60 s) más guardar en la base.
const MARGIN_MS = 90_000;

/** Una vez por día (infra/buses.ts): trae del VMT los recorridos de los colectivos a la base y guarda la respuesta cruda. */
export async function handler(_event: unknown, context: Context) {
  const { snapshot, ...result } = await syncBusRoutes({ deadline: Date.now() + context.getRemainingTimeInMillis() - MARGIN_MS });
  // La foto del día es el historial de recorridos: con ella se sabe qué trazado tenía cada ruta en una fecha.
  await putJsonGz(rawItinerariesKey(new Date(snapshot.synced_at)), snapshot);
  console.log("recorridos sincronizados", result);
  return result;
}
