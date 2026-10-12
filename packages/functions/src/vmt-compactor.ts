import { addDays, DayCompactor, localParts, pollKeysForDay, positionsKey, rawBusesPrefix, saveRouteActivity, type BusPoll } from "@rc/core/vmt-history";
import { getJsonGz, listKeys, putParquet } from "./vmt-store";

// Archivos leídos a la vez: cada uno pesa ~30 KB comprimido.
const CONCURRENCY = 16;

/**
 * Una vez por día (infra/buses.ts): junta las consultas del día anterior en un Parquet y guarda la actividad por
 * hora y recorrido. Para volver a compactar un día se invoca a mano con `{ "date": "AAAA-MM-DD" }`.
 */
export async function handler(event?: { date?: string }) {
  const date = event?.date ?? addDays(localParts(new Date()).date, -1);
  const listed = (await Promise.all([listKeys(rawBusesPrefix(date)), listKeys(rawBusesPrefix(addDays(date, 1)))])).flat();
  const keys = pollKeysForDay(date, listed);
  const day = new DayCompactor(date);
  let failed = 0;
  const queue = [...keys];
  async function worker() {
    for (let key = queue.shift(); key; key = queue.shift()) {
      try {
        day.add(await getJsonGz<BusPoll>(key));
      } catch (err) {
        console.error("consulta ilegible", key, err);
        failed++;
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (!day.size) {
    console.warn("sin reportes para compactar", { date, files: keys.length });
    return { date, files: keys.length, positions: 0 };
  }
  const activity = day.activity();
  await putParquet(positionsKey(date), day.parquet());
  await saveRouteActivity(date, activity);
  const result = { date, files: keys.length, failed, positions: day.size, activityRows: activity.length };
  console.log("día compactado", result);
  return result;
}
