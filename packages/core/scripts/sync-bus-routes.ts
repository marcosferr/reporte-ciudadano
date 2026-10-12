/** Carga en la base local los recorridos de los colectivos (en AWS lo hace la Lambda BusRoutesSync cada día). */
import { syncBusRoutes } from "../src/bus-routes";
import { closeDb } from "../src/db";

process.env.DATABASE_URL ??= "postgres://postgres:password@localhost:5433/reporte";
const { routes, failed, skipped } = await syncBusRoutes();
console.log(`Recorridos cargados: ${routes}${failed.length ? ` (fallaron las empresas ${failed.join(", ")})` : ""}${skipped.length ? ` (sin pedir: ${skipped.join(", ")})` : ""}`);
await closeDb();
