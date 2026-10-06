import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef } from "react";
import { BASEMAP_STYLE, collapseAttribution } from "../../lib/client/map";

export default function MiniMap({ lat, lng, color }: { lat: number; lng: number; color: string }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const map = new maplibregl.Map({
      container: el.current!, style: BASEMAP_STYLE, center: [lng, lat], zoom: 15.5,
      interactive: false, attributionControl: { compact: true },
    });
    collapseAttribution(map);
    new maplibregl.Marker({ color }).setLngLat([lng, lat]).addTo(map);
    return () => map.remove();
  }, []);
  return (
    <a href={`/?lat=${lat}&lng=${lng}&z=16`} className="block h-48 overflow-hidden rounded-2xl ring-1 ring-slate-200" aria-label="Ver en el mapa general">
      <div ref={el} className="h-full w-full" />
    </a>
  );
}
