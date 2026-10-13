import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Advice, BusEta } from "@rc/core/departure";
import { requestNotifications } from "../../lib/client/departure-alert";
import { browserDeps, createDepartureController, type DepartureSnapshot } from "../../lib/client/departure-controller";
import { lineColor } from "../../lib/client/line-color";
import { clearCatalog } from "../../lib/client/route-catalog";
import { distance, lineNumber, minutesRange } from "../../lib/client/transit-format";
import { clearTrips, deleteTrip, getSelectedTrip, getTrips, PACES, saveTrip, setSelectedTrip, withMeasuredWalk, type Trip } from "../../lib/client/trips";
import { browserWatch, measureWalk, type Fix } from "../../lib/client/walk";

// El mapa (MapLibre) se carga solo al configurar o al pedirlo: la vista de todos los días no lo necesita.
const TripSetup = lazy(() => import("./TripSetup"));
const TripMapView = lazy(() => import("./TripMapView"));

/**
 * ¿Cuándo salgo?: cuándo salir para alcanzar el próximo colectivo en tu parada, contando lo que tardás en llegar.
 * Todo se calcula en el teléfono (ver lib/client/departure-controller.ts).
 */
export default function WhenToLeave() {
  const [trips, setTrips] = useState<Trip[]>(getTrips);
  const [selected, setSelected] = useState<string | null>(getSelectedTrip);
  const [setup, setSetup] = useState(false);
  const [hint, setHint] = useState<{ company: number; route: string } | null>(null);
  const [cleared, setCleared] = useState(false);

  // Desde el popup de un bus: /cuando-salgo#linea=22:00d2. Se lee y se borra de la URL (y del historial).
  useEffect(() => {
    const m = /^#linea=(\d+):([0-9a-f]{4})$/i.exec(location.hash);
    if (!m) return;
    history.replaceState(null, "", location.pathname + location.search);
    setHint({ company: Number(m[1]), route: m[2].toLowerCase() });
    setSetup(true);
  }, []);

  const trip = trips.find((t) => t.id === selected) ?? trips[0] ?? null;
  const refresh = () => setTrips(getTrips());

  if (setup || !trip) {
    if (!setup) return <Intro cleared={cleared} onStart={() => setSetup(true)} />;
    return (
      <Suspense fallback={<p className="text-fg-muted" role="status">Cargando el mapa…</p>}>
        <TripSetup
          hint={hint}
          onCancel={trip ? () => setSetup(false) : undefined}
          onSave={(t) => {
            saveTrip(t);
            setSelectedTrip(t.id);
            setSelected(t.id);
            refresh();
            setSetup(false);
            setHint(null);
          }}
        />
      </Suspense>
    );
  }

  return (
    <div className="space-y-4">
      {trips.length > 1 && (
        <div className="flex gap-1 overflow-x-auto pb-1 [scrollbar-width:none]" role="tablist" aria-label="Tus paradas">
          {trips.map((t) => (
            <button key={t.id} role="tab" aria-selected={t.id === trip.id}
              className={`shrink-0 rounded-full px-3 py-1.5 text-sm font-semibold ring-1 ${t.id === trip.id ? "bg-brand-600 text-white ring-transparent" : "bg-surface text-fg-muted ring-line"}`}
              onClick={() => {
                setSelected(t.id);
                setSelectedTrip(t.id);
              }}>
              {t.name || "Mi parada"}
            </button>
          ))}
        </div>
      )}
      <TripView key={trip.id} trip={trip} onChange={(t) => { saveTrip(t); refresh(); }} onSync={refresh} onDelete={() => { deleteTrip(trip.id); refresh(); }} />
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4">
        <button className="btn-ghost py-2 text-sm" onClick={() => setSetup(true)}>+ Otra parada</button>
        <ClearAll onClear={async () => {
          clearTrips();
          await clearCatalog().catch(() => {});
          setTrips([]);
          setSelected(null);
          setCleared(true);
        }} />
      </div>
      <p className="text-xs text-fg-subtle">🔒 Tus paradas y tus minutos quedan solo en este teléfono. Al servidor solo le pedimos dónde están todos los colectivos y todos los recorridos, lo mismo que a cualquiera.</p>
    </div>
  );
}

