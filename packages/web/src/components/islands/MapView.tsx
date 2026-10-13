import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { STATUS_LABEL, type Status } from "@rc/core/status";
import { timeAgo } from "../../lib/format";
import { busLayer } from "../../lib/client/buses";
import { addReportLayers, ASU_BOUNDS, BASEMAP_STYLE, setReportFilters, STATUS_COLORS, collapseAttribution } from "../../lib/client/map";

interface Category { slug: string; name: string; icon: string; color: string }
interface ListItem {
  code: string; path: string; title: string; status: Status; category: string; icon: string; color: string;
  lat: number; lng: number; created_at: string; place: string; cover: string | null; confirmations: number;
}

const STATUS_FILTERS = [
  { value: "abiertos", label: "Abiertos" },
  { value: "resuelto", label: "Resueltos" },
  { value: "", label: "Todos" },
];

type BBox = [number, number, number, number];
const toBounds = (b: BBox): [[number, number], [number, number]] => [[b[0], b[1]], [b[2], b[3]]];

/** Vista inicial: la URL, si no la última vista de esta pestaña, si no la ciudad del usuario, si no Asunción. */
export default function MapView({ categories, initial, home }: {
  categories: Category[]; initial?: { lat: number; lng: number; zoom: number }; home?: { bbox: BBox };
}) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map>(undefined);
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState("abiertos");
  const [items, setItems] = useState<ListItem[]>([]);
  const [sheet, setSheet] = useState<"peek" | "open">("peek");
  const [loading, setLoading] = useState(false);
  const [buses, setBuses] = useState(readBuses);
  const busesRef = useRef<ReturnType<typeof busLayer>>(undefined);
  const [mapReady, setMapReady] = useState(false);
  const filters = useMemo(() => ({ category: category || undefined, status: status || undefined }), [category, status]);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  useEffect(() => {
    const saved = readView();
    const map = new maplibregl.Map({
      container: el.current!,
      style: BASEMAP_STYLE,
      ...(initial ? { center: [initial.lng, initial.lat], zoom: initial.zoom } : saved ? { center: saved.center, zoom: saved.zoom }
        : { bounds: home ? toBounds(home.bbox) : ASU_BOUNDS, fitBoundsOptions: { padding: 24 } }),
      maxBounds: [[-66, -30], [-51, -16]],
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
    });
    collapseAttribution(map);
    mapRef.current = map;
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    const geo = new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, fitBoundsOptions: { maxZoom: 15 } });
    map.addControl(geo, "top-right");

    map.on("load", () => {
      addReportLayers(map, filtersRef.current);
      busesRef.current = busLayer(map);
      setMapReady(true);
      refreshList();
    });
    map.on("moveend", () => {
      saveView(map);
      refreshList();
    });
    map.on("click", "clusters", (e) => {
      const f = e.features?.[0];
      if (f) map.easeTo({ center: (f.geometry as any).coordinates, zoom: Math.min(map.getZoom() + 3, 14) });
    });
    map.on("click", "report-points", (e) => {
      const f = e.features?.[0];
      if (!f) return;
      const p = f.properties as any;
      new maplibregl.Popup({ offset: 12, maxWidth: "260px", closeButton: false })
        .setLngLat((f.geometry as any).coordinates)
        .setDOMContent(popupContent(p))
        .addTo(map);
    });
    for (const layer of ["clusters", "report-points"]) {
      map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
    }
    // "Contanos de dónde sos": al guardar la ciudad, el mapa va hacia ella.
    const onHome = (e: Event) => map.fitBounds(toBounds((e as CustomEvent<BBox>).detail), { padding: 40 });
    window.addEventListener("rc:home", onHome);
    return () => {
      window.removeEventListener("rc:home", onHome);
      busesRef.current?.destroy();
      map.remove();
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded() || !map.getSource("reports")) return;
    setReportFilters(map, filters);
    refreshList();
  }, [filters]);

  useEffect(() => {
    if (!mapReady) return;
    busesRef.current?.show(buses);
    saveBuses(buses);
  }, [buses, mapReady]);

  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  function refreshList() {
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const map = mapRef.current;
      if (!map) return;
      const b = map.getBounds();
      const q = new URLSearchParams({ bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((n) => n.toFixed(4)).join(","), limit: "40" });
      const f = filtersRef.current;
      if (f.category) q.set("category", f.category);
      if (f.status) q.set("status", f.status);
      setLoading(true);
      try {
        const res = await fetch(`/api/reports?${q}`);
        if (res.ok) setItems(await res.json());
      } finally {
        setLoading(false);
      }
    }, 250);
  }

  function flyTo(it: ListItem) {
    mapRef.current?.flyTo({ center: [it.lng, it.lat], zoom: 16 });
    setSheet("peek");
  }

  return (
    <div className="home-map relative h-full w-full">
      <div ref={el} className="h-full w-full" role="region" aria-label="Mapa de reportes" />

      {/* Filtros */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 space-y-2 p-3">
        <div className="pointer-events-auto flex gap-1 overflow-x-auto pb-1 [scrollbar-width:none]">
          <FilterChip active={!category} onClick={() => setCategory("")}>Todas</FilterChip>
          {categories.map((c) => (
            <FilterChip key={c.slug} active={category === c.slug} onClick={() => setCategory(category === c.slug ? "" : c.slug)} color={c.color}>
              <span aria-hidden>{c.icon}</span> {c.name}
            </FilterChip>
          ))}
        </div>
        <div className="pointer-events-auto flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none]">
          <div className="inline-flex shrink-0 rounded-xl bg-surface p-1 shadow ring-1 ring-line">
            {STATUS_FILTERS.map((s) => (
              <button key={s.value} onClick={() => setStatus(s.value)}
                className={`rounded-lg px-2 py-1.5 text-xs font-semibold sm:px-3 ${status === s.value ? "bg-brand-600 text-white" : "text-fg-muted"}`}>
                {s.label}
              </button>
            ))}
          </div>
          <button onClick={() => setBuses(!buses)} aria-pressed={buses}
            className={`shrink-0 whitespace-nowrap rounded-xl px-3 text-xs font-semibold shadow ring-1 ${buses ? "bg-brand-600 text-white ring-transparent" : "bg-surface text-fg-muted ring-line"}`}>
            <span aria-hidden>🚌</span> Colectivos
          </button>
          <a href="/cuando-salgo" title="¿Cuándo salgo?" className="flex shrink-0 items-center whitespace-nowrap rounded-xl bg-surface px-3 text-xs font-semibold text-fg-muted shadow ring-1 ring-line">
            <span aria-hidden>⏱️</span><span className="sr-only sm:not-sr-only sm:ml-1">¿Cuándo salgo?</span>
          </a>
        </div>
      </div>

      {/* Panel inferior con los reportes del área visible */}
      <section
        className={`absolute inset-x-0 bottom-0 z-20 mx-auto max-w-xl rounded-t-3xl bg-raised shadow-[0_-8px_30px_rgba(0,0,0,.12)] transition-[height] duration-300 md:bottom-4 md:right-4 md:left-auto md:mx-0 md:w-96 md:rounded-3xl ${sheet === "open" ? "h-[65%]" : "h-[7rem] md:h-[70%]"}`}
        aria-label="Reportes en esta zona"
      >
        <button className="flex w-full flex-col items-center pt-2 pb-1 md:hidden" onClick={() => setSheet(sheet === "open" ? "peek" : "open")} aria-expanded={sheet === "open"}>
          <span className="h-1.5 w-10 rounded-full bg-fill-strong" />
        </button>
        <div className="flex items-baseline justify-between px-4 pb-2 md:pt-4">
          <h2 className="font-bold">{loading ? "Buscando…" : `${items.length}${items.length === 40 ? "+" : ""} reportes en esta zona`}</h2>
          <a href="/reportar" className="text-sm font-semibold text-alert-fg">+ Reportar</a>
        </div>
        <ul className="h-[calc(100%-4.5rem)] overflow-y-auto px-2 pb-4">
          {items.length === 0 && !loading && (
            <li className="px-3 py-6 text-center text-sm text-fg-subtle">No hay reportes acá todavía. ¿Viste algún problema? <a className="font-semibold text-accent" href="/reportar">Reportalo</a>.</li>
          )}
          {items.map((it) => (
            <li key={it.code}>
              <div className="flex gap-3 rounded-xl p-2 hover:bg-surface-2">
                <button onClick={() => flyTo(it)} className="tint-bg relative h-16 w-16 shrink-0 overflow-hidden rounded-xl" style={{ "--tint": it.color } as React.CSSProperties} aria-label={`Ver ${it.title} en el mapa`}>
                  {it.cover ? <img src={it.cover} alt="" className="h-full w-full object-cover" loading="lazy" /> : <span className="flex h-full items-center justify-center text-2xl">{it.icon}</span>}
                </button>
                <a href={it.path} className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{it.title}</p>
                  <p className="truncate text-xs text-fg-subtle">{it.place || "Paraguay"} · <time dateTime={it.created_at}>{timeAgo(it.created_at)}</time></p>
                  <p className="mt-1 flex items-center gap-2 text-xs">
                    <span className="chip tint" style={{ "--tint": STATUS_COLORS[it.status] } as React.CSSProperties}>{STATUS_LABEL[it.status]}</span>
                    {it.confirmations > 0 && <span className="text-fg-subtle">👥 {it.confirmations}</span>}
                  </p>
                </a>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function FilterChip({ active, onClick, children, color = "#0f6b55" }: { active: boolean; onClick: () => void; children: React.ReactNode; color?: string }) {
  return (
    <button onClick={onClick} aria-pressed={active}
      className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold shadow ring-1 ${active ? `${textOn(color)} ring-transparent` : "bg-surface text-fg-muted ring-line"}`}
      style={active ? { background: color } : undefined}>
      {children}
    </button>
  );
}

/**
 * Texto legible sobre el color de una categoría (lo elige un admin): blanco u oscuro, el que más contraste.
 * Con blanco fijo, categorías claras como Alumbrado (#f59f00) quedaban en 2:1.
 */
function textOn(hex: string): string {
  const lum = 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
  const INK_LUM = 0.0115; // luminancia relativa de --color-ink (#0e1f1b)
  return 1.05 / (lum + 0.05) >= (lum + 0.05) / (INK_LUM + 0.05) ? "text-white" : "text-ink";
}

function channel(hex: string, i: number): number {
  const v = parseInt(hex.slice(i, i + 2), 16) / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function popupContent(p: { code: string; slug: string; title: string; status: Status; icon: string; confirmations: number; created: number }) {
  const div = document.createElement("div");
  const a = document.createElement("a");
  a.href = `/r/${String(p.code).toLowerCase()}-${p.slug}`;
  a.className = "block p-3";
  const title = document.createElement("p");
  title.className = "font-semibold text-fg";
  title.textContent = `${p.icon} ${p.title}`;
  const meta = document.createElement("p");
  meta.className = "mt-1 text-xs text-fg-subtle";
  meta.textContent = `${STATUS_LABEL[p.status]} · ${timeAgo(new Date(p.created * 1000))}${p.confirmations ? ` · 👥 ${p.confirmations}` : ""}`;
  const more = document.createElement("p");
  more.className = "mt-2 text-sm font-semibold text-accent";
  more.textContent = "Ver caso →";
  a.append(title, meta, more);
  div.append(a);
  return div;
}

function readView(): { center: [number, number]; zoom: number } | null {
  try {
    const v = JSON.parse(sessionStorage.getItem("rc:view") ?? "null");
    return v && Array.isArray(v.center) ? v : null;
  } catch {
    return null;
  }
}

// La capa de colectivos sigue prendida al recargar, mientras dure la pestaña (como la vista del mapa).
function readBuses(): boolean {
  try {
    return sessionStorage.getItem("rc:buses") === "1";
  } catch {
    return false;
  }
}

function saveBuses(on: boolean) {
  try {
    if (on) sessionStorage.setItem("rc:buses", "1");
    else sessionStorage.removeItem("rc:buses");
  } catch {
    /* sin almacenamiento */
  }
}

function saveView(map: maplibregl.Map) {
  try {
    const c = map.getCenter();
    sessionStorage.setItem("rc:view", JSON.stringify({ center: [c.lng, c.lat], zoom: map.getZoom() }));
  } catch {
    /* sin almacenamiento */
  }
}
