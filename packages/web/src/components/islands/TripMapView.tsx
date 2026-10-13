import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import type { Catalog } from "@rc/core/bus-catalog";
import type { BusEta } from "@rc/core/departure";
import { lineColor } from "../../lib/client/line-color";
import { loadCatalog } from "../../lib/client/route-catalog";
import { lineNumber } from "../../lib/client/transit-format";
import { tripMap } from "../../lib/client/trip-map";
import type { Trip } from "../../lib/client/trips";

/** El viaje en el mapa, solo cuando la persona lo pide ("Ver en el mapa"): parada, recorridos y buses en camino. */
export default function TripMapView({ trip, buses }: { trip: Trip; buses: BusEta[] }) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<ReturnType<typeof tripMap>>(undefined);
  const [catalog, setCatalog] = useState<Catalog | null>(null);

  useEffect(() => {
    const m = tripMap(el.current!);
    mapRef.current = m;
    loadCatalog().then((l) => setCatalog(l.catalog));
    m.setStop(trip.stop);
    m.flyTo(trip.stop, 15);
    return () => m.destroy();
  }, []);

  useEffect(() => {
    if (!catalog) return;
    const keys = [...new Set(trip.passes.map((p) => p.key))];
    mapRef.current?.setRoutes(keys.map((k) => catalog.routes.get(k)).filter((r) => !!r).map((r) => ({ coords: r.coords, color: lineColor(r.line) })));
  }, [catalog, trip.passes]);

  // La primera vez que llegan buses, se encuadran la parada y los dos próximos; después la persona mueve el mapa.
  const fitted = useRef(false);
  useEffect(() => {
    mapRef.current?.setBuses(buses.map((b) => ({ lngLat: b.lngLat, color: lineColor(b.line), label: lineNumber(b.line) ?? "" })));
    if (!fitted.current && buses.length) {
      fitted.current = true;
      mapRef.current?.fit([trip.stop, ...buses.slice(0, 2).map((b) => b.lngLat)]);
    }
  }, [buses]);

  return <div ref={el} className="h-[50vh] min-h-64 w-full overflow-hidden rounded-2xl ring-1 ring-line" role="region" aria-label="Tu parada y los colectivos en camino" />;
}