function Intro({ onStart, cleared }: { onStart: () => void; cleared: boolean }) {
  return (
    <section className="card space-y-3 p-5">
      {cleared && <p className="text-sm font-semibold text-accent" role="status">Listo: borramos tus paradas de este teléfono.</p>}
      <p className="text-fg-muted">Marcá tu parada y las líneas que te sirven. Te decimos cuándo salir para alcanzar el próximo colectivo, contando lo que tardás en llegar caminando.</p>
      <p className="text-sm text-fg-muted">🔒 Todo se calcula en tu teléfono: tu parada y tus horarios no llegan a ningún servidor.</p>
      <button className="btn-primary w-full" onClick={onStart}>Marcar mi parada</button>
    </section>
  );
}

function ClearAll({ onClear }: { onClear: () => void }) {
  const [ask, setAsk] = useState(false);
  if (!ask) return <button className="text-sm text-fg-subtle hover:underline" onClick={() => setAsk(true)}>Borrar mis paradas</button>;
  return (
    <span className="flex items-center gap-2 text-sm">
      ¿Borrar todo de este teléfono?
      <button className="font-semibold text-alert-fg hover:underline" onClick={onClear}>Sí, borrar</button>
      <button className="text-fg-subtle hover:underline" onClick={() => setAsk(false)}>No</button>
    </span>
  );
}

function useDeparture(trip: Trip) {
  const ctrl = useMemo(() => createDepartureController(trip, browserDeps()), [trip.id]);
  useEffect(() => {
    ctrl.start();
    return () => ctrl.stop();
  }, [ctrl]);
  useEffect(() => ctrl.setTrip(trip), [ctrl, trip]);
  return { ctrl, snap: useSyncExternalStore(ctrl.subscribe, ctrl.getSnapshot, ctrl.getSnapshot) };
}

/** La ubicación del momento para el tiempo de caminata, si la persona ya dio permiso (o lo pide con el botón). */
function useLiveFix(enabled: boolean, onFix: (f: Fix | null) => void) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    navigator.permissions?.query({ name: "geolocation" }).then((p) => alive && p.state === "granted" && setOn(true), () => {});
    return () => {
      alive = false;
    };
  }, [enabled]);
  useEffect(() => {
    if (!on || !enabled) return;
    const stop = browserWatch((f) => onFix(f), () => setOn(false));
    return () => {
      stop();
      onFix(null);
    };
  }, [on, enabled]);
  return { live: on, start: () => setOn(true) };
}

