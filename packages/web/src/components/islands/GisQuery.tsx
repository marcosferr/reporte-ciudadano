import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import { TerraDraw, TerraDrawPolygonMode, TerraDrawRectangleMode, TerraDrawSelectMode } from "terra-draw";
import { TerraDrawMapLibreGLAdapter } from "terra-draw-maplibre-gl-adapter";
import { STATUS_LABEL, type Status } from "@rc/core/status";
import { addReportLayers, BASEMAP_STYLE, PY_BOUNDS, setReportFilters, collapseAttribution } from "../../lib/client/map";
import { formatNumber, pct } from "../../lib/format";

interface Result {
  summary: {
    total: number; open: number; resolved: number; resolution_rate: number; median_days_to_resolve: number | null;
    by_status: { status: Status; n: number }[];
    by_category: { slug: string; name: string; icon: string; color: string; n: number; resolved: number }[];
  };
  hotspots: { lat: number; lng: number; n: number; top_icon: string; top_category: string }[];
}

/** Consulta GIS: dibujar un polígono o rectángulo y obtener estadísticas, focos y exportación. */
export default function GisQuery({ categories }: { categories: { slug: string; name: string }[] }) {
  const el = useRef<HTMLDivElement>(null);
  const draw = useRef<TerraDraw>(undefined);
  const mapRef = useRef<maplibregl.Map>(undefined);
  const markers = useRef<maplibregl.Marker[]>([]);
  const [polygon, setPolygon] = useState<any>();
  const [mode, setMode] = useState<"polygon" | "rectangle" | "select">("rectangle");
  const [category, setCategory] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [result, setResult] = useState<Result>();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const map = new maplibregl.Map({ container: el.current!, style: BASEMAP_STYLE, bounds: PY_BOUNDS, dragRotate: false, attributionControl: { compact: true } });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }));
    map.on("load", () => {
      addReportLayers(map, {});
      const td = new TerraDraw({
        adapter: new TerraDrawMapLibreGLAdapter({ map }),
        modes: [new TerraDrawPolygonMode(), new TerraDrawRectangleMode(), new TerraDrawSelectMode({ flags: { polygon: { feature: { draggable: true, coordinates: { draggable: true } } } } })],
      });
      td.start();
      td.setMode("rectangle");
      td.on("finish", (id) => {
        const snap = td.getSnapshot();
        // Solo un área a la vez.
        for (const f of snap) if (f.id !== id) td.removeFeatures([f.id as string]);
        setPolygon(snap.find((f) => f.id === id)?.geometry);
      });
      draw.current = td;
    });
    collapseAttribution(map);
    return () => map.remove();
  }, []);

  useEffect(() => {
    draw.current?.setMode(mode);
  }, [mode]);

  useEffect(() => {
    if (mapRef.current?.getSource("reports")) setReportFilters(mapRef.current, { category: category || undefined });
  }, [category]);

  const scope = () => ({ polygon, category: category || undefined, from: from || undefined, to: to || undefined });

  async function query() {
    if (!polygon) return;
    setLoading(true);
    try {
      const res = await fetch("/api/stats/summary", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(scope()) });
      const data: Result = await res.json();
      setResult(data);
      markers.current.forEach((m) => m.remove());
      markers.current = data.hotspots.map((h) => {
        const node = document.createElement("div");
        node.className = "flex h-8 min-w-8 items-center justify-center rounded-full bg-red-600 px-2 text-xs font-bold text-white ring-4 ring-red-600/30";
        node.textContent = `${h.top_icon} ${h.n}`;
        return new maplibregl.Marker({ element: node }).setLngLat([h.lng, h.lat]).addTo(mapRef.current!);
      });
    } finally {
      setLoading(false);
    }
  }

  async function download(format: "csv" | "geojson") {
    const res = await fetch(`/api/stats/export.${format}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(scope()) });
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement("a"), { href: url, download: `consulta-${new Date().toISOString().slice(0, 10)}.${format}` });
    a.click();
    URL.revokeObjectURL(url);
  }

  function clear() {
    draw.current?.clear();
    setPolygon(undefined);
    setResult(undefined);
    markers.current.forEach((m) => m.remove());
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          {(["rectangle", "polygon", "select"] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)} className={`chip px-3 py-1.5 text-sm ${mode === m ? "bg-brand-600 text-white" : "bg-white ring-1 ring-slate-200"}`}>
              {{ rectangle: "▭ Rectángulo", polygon: "⬠ Polígono", select: "✥ Editar" }[m]}
            </button>
          ))}
          <button onClick={clear} className="chip bg-white px-3 py-1.5 text-sm ring-1 ring-slate-200">Limpiar</button>
        </div>
        <div ref={el} className="h-[60dvh] overflow-hidden rounded-2xl ring-1 ring-slate-200" />
        <p className="text-xs text-slate-500">Dibujá un área sobre el mapa (en polígono, doble toque para cerrar) y tocá “Consultar”.</p>
      </div>
      <aside className="space-y-3">
        <div className="card space-y-2 p-4">
          <label className="label" htmlFor="gq-cat">Categoría</label>
          <select id="gq-cat" className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">Todas</option>
            {categories.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
          </select>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs font-semibold">Desde<input type="date" className="input py-2" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label className="text-xs font-semibold">Hasta<input type="date" className="input py-2" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          </div>
          <button className="btn-primary w-full" disabled={!polygon || loading} onClick={query}>{loading ? "Consultando…" : "Consultar área"}</button>
        </div>
        {result && (
          <div className="card space-y-3 p-4">
            <div className="grid grid-cols-3 gap-2 text-center">
              <Stat label="Reportes" value={formatNumber(result.summary.total)} />
              <Stat label="Abiertos" value={formatNumber(result.summary.open)} />
              <Stat label="Resueltos" value={pct(result.summary.resolution_rate)} />
            </div>
            {result.summary.median_days_to_resolve !== null && (
              <p className="text-sm text-slate-600">Tiempo mediano de resolución: <b>{result.summary.median_days_to_resolve} días</b></p>
            )}
            <ul className="space-y-1 text-sm">
              {result.summary.by_category.map((c) => (
                <li key={c.slug} className="flex justify-between"><span>{c.icon} {c.name}</span><b>{c.n}</b></li>
              ))}
            </ul>
            <p className="text-xs text-slate-500">
              {result.summary.by_status.map((s) => `${STATUS_LABEL[s.status]}: ${s.n}`).join(" · ")}
            </p>
            <p className="text-sm"><b>{result.hotspots.length}</b> focos detectados (marcados en rojo).</p>
            <div className="grid grid-cols-2 gap-2">
              <button className="btn-ghost py-2 text-sm" onClick={() => download("csv")}>⬇ CSV</button>
              <button className="btn-ghost py-2 text-sm" onClick={() => download("geojson")}>⬇ GeoJSON</button>
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-slate-50 p-2">
      <p className="text-lg font-extrabold">{value}</p>
      <p className="text-[11px] text-slate-500">{label}</p>
    </div>
  );
}
