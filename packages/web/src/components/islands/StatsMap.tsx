import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef } from "react";
import { BASEMAP_STYLE, PY_BOUNDS, collapseAttribution } from "../../lib/client/map";

interface Hotspot { lat: number; lng: number; n: number; top_icon: string; radius_m: number }

/**
 * Coroplético de reportes por área. level=1 departamentos; level=2 distritos de `dept`.
 * Al tocar un área se navega a su página.
 */
export default function StatsMap({ level, dept, deptSlug, category, bbox, hotspots = [], height = "24rem" }: {
  level: 1 | 2; dept?: number; deptSlug?: string; category?: string;
  bbox?: [number, number, number, number]; hotspots?: Hotspot[]; height?: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const map = new maplibregl.Map({
      container: el.current!, style: BASEMAP_STYLE,
      bounds: bbox ? [[bbox[0], bbox[1]], [bbox[2], bbox[3]]] : PY_BOUNDS,
      fitBoundsOptions: { padding: 16 }, attributionControl: { compact: true }, dragRotate: false, cooperativeGestures: true,
    });
    collapseAttribution(map);
    map.on("load", async () => {
      const q = new URLSearchParams({ level: String(level) });
      if (dept) q.set("dept", String(dept));
      if (category) q.set("category", category);
      const fc = await (await fetch(`/api/stats/areas?${q}`)).json();
      const max = Math.max(1, ...fc.features.map((f: any) => f.properties.total));
      map.addSource("areas", { type: "geojson", data: fc });
      map.addLayer({
        id: "areas-fill", type: "fill", source: "areas",
        paint: {
          "fill-color": ["interpolate", ["linear"], ["get", "total"], 0, "#f1f5f9", max * 0.25, "#fdba74", max * 0.6, "#f97316", max, "#b91c1c"],
          "fill-opacity": 0.65,
        },
      });
      map.addLayer({ id: "areas-line", type: "line", source: "areas", paint: { "line-color": "#fff", "line-width": 1.2 } });
      const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });
      map.on("mousemove", "areas-fill", (e) => {
        const p = e.features?.[0]?.properties as any;
        if (!p) return;
        map.getCanvas().style.cursor = "pointer";
        popup.setLngLat(e.lngLat).setHTML(`<div class="p-2 text-sm"><b>${escapeHtml(p.name)}</b><br>${p.total} reportes · ${p.open} abiertos · ${p.resolved} resueltos</div>`).addTo(map);
      });
      map.on("mouseleave", "areas-fill", () => { popup.remove(); map.getCanvas().style.cursor = ""; });
      map.on("click", "areas-fill", (e) => {
        const p = e.features?.[0]?.properties as any;
        if (p) location.href = level === 1 ? `/py/${p.slug}` : `/py/${deptSlug}/${p.slug}`;
      });
      for (const h of hotspots) {
        const node = document.createElement("div");
        node.className = "flex h-8 min-w-8 items-center justify-center rounded-full bg-red-600 px-2 text-xs font-bold text-white ring-4 ring-red-600/30";
        node.textContent = `${h.top_icon} ${h.n}`;
        new maplibregl.Marker({ element: node }).setLngLat([h.lng, h.lat]).addTo(map);
      }
    });
    return () => map.remove();
  }, []);
  return <div ref={el} className="w-full overflow-hidden rounded-2xl ring-1 ring-slate-200" style={{ height }} role="region" aria-label="Mapa de reportes por zona" />;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