function TripView({ trip: saved, onChange, onSync, onDelete }: { trip: Trip; onChange: (t: Trip) => void; onSync: () => void; onDelete: () => void }) {
  const { ctrl, snap } = useDeparture(saved);
  // El viaje vigente es el del controlador: si el VMT cambió los recorridos, ya viene rearmado (y guardado), y las
  // ediciones tienen que partir de ahí y no de la copia vieja.
  const trip = snap.trip;
  useEffect(() => {
    if (trip.catalogVersion !== saved.catalogVersion) onSync();
  }, [trip.catalogVersion]);
  const fixRef = useRef(ctrl.setFix);
  fixRef.current = ctrl.setFix;
  const { live, start: startLive } = useLiveFix(trip.walk.mode !== "manual", (f) => fixRef.current(f));
  const [editing, setEditing] = useState(false);
  const [showMap, setShowMap] = useState(false);
  const [measuring, setMeasuring] = useState<null | (() => void)>(null);
  const [note, setNote] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => () => measuring?.(), [measuring]);

  function toggleAlert() {
    if (snap.armed) return ctrl.arm(false);
    // Se arma ya: si la persona no contesta el pedido de permiso, igual suena y vibra con la pantalla abierta.
    ctrl.arm(true);
    requestNotifications().then((perm) => {
      setNote(perm === "granted" ? "" : "Sin permiso de notificaciones: te avisamos con sonido y vibración mientras la pantalla esté abierta.");
    });
  }

  function leftHome() {
    setNote("Midiendo tu caminata: cuando llegues a la parada lo anotamos.");
    const cancel = measureWalk(trip.stop, browserWatch, (min) => {
      setMeasuring(null);
      if (min === null) return setNote("No llegaste a la parada en 30 minutos: no anotamos nada.");
      onChange(withMeasuredWalk(trip, min));
      setNote(`Tardaste ${min} min. Lo usamos para las próximas veces.`);
    });
    setMeasuring(() => cancel);
  }

  const h = headline(snap);
  return (
    <div className="space-y-4">
      {snap.tripStatus === "lost" && <p className="card p-3 text-sm text-warning" role="alert">El VMT cambió los recorridos y ya no encontramos tus líneas en esta parada. Marcala de nuevo.</p>}
      {snap.tripStatus === "updated" && <p className="text-sm text-fg-muted" role="status">El VMT actualizó los recorridos de tus líneas; ya los tenemos en cuenta.</p>}
      {snap.catalog === "missing" && <p className="card p-3 text-sm text-warning" role="alert">Necesitamos bajar los recorridos una vez (~130 KB). Probá con conexión.</p>}

      <section className="card space-y-1 p-5" aria-labelledby="titular">
        <p className="text-sm font-semibold text-fg-subtle">{trip.name || "Mi parada"}</p>
        <h1 id="titular" className="font-display text-4xl font-extrabold" role="status" aria-live="polite">{h.title}</h1>
        {h.sub && <p className="text-fg-muted">{h.sub}</p>}
        {snap.advice.stale && snap.updatedAt && <p className="text-xs text-warning">Sin actualizar hace {Math.round((Date.now() - snap.updatedAt) / 1000)} s</p>}
        <p className="pt-2 text-sm text-fg-muted">{walkText(snap)}</p>
      </section>

      <div className="grid grid-cols-2 gap-2">
        <button className={snap.armed ? "btn-primary" : "btn-ghost"} aria-pressed={snap.armed} onClick={toggleAlert}>
          {snap.armed ? "🔔 Te aviso" : "🔔 Avisame"}
        </button>
        <button className="btn-ghost" disabled={!!measuring} onClick={leftHome}>{measuring ? "🚶 Midiendo…" : "🚶 Ya salí"}</button>
      </div>
      {snap.armed && <p className="text-sm text-fg-muted">Dejá esta pantalla abierta y te avisamos cuando tengas que salir.</p>}
      {note && <p className="text-sm text-fg-muted" role="status">{note}</p>}
      {!live && trip.walk.mode !== "manual" && (
        <button className="text-sm font-semibold text-accent hover:underline" onClick={startLive}>📍 Calcular la caminata desde donde estoy</button>
      )}

      <BusList snap={snap} />

      <div className="flex flex-wrap gap-2">
        <button className="btn-ghost py-2 text-sm" aria-expanded={showMap} onClick={() => setShowMap(!showMap)}>🗺️ {showMap ? "Ocultar el mapa" : "Ver en el mapa"}</button>
        <button className="btn-ghost py-2 text-sm" aria-expanded={editing} onClick={() => setEditing(!editing)}>Ajustar tiempos</button>
        {confirmDelete ? (
          <span className="flex items-center gap-2 text-sm">
            ¿Borrar esta parada?
            <button className="font-semibold text-alert-fg hover:underline" onClick={onDelete}>Sí</button>
            <button className="text-fg-subtle hover:underline" onClick={() => setConfirmDelete(false)}>No</button>
          </span>
        ) : (
          <button className="py-2 text-sm text-fg-subtle hover:underline" onClick={() => setConfirmDelete(true)}>Borrar</button>
        )}
      </div>
      {editing && <WalkEditor trip={trip} onChange={onChange} />}
      {showMap && (
        <Suspense fallback={<p className="text-fg-muted" role="status">Cargando el mapa…</p>}>
          <TripMapView trip={trip} buses={snap.buses} />
        </Suspense>
      )}
    </div>
  );
}

function headline(s: DepartureSnapshot): { title: string; sub?: string } {
  const a: Advice = s.advice;
  const t = a.target;
  const when = (e: BusEta) => minutesRange(e.earlyAt - s.now, e.lateAt - s.now);
  const line = (e: BusEta) => (lineNumber(e.line) ? `el ${lineNumber(e.line)}` : "el colectivo");
  if (s.catalog === "loading" || a.state === "loading") return { title: "Buscando colectivos…" };
  if (s.tripStatus === "lost") return { title: "Marcá tu parada de nuevo" };
  switch (a.state) {
    case "leave-in":
      return { title: `Salí en ${a.leaveInMin} min`, sub: `para ${line(t!)}, que llega a tu parada en ${when(t!)}.` };
    case "leave-now":
      return { title: "Salí ya", sub: `${capitalizeFirst(line(t!))} llega en ${when(t!)}.` };
    case "hurry":
      return { title: "Salí ya y capaz lo alcanzás", sub: a.leaveInMin !== undefined ? `Si no, salí en ${a.leaveInMin} min para el siguiente.` : `${capitalizeFirst(line(t!))} llega en ${when(t!)}.` };
    case "far":
      return { title: "El próximo está lejos", sub: `${capitalizeFirst(line(t!))} está a ${distance(t!.distanceM)}: llega en ${when(t!)}.` };
    case "no-data":
      return { title: "Sin datos de los colectivos", sub: "El VMT no está respondiendo. Probá en un rato." };
    default:
      return {
        title: "No hay colectivos de tu línea en camino",
        sub: [a.lastPassedAgoMin !== undefined ? `El último pasó hace ${a.lastPassedAgoMin} min.` : null, "Puede que el próximo todavía no haya salido de la terminal o no esté mandando su ubicación."].filter(Boolean).join(" "),
      };
  }
}

const capitalizeFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function walkText(s: DepartureSnapshot): string {
  const w = s.walk;
  const margin = s.trip.marginMin ? ` · ${s.trip.marginMin} min de margen` : "";
  switch (w.source) {
    case "at-stop":
      return "Ya estás en la parada.";
    case "here":
      return `Caminás ~${w.minutes} min desde donde estás${w.distanceM ? ` (${distance(w.distanceM)})` : ""}${margin}`;
    case "measured":
      return `Tardás ${w.minutes} min hasta la parada (medido)${margin}`;
    default:
      return `Tardás ${w.minutes} min hasta la parada${margin}`;
  }
}

function BusList({ snap }: { snap: DepartureSnapshot }) {
  const list = snap.buses.slice(0, 5);
  if (!list.length) return null;
  const missed = new Set(snap.advice.missed.map((e) => e.busId));
  return (
    <section aria-labelledby="proximos">
      <h2 id="proximos" className="mb-2 text-sm font-bold text-fg-muted">Próximos colectivos</h2>
      <ul className="card divide-y divide-line">
        {list.map((e) => (
          <li key={`${e.busId}:${e.pass}`} className={`flex items-center gap-3 p-3 ${missed.has(e.busId) ? "opacity-60" : ""}`}>
            <span className="rounded-md px-1.5 py-0.5 text-sm font-bold text-white" style={{ background: lineColor(e.line) }}>{lineNumber(e.line) ?? "?"}</span>
            <span className="min-w-0 flex-1 text-sm">
              {e.flags.atStop ? "En la parada" : `A ${distance(e.distanceM)}`}
              {e.flags.dwell ? " · en la terminal" : e.flags.ghost ? " · sin actualizar" : e.flags.stalled ? " · detenido" : ""}
              {missed.has(e.busId) ? " · no llegás" : ""}
            </span>
            <span className={`text-sm font-semibold ${e.confidence === "low" ? "text-fg-subtle" : "text-fg"}`}>{minutesRange(e.earlyAt - snap.now, e.lateAt - snap.now)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function WalkEditor({ trip, onChange }: { trip: Trip; onChange: (t: Trip) => void }) {
  const w = trip.walk;
  const set = (walk: Partial<Trip["walk"]>, extra: Partial<Trip> = {}) => onChange({ ...trip, ...extra, walk: { ...w, ...walk }, updatedAt: Date.now() });
  return (
    <section className="card space-y-3 p-4" aria-label="Ajustar tiempos">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="h-4 w-4 accent-brand-600" checked={w.mode === "manual"}
          onChange={(e) => set({ mode: e.target.checked ? "manual" : w.samples.length ? "measured" : "auto" })} />
        Usar siempre los minutos que pongo
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="label">Minutos caminando</span>
          <input className="input" type="number" inputMode="numeric" min={0} max={90} value={w.minutes} onChange={(e) => set({ minutes: Math.max(0, Math.min(90, Math.round(Number(e.target.value) || 0))) })} />
        </label>
        <label className="block">
          <span className="label">Minutos de margen</span>
          <input className="input" type="number" inputMode="numeric" min={0} max={30} value={trip.marginMin} onChange={(e) => set({}, { marginMin: Math.max(0, Math.min(30, Math.round(Number(e.target.value) || 0))) })} />
        </label>
      </div>
      <label className="block">
        <span className="label">Camino</span>
        <select className="input py-2.5" value={w.paceKmh} onChange={(e) => set({ paceKmh: Number(e.target.value) })}>
          {PACES.map((p) => <option key={p.kmh} value={p.kmh}>{p.label}</option>)}
        </select>
      </label>
      {w.samples.length > 0 && (
        <p className="text-xs text-fg-subtle">
          Medidas: {w.samples.join(", ")} min.{" "}
          <button className="font-semibold text-accent hover:underline" onClick={() => set({ samples: [], mode: w.mode === "measured" ? "auto" : w.mode })}>Olvidarlas</button>
        </p>
      )}
      <label className="block">
        <span className="label">Nombre</span>
        <input className="input" value={trip.name} maxLength={40} onChange={(e) => set({}, { name: e.target.value })} />
      </label>
    </section>
  );
}
