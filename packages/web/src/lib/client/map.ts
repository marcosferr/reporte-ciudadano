import { setWorkerUrl, type Map as MLMap } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

// MapLibre 6 es solo ESM y con bundlers hay que indicarle la URL de su worker (Vite la empaqueta aparte).
setWorkerUrl(workerUrl);

// OpenFreeMap: teselas vectoriales de OSM gratuitas y sin API key.
export const BASEMAP_STYLE = "https://tiles.openfreemap.org/styles/positron";
export const PY_CENTER: [number, number] = [-57.58, -25.3];
// Vista inicial por defecto (y para quien todavía no nos contó de dónde es).
export const ASU_BOUNDS: [[number, number], [number, number]] = [[-57.68, -25.38], [-57.52, -25.21]];
export const PY_BOUNDS: [[number, number], [number, number]] = [[-62.8, -27.7], [-54.2, -19.2]];

export const STATUS_COLORS: Record<string, string> = {
  nuevo: "#1c7ed6", verificado: "#7048e8", en_proceso: "#f08c00", derivado: "#e8590c",
  resuelto: "#2f9e44", rechazado: "#868e96", duplicado: "#868e96",
};

export function tileUrl(filters: { category?: string; status?: string }) {
  const q = new URLSearchParams();
  if (filters.category) q.set("category", filters.category);
  if (filters.status) q.set("status", filters.status);
  const qs = q.toString();
  return `${location.origin}/tiles/{z}/{x}/{y}.pbf${qs ? `?${qs}` : ""}`;
}

/** Agrega la fuente y las capas de reportes (clusters en zoom bajo, puntos en zoom alto). */
export function addReportLayers(map: MLMap, filters: { category?: string; status?: string }) {
  map.addSource("reports", { type: "vector", tiles: [tileUrl(filters)], minzoom: 0, maxzoom: 16 });
  map.addLayer({
    id: "clusters", type: "circle", source: "reports", "source-layer": "clusters",
    paint: {
      "circle-color": ["case", [">=", ["/", ["get", "resolved"], ["max", ["get", "count"], 1]], 0.5], "#2f9e44", "#d6336c"],
      "circle-opacity": 0.85,
      "circle-radius": ["interpolate", ["linear"], ["get", "count"], 1, 12, 10, 18, 100, 26, 1000, 36],
      "circle-stroke-width": 3, "circle-stroke-color": "#fff",
    },
  });
  map.addLayer({
    id: "cluster-count", type: "symbol", source: "reports", "source-layer": "clusters",
    layout: { "text-field": ["to-string", ["get", "count"]], "text-size": 12, "text-font": ["Noto Sans Bold"], "text-allow-overlap": true },
    paint: { "text-color": "#fff" },
  });
  map.addLayer({
    id: "report-points", type: "circle", source: "reports", "source-layer": "reports",
    paint: {
      "circle-color": ["get", "color"],
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 6, 16, 11],
      "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 11, 2, 16, 4],
      "circle-stroke-color": ["match", ["get", "status"], "resuelto", "#2f9e44", "en_proceso", "#f08c00", "derivado", "#e8590c", "#ffffff"],
      "circle-opacity": ["match", ["get", "status"], "resuelto", 0.55, 1],
    },
  });
}

export function setReportFilters(map: MLMap, filters: { category?: string; status?: string }) {
  const src = map.getSource("reports") as any;
  src?.setTiles([tileUrl(filters)]);
}

/** En pantallas chicas la atribución arranca expandida y tapa el mapa; se muestra colapsada (ícono ⓘ). */
export function collapseAttribution(map: MLMap) {
  const collapse = () => map.getContainer().querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
  map.once("load", collapse);
  map.once("idle", collapse);
}
