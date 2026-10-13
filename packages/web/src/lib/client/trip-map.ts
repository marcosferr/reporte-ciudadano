/**
 * Mapa de ¿Cuándo salgo?: la parada, los recorridos de las líneas elegidas y sus buses. No carga los tiles de reportes:
 * pedirlos alrededor de la parada le diría al servidor dónde está. El mapa base (OpenFreeMap) sí ve la zona, por eso
 * se muestra solo al configurar o si la persona lo pide.
 */
import * as maplibregl from "maplibre-gl";
import type { LngLat } from "@rc/core/geo";
import { chevronIcon } from "./buses";
import { ASU_BOUNDS, BASEMAP_STYLE, collapseAttribution } from "./map";

export interface MapRoute { coords: LngLat[] | LngLat[][]; color: string }
export interface MapBus { lngLat: LngLat; color: string; label: string }

const empty: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

export function tripMap(container: HTMLElement, { onClick }: { onClick?: (p: LngLat) => void } = {}) {
  const map = new maplibregl.Map({
    container, style: BASEMAP_STYLE, bounds: ASU_BOUNDS, fitBoundsOptions: { padding: 24 },
    maxBounds: [[-66, -30], [-51, -16]], attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false,
  });
  collapseAttribution(map);
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  // La ubicación la calcula el teléfono; no se manda a ningún lado.
  map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, fitBoundsOptions: { maxZoom: 16 } }), "top-right");

  let pending: { stop?: LngLat | null; routes?: MapRoute[]; buses?: MapBus[] } = {};
  let loaded = false;

  const source = (id: string) => map.getSource(id) as maplibregl.GeoJSONSource | undefined;
  const lines = (routes: MapRoute[]): GeoJSON.FeatureCollection => ({
    type: "FeatureCollection",
    features: routes.map((r) => ({
      type: "Feature", properties: { color: r.color },
      geometry: typeof r.coords[0]?.[0] === "number" ? { type: "LineString", coordinates: r.coords as LngLat[] } : { type: "MultiLineString", coordinates: r.coords as LngLat[][] },
    })),
  });
  const point = (p: LngLat | null | undefined): GeoJSON.FeatureCollection => ({
    type: "FeatureCollection", features: p ? [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: p } }] : [],
  });
  const buses = (list: MapBus[]): GeoJSON.FeatureCollection => ({
    type: "FeatureCollection",
    features: list.map((b) => ({ type: "Feature", properties: { color: b.color, label: b.label }, geometry: { type: "Point", coordinates: b.lngLat } })),
  });

  function apply() {
    if (!loaded) return;
    if (pending.routes) source("trip-routes")?.setData(lines(pending.routes));
    if (pending.stop !== undefined) source("trip-stop")?.setData(point(pending.stop));
    if (pending.buses) source("trip-buses")?.setData(buses(pending.buses));
    pending = {};
  }

  map.on("load", () => {
    map.addImage("rc-trip-chevron", chevronIcon(), { pixelRatio: 2 });
    map.addSource("trip-routes", { type: "geojson", data: empty });
    map.addSource("trip-stop", { type: "geojson", data: empty });
    map.addSource("trip-buses", { type: "geojson", data: empty, attribution: "Colectivos: VMT/MOPC (prototipo)" });
    map.addLayer({
      id: "trip-routes", type: "line", source: "trip-routes", layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["get", "color"], "line-width": ["interpolate", ["linear"], ["zoom"], 11, 3, 16, 7], "line-opacity": 0.8 },
    });
    map.addLayer({
      id: "trip-route-arrows", type: "symbol", source: "trip-routes",
      layout: { "symbol-placement": "line", "symbol-spacing": 70, "icon-image": "rc-trip-chevron", "icon-size": 0.8, "icon-allow-overlap": true },
    });
    map.addLayer({
      id: "trip-buses", type: "circle", source: "trip-buses",
      paint: { "circle-color": ["get", "color"], "circle-radius": 9, "circle-stroke-width": 2, "circle-stroke-color": "#fff" },
    });
    map.addLayer({
      id: "trip-bus-labels", type: "symbol", source: "trip-buses",
      layout: { "text-field": ["get", "label"], "text-font": ["Noto Sans Bold"], "text-size": 12, "text-offset": [0, 1.6], "text-anchor": "top", "text-optional": true },
      paint: { "text-color": ["get", "color"], "text-halo-color": "#fff", "text-halo-width": 1.5 },
    });
    map.addLayer({
      id: "trip-stop", type: "circle", source: "trip-stop",
      paint: { "circle-color": "#fff", "circle-radius": 10, "circle-stroke-width": 5, "circle-stroke-color": "#0e1f1b" },
    });
    map.addLayer({
      id: "trip-stop-label", type: "symbol", source: "trip-stop",
      layout: { "text-field": "Tu parada", "text-font": ["Noto Sans Bold"], "text-size": 13, "text-offset": [0, 1.4], "text-anchor": "top" },
      paint: { "text-color": "#0e1f1b", "text-halo-color": "#fff", "text-halo-width": 2 },
    });
    loaded = true;
    apply();
  });
  if (onClick) map.on("click", (e) => onClick([e.lngLat.lng, e.lngLat.lat]));

  return {
    setStop(p: LngLat | null) {
      pending.stop = p;
      apply();
    },
    setRoutes(routes: MapRoute[]) {
      pending.routes = routes;
      apply();
    },
    setBuses(list: MapBus[]) {
      pending.buses = list;
      apply();
    },
    /** Encuadra los puntos dados (p. ej. la parada y los buses). */
    fit(points: LngLat[], maxZoom = 16) {
      if (!points.length) return;
      const b = new maplibregl.LngLatBounds(points[0], points[0]);
      for (const p of points) b.extend(p);
      map.fitBounds(b, { padding: 48, maxZoom, duration: 600 });
    },
    flyTo(p: LngLat, zoom = 16) {
      map.flyTo({ center: p, zoom });
    },
    /** Acerca el mapa al punto si está lejos (para confirmar dónde quedó la parada), sin alejarlo si ya está cerca. */
    focus(p: LngLat, minZoom = 16) {
      if (map.getZoom() < minZoom) map.flyTo({ center: p, zoom: minZoom });
    },
    destroy() {
      map.remove();
    },
  };
}
