import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { normPlace, routeKey, STOP_CFG, stopDirections, stopOptions, type StopOption } from "@rc/core/bus-catalog";
import { walkMinutes } from "@rc/core/departure";
import { angleDiff, type LngLat } from "@rc/core/geo";
import { lineColor } from "../../lib/client/line-color";
import { loadCatalog, type CatalogLoad } from "../../lib/client/route-catalog";
import { DEFAULT_MARGIN_MIN, newTrip, PACES, type Trip } from "../../lib/client/trips";
import { tripMap } from "../../lib/client/trip-map";
import { capitalize, cardinal, companyName, distance } from "../../lib/client/transit-format";

/**
 * Configurar un viaje: primero la parada (el VMT no publica paradas, la marca la persona), después las líneas que le
 * sirven ahí y por último cuánto tarda en llegar. Todo se calcula con el catálogo guardado en el teléfono.
 */
export default function TripSetup({ hint, onSave, onCancel }: {
  /** Línea elegida desde el popup de un bus en el mapa: se dibuja para ayudar a marcar la parada y se preselecciona. */
  hint?: { company: number; route: string } | null;
  onSave: (t: Trip) => void;
  onCancel?: () => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<ReturnType<typeof tripMap>>(undefined);
  const [load, setLoad] = useState<CatalogLoad | null>(null);
  const [stop, setStop] = useState<LngLat | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [step, setStep] = useState<"stop" | "walk">("stop");
  const [walkMode, setWalkMode] = useState<"auto" | "manual">("auto");
  const [minutes, setMinutes] = useState(5);
  const [pace, setPace] = useState<number>(PACES[1].kmh);
  const [margin, setMargin] = useState(DEFAULT_MARGIN_MIN);
  const [name, setName] = useState("");
  const [msg, setMsg] = useState("");
  const [locating, setLocating] = useState(false);
  const [direction, setDirection] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const catalog = load?.catalog ?? null;

  useEffect(() => {
    loadCatalog().then(setLoad);
    const m = tripMap(el.current!, { onClick: (p) => setStop(p) });
    mapRef.current = m;
    return () => m.destroy();
  }, []);

  const { options, radiusM } = useMemo(() => {
    if (!catalog || !stop) return { options: [] as StopOption[], radiusM: STOP_CFG.STOP_RADIUS_M };
    const near = stopOptions(catalog, stop);
    if (near.length) return { options: near, radiusM: STOP_CFG.STOP_RADIUS_M };
    return { options: stopOptions(catalog, stop, STOP_CFG.WIDE_RADIUS_M), radiusM: STOP_CFG.WIDE_RADIUS_M };
  }, [catalog, stop]);

  // En una avenida pasan decenas de líneas para cada lado: primero se elige para qué lado va.
  const directions = useMemo(() => stopDirections(options), [options]);

  // Al marcar otra parada se arranca de nuevo; la línea que vino del mapa queda elegida si pasa por ahí, con su sentido.
  useEffect(() => {
    const hinted = hint ? routeKey(hint.company, hint.route) : null;
    const pre = options.filter((o) => hinted && o.routes.some((r) => r.key === hinted));
    setPicked(new Set(pre.map((o) => o.id)));
    setDirection(pre[0] ? directions.find((d) => d.options.includes(pre[0]))?.bearing ?? null : null);
    setQuery("");
    if (stop) mapRef.current?.focus(stop);
  }, [options]);

  const shown = options.filter((o) =>
    (direction === null || angleDiff(o.bearing, direction) <= STOP_CFG.SAME_WAY_DEG) &&
    (!query.trim() || [o.line, o.destination, o.companyName].some((v) => normPlace(v).includes(normPlace(query)))));

  // El mapa dibuja las líneas elegidas, o la que vino del mapa mientras no hay parada.
  useEffect(() => {
    const m = mapRef.current;
    if (!m || !catalog) return;
    m.setStop(stop);
    const keys = stop
      ? options.filter((o) => picked.has(o.id)).flatMap((o) => o.routes.map((r) => r.key))
      : hint ? [routeKey(hint.company, hint.route)] : [];
    const routes = [...new Set(keys)].map((k) => catalog.routes.get(k)).filter((r) => !!r);
    m.setRoutes(routes.map((r) => ({ coords: r.coords, color: lineColor(r.line) })));
    if (!stop && routes[0]) m.fit(flat(routes[0].coords), 14);
  }, [catalog, stop, options, picked]);

  function locate(then: (p: LngLat) => void) {
    if (!navigator.geolocation) return setMsg("Tu navegador no permite ubicarte.");
    setLocating(true);
    setMsg("");
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        setLocating(false);
        then([coords.longitude, coords.latitude]);
      },
      () => {
        setLocating(false);
        setMsg("No pudimos obtener tu ubicación.");
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  function toggle(id: string) {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  }

  function save() {
    if (!catalog || !stop) return;
    onSave(newTrip({
      name, stop, options: options.filter((o) => picked.has(o.id)), radiusM,
      walk: { mode: walkMode, minutes, paceKmh: pace, samples: [] }, marginMin: margin,
    }, catalog));
  }

  const nearest = options.length && radiusM > STOP_CFG.STOP_RADIUS_M ? Math.min(...options.map((o) => o.minOffsetM)) : 0;

  return (
    <div className="space-y-4">
      <div ref={el} className="h-[45vh] min-h-64 w-full overflow-hidden rounded-2xl ring-1 ring-line" role="region" aria-label="Mapa para marcar tu parada" />
      {msg && <p className="text-sm text-warning" role="status">{msg}</p>}

      {step === "stop" && (
        <section className="space-y-3" aria-labelledby="paso-parada">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="paso-parada" className="text-lg font-bold">{stop ? "¿Qué líneas te sirven acá?" : "Tocá tu parada en el mapa"}</h2>
            <button className="btn-ghost py-2 text-sm" disabled={locating} onClick={() => locate((p) => { setStop(p); mapRef.current?.flyTo(p, 17); })}>
              {locating ? "Ubicándote…" : "📍 Estoy en la parada"}
            </button>
          </div>
          {!load && <p className="text-sm text-fg-muted" role="status">Bajando los recorridos (una vez por día, ~130 KB)…</p>}
          {load && !catalog && <p className="text-sm text-warning" role="alert">No pudimos bajar los recorridos. Probá de nuevo con conexión.</p>}
          {!stop && catalog && <p className="text-sm text-fg-muted">El VMT no publica las paradas: marcá dónde esperás el colectivo, sobre la calle por la que pasa.</p>}
          {stop && catalog && !options.length && <p className="text-sm text-fg-muted" role="status">No pasa ningún recorrido a menos de {STOP_CFG.WIDE_RADIUS_M} m. Tocá más cerca de la calle por la que pasa tu colectivo.</p>}
          {nearest > 0 && <p className="text-sm text-warning" role="status">Las líneas más cercanas pasan a {distance(nearest)}. Si tu parada está sobre esa calle, tocá ahí.</p>}
          {directions.length > 1 && (
            <div className="flex flex-wrap gap-1" role="group" aria-label="¿Para qué lado vas?">
              {directions.map((d) => (
                <button key={d.bearing} aria-pressed={direction === d.bearing} onClick={() => setDirection(direction === d.bearing ? null : d.bearing)}
                  className={`rounded-full px-3 py-1.5 text-sm font-semibold ring-1 ${direction === d.bearing ? "bg-brand-600 text-white ring-transparent" : "bg-surface text-fg-muted ring-line"}`}>
                  <span aria-hidden className="inline-block" style={{ transform: `rotate(${d.bearing}deg)` }}>↑</span> Hacia el {cardinal(d.bearing)} · {d.options.length}
                </button>
              ))}
            </div>
          )}
          {options.length > 8 && (
            <label className="block">
              <span className="sr-only">Buscar línea</span>
              <input className="input py-2.5" type="search" placeholder="Buscá tu línea o destino" value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
          )}
          {options.length > 0 && (
            <ul className="space-y-2">
              {shown.map((o) => {
                const variants = new Set(o.routes.map((r) => r.key)).size;
                return (
                  <li key={o.id}>
                    <label className={`card flex cursor-pointer items-center gap-3 p-3 ${picked.has(o.id) ? "ring-2 ring-brand-500" : ""}`}>
                      <input type="checkbox" className="h-5 w-5 accent-brand-600" checked={picked.has(o.id)} onChange={() => toggle(o.id)} />
                      <span className="rounded-md px-1.5 py-0.5 text-sm font-bold text-white" style={{ background: lineColor(o.line) }}>{o.line ?? "Sin línea"}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-semibold">→ {o.destination ? capitalize(o.destination) : "Sin destino"}</span>
                        <span className="block truncate text-xs text-fg-subtle">
                          {o.companyName ? companyName(o.companyName) : `Empresa ${o.companyCode}`}{variants > 1 ? ` · ${variants} variantes` : ""} · hacia el {cardinal(o.bearing)}
                        </span>
                      </span>
                      <span aria-hidden className="text-lg text-fg-muted" style={{ transform: `rotate(${o.bearing}deg)` }}>↑</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] flex gap-2 bg-canvas py-2 md:bottom-0">
            {onCancel && <button className="btn-ghost flex-1" onClick={onCancel}>Cancelar</button>}
            <button className="btn-primary flex-1" disabled={!picked.size} onClick={() => setStep("walk")}>
              {picked.size ? `Siguiente (${picked.size} ${picked.size === 1 ? "línea" : "líneas"})` : "Elegí al menos una línea"}
            </button>
          </div>
        </section>
      )}

      {step === "walk" && stop && (
        <section className="space-y-4" aria-labelledby="paso-caminata">
          <h2 id="paso-caminata" className="text-lg font-bold">¿Cuánto tardás en llegar a la parada?</h2>
          <fieldset className="space-y-2">
            <legend className="sr-only">Cómo calcular el tiempo</legend>
            <label className="card flex items-start gap-3 p-3">
              <input type="radio" name="walk" className="mt-1 accent-brand-600" checked={walkMode === "auto"} onChange={() => setWalkMode("auto")} />
              <span>
                <span className="block font-semibold">Calcularlo desde donde esté</span>
                <span className="block text-sm text-fg-muted">Con tu ubicación en el momento, solo en el teléfono. Si no hay, usa los minutos de abajo.</span>
              </span>
            </label>
            <label className="card flex items-start gap-3 p-3">
              <input type="radio" name="walk" className="mt-1 accent-brand-600" checked={walkMode === "manual"} onChange={() => setWalkMode("manual")} />
              <span>
                <span className="block font-semibold">Lo pongo yo</span>
                <span className="block text-sm text-fg-muted">Siempre los minutos de abajo.</span>
              </span>
            </label>
          </fieldset>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="label">Minutos caminando</span>
              <input className="input" type="number" inputMode="numeric" min={0} max={90} value={minutes} onChange={(e) => setMinutes(clamp(Number(e.target.value), 0, 90))} />
            </label>
            <label className="block">
              <span className="label">Minutos de margen</span>
              <input className="input" type="number" inputMode="numeric" min={0} max={30} value={margin} onChange={(e) => setMargin(clamp(Number(e.target.value), 0, 30))} />
            </label>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="block">
              <span className="label">Camino</span>
              <select className="input py-2.5" value={pace} onChange={(e) => setPace(Number(e.target.value))}>
                {PACES.map((p) => <option key={p.kmh} value={p.kmh}>{p.label}</option>)}
              </select>
            </label>
            <button className="btn-ghost py-2.5 text-sm" disabled={locating} onClick={() => locate((p) => setMinutes(walkMinutes(p, stop, pace)))}>
              {locating ? "Ubicándote…" : "📍 Calcular desde acá"}
            </button>
          </div>
          <p className="text-xs text-fg-subtle">El margen es para llegar un poco antes, por si el colectivo se adelanta. Después podés tocar "Ya salí" cuando salgas: medimos cuánto tardás de verdad y lo usamos las próximas veces.</p>
          <label className="block">
            <span className="label">Nombre</span>
            <input className="input" placeholder="Al trabajo" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="flex gap-2">
            <button className="btn-ghost flex-1" onClick={() => setStep("stop")}>Atrás</button>
            <button className="btn-primary flex-1" onClick={save}>Guardar</button>
          </div>
        </section>
      )}
      <p className="text-xs text-fg-subtle">🔒 Tu parada queda solo en este teléfono: no la mandamos a ningún servidor.</p>
    </div>
  );
}

const clamp = (n: number, a: number, b: number) => (Number.isFinite(n) ? Math.min(b, Math.max(a, Math.round(n))) : a);
const flat = (c: LngLat[] | LngLat[][]): LngLat[] => (typeof c[0]?.[0] === "number" ? (c as LngLat[]) : (c as LngLat[][]).flat());
