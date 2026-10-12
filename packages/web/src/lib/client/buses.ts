import { Popup, type ExpressionSpecification, type GeoJSONSource, type Map as MLMap, type MapLayerMouseEvent } from "maplibre-gl";
import { timeAgo } from "../format";
import { trackHeadings, type Track } from "./bus-heading";

/** Un colectivo como lo devuelve /api/buses (ver lib/server/buses.ts). */
interface BusProps {
  id: number; line: string | null; company: string; companyCode: number; route: string | null;
  ramp: boolean; speed: number; at: string; heading?: number;
}
// `heading`: rumbo del bus (bus-heading.ts); sin él, el bus no lleva flecha.
interface Bus { type: "Feature"; geometry: { type: "Point"; coordinates: [number, number] }; properties: BusProps & { color: string } }
interface Route { type: "Feature"; geometry: GeoJSON.Geometry; properties: { line: string | null; direction: string | null; from: string | null; to: string | null } }

const REFRESH_MS = 10_000;
// Cada bus avanza de a poco hasta su última posición durante todo el intervalo, así el mapa se ve en movimiento
// sin pedir datos más seguido (los buses reportan cada ~10 s). Se redibuja ~12 veces por segundo, no en cada frame.
const GLIDE_MS = REFRESH_MS;
const GLIDE_FRAME_MS = 80;
// Un salto más largo que esto (~1 km) no se anima: el bus estuvo sin señal.
const MAX_GLIDE_DEG = 0.01;
const NO_LINE_COLOR = "#495057";
// Como en Google Maps, cada línea tiene su color, y el mismo número de línea cae siempre en el mismo.
const LINE_COLORS = ["#d6336c", "#1971c2", "#2b8a3e", "#e8590c", "#7048e8", "#0c8599", "#c2255c", "#5c940d", "#9c36b5", "#1864ab", "#d9480f", "#087f5b"];

// Ícono "directions_bus" de Material Icons (Google, Apache-2.0), el mismo dibujo de colectivo que usa Google Maps.
const BUS_PATH = "M4 16c0 .88.39 1.67 1 2.22V20c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h8v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1.78c.61-.55 1-1.34 1-2.22V6c0-3.5-3.58-4-8-4s-8 .5-8 4v10zm3.5 1c-.83 0-1.5-.67-1.5-1.5S6.67 14 7.5 14s1.5.67 1.5 1.5S8.33 17 7.5 17zm9 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm1.5-6H6V6h12v5z";
// Íconos al doble de resolución (pixelRatio 2). El de rumbo comparte centro con el del bus y asoma por encima.
const BUS_SIZE = 56, HEADING_SIZE = 116, BADGE_SIZE = 26;
const BUS_LAYERS = ["bus-dots", "bus-heading", "bus-points", "bus-ramp", "bus-labels", "bus-route", "bus-route-arrows"];

export function lineColor(line: string | null): string {
  if (!line) return NO_LINE_COLOR;
  let h = 0;
  for (const ch of line.split(" - ")[0]) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return LINE_COLORS[h % LINE_COLORS.length];
}

function canvas(size: number) {
  const ctx = document.createElement("canvas").getContext("2d")!;
  ctx.canvas.width = ctx.canvas.height = size;
  return ctx;
}

/** Cuadrado redondeado del color de la línea con el colectivo en blanco. No gira: el rumbo lo marca la flecha. */
function busIcon(color: string): ImageData {
  const ctx = canvas(BUS_SIZE);
  ctx.beginPath();
  ctx.roundRect(2, 2, BUS_SIZE - 4, BUS_SIZE - 4, 12);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#fff";
  ctx.stroke();
  // El path es de 24x24: se agranda a 34 px y se centra.
  ctx.translate((BUS_SIZE - 34) / 2, (BUS_SIZE - 34) / 2);
  ctx.scale(34 / 24, 34 / 24);
  ctx.fillStyle = "#fff";
  ctx.fill(new Path2D(BUS_PATH));
  return ctx.getImageData(0, 0, BUS_SIZE, BUS_SIZE);
}

