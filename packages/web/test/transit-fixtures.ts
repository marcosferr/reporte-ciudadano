/** Recorridos sintéticos para los tests de ¿Cuándo salgo? en el navegador (en metros alrededor de Asunción). */
import type { CatalogFile } from "@rc/core/bus-catalog";
import type { LngLat } from "@rc/core/geo";
import type { BusFeature } from "../src/lib/server/buses";

const LAT = -25.3;
const DLNG = 1 / (111_320 * Math.cos((LAT * Math.PI) / 180));
const DLAT = 1 / 111_320;
export const at = (x: number, y = 0): LngLat => [-57.6 + x * DLNG, LAT + y * DLAT];

/** El 41 va 10 km hacia el este (x de -5000 a 5000); el 30 va hacia el oeste por la misma calle. */
export const catalogFile = (version = "v1"): CatalogFile => ({
  type: "FeatureCollection", version,
  features: [
    {
      type: "Feature", geometry: { type: "LineString", coordinates: [at(-5000, 5), at(5000, 5)] },
      properties: { company: 22, companyName: "LINCE SRL", route: "00a1", line: "41", direction: "ida", from: "LAMBARÉ", to: "ASUNCIÓN" },
    },
    {
      type: "Feature", geometry: { type: "LineString", coordinates: [at(5000, -5), at(-5000, -5)] },
      properties: { company: 44, companyName: "VANGUARDIA SACI", route: "0100", line: "30", direction: "vuelta", from: "ASUNCIÓN", to: "LUQUE" },
    },
  ],
});

export const busFeature = (id: number, x: number, at_: number, extra: Partial<BusFeature["properties"]> = {}): BusFeature => ({
  type: "Feature", geometry: { type: "Point", coordinates: at(x, 5) },
  properties: { id, line: "41 - 1", company: "LINCE SRL", companyCode: 22, route: "00a1", ramp: false, speed: 20, at: new Date(at_).toISOString(), heading: 90, ...extra },
});

export function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}
