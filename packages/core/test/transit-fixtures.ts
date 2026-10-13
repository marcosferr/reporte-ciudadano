/** Recorridos y buses sintéticos en metros alrededor de un origen en Asunción, para los tests de ¿Cuándo salgo?. */
import type { CatalogFeature, CatalogProps } from "../src/bus-catalog";
import type { LngLat } from "../src/geo";

export const LAT = -25.3;
const DLNG = 1 / (111_320 * Math.cos((LAT * Math.PI) / 180));
const DLAT = 1 / 111_320;

/** Un punto a `x` m al este y `y` m al norte del origen. */
export const at = (x: number, y = 0): LngLat => [-57.6 + x * DLNG, LAT + y * DLAT];

/** Un recorrido que une los puntos dados (en metros), en ese orden. */
export function route(company: number, hex: string, pts: [number, number][], props: Partial<CatalogProps> = {}): CatalogFeature {
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: pts.map(([x, y]) => at(x, y)) },
    properties: { company, companyName: "EMPRESA SA", route: hex, line: "41", direction: "ida", from: "LAMBARÉ", to: "ASUNCIÓN", ...props },
  };
}

export const file = (features: CatalogFeature[], version = "v1") => ({ type: "FeatureCollection" as const, version, features });