/** Flecha que asoma por arriba del ícono del bus; la capa la gira según el rumbo. */
function headingIcon(): ImageData {
  const ctx = canvas(HEADING_SIZE), c = HEADING_SIZE / 2, edge = c - BUS_SIZE / 2;
  ctx.beginPath();
  ctx.moveTo(c, 2);
  ctx.lineTo(c + 17, edge + 8);
  ctx.lineTo(c - 17, edge + 8);
  ctx.closePath();
  ctx.fillStyle = "#343a40";
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#fff";
  ctx.stroke();
  return ctx.getImageData(0, 0, HEADING_SIZE, HEADING_SIZE);
}

/** Insignia de accesibilidad (bus con rampa), en la esquina del ícono. */
function rampIcon(): ImageData {
  const ctx = canvas(BADGE_SIZE), c = BADGE_SIZE / 2;
  ctx.beginPath();
  ctx.arc(c, c, c - 1, 0, Math.PI * 2);
  ctx.fillStyle = "#1971c2";
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#fff";
  ctx.stroke();
  ctx.fillStyle = "#fff";
  ctx.font = "bold 16px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("♿", c, c + 1);
  return ctx.getImageData(0, 0, BADGE_SIZE, BADGE_SIZE);
}

/** Chevron blanco que marca el sentido a lo largo del recorrido. */
function chevronIcon(): ImageData {
  const ctx = canvas(20);
  ctx.beginPath();
  ctx.moveTo(6, 4);
  ctx.lineTo(14, 10);
  ctx.lineTo(6, 16);
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#fff";
  ctx.stroke();
  return ctx.getImageData(0, 0, 20, 20);
}

