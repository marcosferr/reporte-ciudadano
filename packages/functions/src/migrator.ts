import path from "node:path";
import { syncBusRoutesIfEmpty } from "@rc/core/bus-routes";
import { sql } from "@rc/core/db";
import { runMigrations } from "@rc/core/migrate";
import { seedAreasIfEmpty } from "@rc/core/seed-areas";
import type { Context } from "aws-lambda";

// Tiempo que el deploy espera por los recorridos, y lo que puede tardar la última empresa pedida más guardarlos.
const BUS_ROUTES_BUDGET_MS = 3 * 60 * 1000;
const MARGIN_MS = 90_000;

export async function handler(_event: unknown, context: Context) {
  // `copyFiles` deja las migraciones junto al bundle.
  const applied = await runMigrations(sql(), path.join(process.cwd(), "migrations"));
  // En el primer deploy carga departamentos y distritos (descarga desde geoBoundaries vía NAT).
  const seeded = await seedAreasIfEmpty();
  // Y los recorridos de los colectivos, que después actualiza BusRoutesSync. El VMT es un prototipo: si no
  // responde o está lento, el deploy sigue con lo que llegó y el resto lo carga la corrida del día siguiente.
  // Un timeout de la Lambda no lo atrapa el catch y haría fallar el deploy, por eso el plazo.
  const deadline = Date.now() + Math.min(BUS_ROUTES_BUDGET_MS, context.getRemainingTimeInMillis() - MARGIN_MS);
  const busRoutes = await syncBusRoutesIfEmpty({ deadline }).catch((err: unknown) => {
    console.error("recorridos de colectivos", err);
    return false;
  });
  console.log("migraciones aplicadas", applied, "áreas cargadas", seeded, "recorridos cargados", busRoutes);
  return { applied, seeded, busRoutes };
}