function addLayers(map: MLMap) {
  map.addImage("rc-bus-heading", headingIcon(), { pixelRatio: 2 });
  map.addImage("rc-bus-ramp", rampIcon(), { pixelRatio: 2 });
  map.addImage("rc-bus-chevron", chevronIcon(), { pixelRatio: 2 });
  // Un ícono por color de línea ("bus" a secas ya está en el sprite de la base).
  for (const color of [...LINE_COLORS, NO_LINE_COLOR]) map.addImage(`rc-bus-${color}`, busIcon(color), { pixelRatio: 2 });
  const empty: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
  map.addSource("buses", { type: "geojson", data: empty, attribution: "Colectivos: VMT/MOPC (prototipo)" });
  map.addSource("bus-route", { type: "geojson", data: empty });

  const size: ExpressionSpecification = ["interpolate", ["linear"], ["zoom"], 12, 0.8, 16, 1.1];
  const hidden = { visibility: "none" as const };
  // Debajo de los reportes, para no taparlos.
  const before = "clusters";
  map.addLayer({
    id: "bus-route", type: "line", source: "bus-route", layout: { ...hidden, "line-cap": "round", "line-join": "round" },
    paint: { "line-color": ["get", "color"], "line-width": ["interpolate", ["linear"], ["zoom"], 11, 3, 16, 7], "line-opacity": 0.85 },
  }, before);
  map.addLayer({
    id: "bus-route-arrows", type: "symbol", source: "bus-route",
    layout: { ...hidden, "symbol-placement": "line", "symbol-spacing": 70, "icon-image": "rc-bus-chevron", "icon-size": 0.8, "icon-allow-overlap": true },
  }, before);
  // Lejos, un punto por bus: cientos de íconos se vuelven una mancha.
  map.addLayer({
    id: "bus-dots", type: "circle", source: "buses", maxzoom: 12, layout: hidden,
    paint: { "circle-color": ["get", "color"], "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 3, 12, 6], "circle-stroke-width": 1, "circle-stroke-color": "#fff" },
  }, before);
  map.addLayer({
    id: "bus-heading", type: "symbol", source: "buses", minzoom: 12, filter: ["has", "heading"],
    layout: {
      ...hidden, "icon-image": "rc-bus-heading", "icon-rotate": ["get", "heading"], "icon-rotation-alignment": "map",
      "icon-allow-overlap": true, "icon-ignore-placement": true, "icon-size": size,
    },
  }, before);
  map.addLayer({
    id: "bus-points", type: "symbol", source: "buses", minzoom: 12,
    layout: { ...hidden, "icon-image": ["concat", "rc-bus-", ["get", "color"]], "icon-allow-overlap": true, "icon-ignore-placement": true, "icon-size": size },
  }, before);
  map.addLayer({
    id: "bus-ramp", type: "symbol", source: "buses", minzoom: 14, filter: ["==", ["get", "ramp"], true],
    layout: { ...hidden, "icon-image": "rc-bus-ramp", "icon-offset": [14, -14], "icon-allow-overlap": true, "icon-ignore-placement": true, "icon-size": size },
  }, before);
  map.addLayer({
    id: "bus-labels", type: "symbol", source: "buses", minzoom: 13,
    layout: {
      ...hidden, "text-field": ["coalesce", ["get", "line"], ""], "text-font": ["Noto Sans Bold"], "text-size": 12,
      "text-offset": [0, 2], "text-anchor": "top", "text-optional": true,
    },
    paint: { "text-color": ["get", "color"], "text-halo-color": "#fff", "text-halo-width": 1.5 },
  }, before);
}

/**
 * Colectivos en vivo sobre el mapa: los pide cada 10 s mientras la capa está prendida y la pestaña a la vista,
 * los desliza a su nueva posición y, al tocar uno, dibuja su recorrido completo.
 */
export function busLayer(map: MLMap) {
  addLayers(map);
  let on = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let ctrl: AbortController | undefined;
  let frame = 0;
  let shown: Bus[] = [];
  let tracks = new Map<number, Track>();
  let selected: { id: number; popup: Popup } | undefined;

  const source = (id: string) => map.getSource(id) as GeoJSONSource | undefined;

  function draw(buses: Bus[]) {
    shown = buses;
    source("buses")?.setData({ type: "FeatureCollection", features: shown });
    const s = selected;
    const sel = s && shown.find((b) => b.properties.id === s.id);
    if (s && sel) s.popup.setLngLat(sel.geometry.coordinates);
  }

  /** Desliza cada bus desde donde se lo ve ahora hasta su nueva posición. */
  function glide(next: Bus[]) {
    cancelAnimationFrame(frame);
    const from = new Map(shown.map((b) => [b.properties.id, b.geometry.coordinates]));
    const start = performance.now();
    let drawn = -Infinity;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / GLIDE_MS);
      if (t < 1 && now - drawn < GLIDE_FRAME_MS) {
        frame = requestAnimationFrame(step);
        return;
      }
      drawn = now;
      draw(next.map((b) => {
        const a = from.get(b.properties.id), [x, y] = b.geometry.coordinates;
        if (!a || t === 1 || Math.abs(a[0] - x) + Math.abs(a[1] - y) > MAX_GLIDE_DEG) return b;
        return { ...b, geometry: { type: "Point", coordinates: [a[0] + (x - a[0]) * t, a[1] + (y - a[1]) * t] } };
      }));
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  }

  async function load() {
    if (document.visibilityState !== "visible") return;
    ctrl?.abort();
    ctrl = new AbortController();
    try {
      const res = await fetch("/api/buses", { signal: ctrl.signal });
      if (!res.ok) return;
      const data = (await res.json()) as { features: { type: "Feature"; geometry: Bus["geometry"]; properties: BusProps }[] };
      tracks = trackHeadings(tracks, data.features.map((f) => ({ id: f.properties.id, at: f.geometry.coordinates, heading: f.properties.heading })));
      glide(data.features.map((f) => {
        const heading = tracks.get(f.properties.id)?.heading;
        return { ...f, properties: { ...f.properties, color: lineColor(f.properties.line), ...(heading === undefined ? {} : { heading }) } };
      }));
    } catch {
      /* sin conexión o cancelado: queda la última posición */
    }
  }

  /** Resalta el bus elegido (los demás quedan tenues) o, sin elegido, los muestra a todos igual. */
  function highlight(id: number | undefined) {
    const opacity: ExpressionSpecification | number = id === undefined ? 1 : ["case", ["==", ["get", "id"], id], 1, 0.3];
    for (const layer of ["bus-heading", "bus-points", "bus-ramp"]) map.setPaintProperty(layer, "icon-opacity", opacity);
    map.setPaintProperty("bus-labels", "text-opacity", opacity);
    map.setPaintProperty("bus-dots", "circle-opacity", opacity);
  }

  function unselect() {
    selected = undefined;
    highlight(undefined);
    source("bus-route")?.setData({ type: "FeatureCollection", features: [] });
  }

  async function select(bus: Bus) {
    const p = bus.properties;
    const content = popupContent(p);
    const popup = new Popup({ offset: 16, maxWidth: "280px", closeButton: false })
      .setLngLat(bus.geometry.coordinates).setDOMContent(content.root).addTo(map);
    // Tocar otro bus cierra este popup: solo limpia si sigue siendo el elegido.
    popup.on("close", () => selected?.popup === popup && unselect());
    selected = { id: p.id, popup };
    highlight(p.id);
    source("bus-route")?.setData({ type: "FeatureCollection", features: [] });
    if (!p.route) return;
    try {
      const res = await fetch(`/api/buses/route?${new URLSearchParams({ company: String(p.companyCode), route: p.route })}`);
      if (selected?.popup !== popup) return;
      if (res.status === 404) content.setRoute(null);
      if (!res.ok) return;
      const route = (await res.json()) as Route;
      source("bus-route")?.setData({ ...route, properties: { ...route.properties, color: p.color } });
      content.setRoute(route.properties);
    } catch {
      /* sin recorrido: queda solo el bus */
    }
  }

  const onClick = (e: MapLayerMouseEvent) => {
    const id = e.features?.[0]?.properties?.id;
    const bus = shown.find((b) => b.properties.id === id);
    if (bus) select(bus);
  };
  map.on("click", "bus-points", onClick);
  map.on("click", "bus-dots", onClick);
  for (const layer of ["bus-points", "bus-dots"]) {
    map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
  }

  return {
    show(visible: boolean) {
      if (visible === on) return;
      on = visible;
      for (const id of BUS_LAYERS) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
      if (on) {
        load();
        timer = setInterval(load, REFRESH_MS);
        document.addEventListener("visibilitychange", load);
      } else {
        clearInterval(timer);
        document.removeEventListener("visibilitychange", load);
        ctrl?.abort();
        cancelAnimationFrame(frame);
        selected?.popup.remove();
        // Al volver a prenderla, el movimiento desde una posición vieja no dice hacia dónde va el bus.
        tracks = new Map();
      }
    },
    destroy() {
      this.show(false);
    },
  };
}

function popupContent(p: BusProps & { color: string }) {
  const root = document.createElement("div");
  root.className = "p-3";
  const head = document.createElement("p");
  head.className = "flex items-center gap-2 font-semibold text-fg";
  const badge = document.createElement("span");
  badge.className = "rounded-md px-1.5 py-0.5 text-xs font-bold text-white";
  badge.style.background = p.color;
  badge.textContent = p.line ?? "Sin línea";
  const company = document.createElement("span");
  company.className = "truncate text-sm";
  company.textContent = p.company;
  head.append(badge, company);
  const route = document.createElement("p");
  route.className = "mt-1 text-sm text-fg-muted";
  route.textContent = p.route ? "" : "Sin recorrido asignado";
  const meta = document.createElement("p");
  meta.className = "mt-1 text-xs text-fg-subtle";
  meta.textContent = [p.ramp ? "♿ Con rampa" : null, p.speed > 0 ? `${Math.round(p.speed)} km/h` : "Detenido", timeAgo(p.at)].filter(Boolean).join(" · ");
  root.append(head, route, meta);
  return {
    root,
    /** `null`: el VMT no publicó el recorrido que reporta el bus. */
    setRoute(r: Route["properties"] | null) {
      if (!r) {
        route.textContent = "Recorrido no publicado por el VMT";
        return;
      }
      // El VMT a veces no manda los extremos o el sentido.
      const ends = r.from && r.to ? `De ${capitalize(r.from)} a ${capitalize(r.to)}` : null;
      route.textContent = [ends, r.direction].filter(Boolean).join(" · ");
    },
  };
}

// El VMT escribe los lugares en mayúsculas ("LAMBARÉ").
function capitalize(s: string): string {
  return s.toLowerCase().replace(/(^|[\s(-])\p{L}/gu, (m) => m.toUpperCase());
}
