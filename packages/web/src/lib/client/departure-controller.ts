/**
 * ¿Cuándo salgo? en el navegador: une el catálogo, el viaje guardado, los buses en vivo, la ubicación y el reloj, y
 * entrega un estado para la página. El cálculo es el de @rc/core/departure.
 *
 * Privacidad: lo único que sale del teléfono son los pedidos a /api/buses y /api/buses/routes, iguales para todos y
 * sin cookies (ver live-buses.ts). No agregar acá analítica ni nada que mande el viaje a ningún lado: lo verifica
 * test/departure-controller.test.ts.
 */
import { reconcileTrip, type Catalog } from "@rc/core/bus-catalog";
import { advise, etas, indexPasses, lastCrossing, smoothEtas, trackBuses, type Advice, type BusEta, type BusTrack, type TripIndex } from "@rc/core/departure";
import { alertNow, keepScreenOn } from "./departure-alert";
import { bestOffset, fetchLiveBuses, REFRESH_MS, startPolling, toLiveBus, type LiveFeed } from "./live-buses";
import { loadCatalog, type CatalogLoad } from "./route-catalog";
import { updateTrip, type Trip } from "./trips";
import { effectiveWalk, type Fix, type WalkEstimate } from "./walk";

// El titular se recalcula cada 5 s (el reloj avanza) sin pedir nada; los datos, cada 10 s.
const TICK_MS = 5_000;
// El catálogo se revisa cada tanto si la página queda abierta mucho tiempo.
const CATALOG_RECHECK_MS = 6 * 3_600_000;
// Con el aviso armado más de esto sin avisar, se desarma solo (batería).
const ARM_MAX_MS = 60 * 60_000;

type Doc = Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;

export interface ControllerDeps {
  fetchFeed(signal: AbortSignal): Promise<LiveFeed | null>;
  loadCatalog(opts?: { force?: boolean; maxAgeMs?: number }): Promise<CatalogLoad>;
  now(): number;
  doc: Doc;
  notify(n: { title: string; body: string; tag: string }): Promise<boolean>;
  keepScreenOn(on: boolean): Promise<void>;
  /** Guarda el viaje rearmado (si la persona no lo borró mientras tanto). */
  saveTrip(t: Trip): void;
}

export interface DepartureSnapshot {
  catalog: "loading" | "ready" | "stale" | "missing";
  trip: Trip;
  tripStatus: "same" | "updated" | "lost";
  advice: Advice;
  buses: BusEta[];
  walk: WalkEstimate;
  armed: boolean;
  /** Cuándo llegó el último dato (reloj del teléfono). */
  updatedAt: number | null;
  /** Hora real estimada (reloj del teléfono corregido con el del servidor). */
  now: number;
}

const lineName = (e: BusEta) => e.line?.split(" - ")[0] ?? "colectivo";
const minutes = (ms: number) => Math.max(0, Math.round(ms / 60_000));

export function createDepartureController(initial: Trip, deps: ControllerDeps) {
  let trip = initial;
  let index: TripIndex = indexPasses(trip.passes);
  let catalog: Catalog | null = null;
  let catalogState: DepartureSnapshot["catalog"] = "loading";
  let tripStatus: DepartureSnapshot["tripStatus"] = "same";
  let tracks = new Map<number, BusTrack>();
  let smooth = new Map<string, BusEta>();
  let list: BusEta[] = [];
  let updatedAt: number | null = null;
  const offsets: number[] = [];
  let fix: Fix | null = null;
  let armed = false, armedAt = 0;
  const notified = new Set<number>();
  const listeners = new Set<() => void>();
  let snapshot: DepartureSnapshot;
  let polling: ReturnType<typeof startPolling> | undefined;
  let tick: ReturnType<typeof setInterval> | undefined;
  let recheck: ReturnType<typeof setInterval> | undefined;
  // Cada start() tiene su número: uno que sigue esperando el catálogo después de un stop() no arranca nada.
  let generation = 0;

  const trueNow = () => deps.now() - bestOffset(offsets);

  function useCatalog(load: CatalogLoad) {
    if (!load.catalog) {
      catalogState = catalog ? "stale" : "missing";
      return;
    }
    const changed = catalog?.version !== load.catalog.version;
    catalog = load.catalog;
    catalogState = load.stale ? "stale" : "ready";
    if (!changed) return;
    reconcile();
    index = indexPasses(trip.passes);
    // Las posiciones sobre el recorrido viejo no sirven para el nuevo.
    tracks = new Map();
    smooth = new Map();
    list = [];
  }

  /** Rearma el viaje si el catálogo es de otra versión (también cuando la página manda un viaje editado). */
  function reconcile() {
    if (!catalog || (trip.catalogVersion === catalog.version && trip.passes.length)) return;
    const r = reconcileTrip(trip, catalog);
    tripStatus = r.status;
    trip = r.trip;
    deps.saveTrip(trip);
  }

  async function poll(signal: AbortSignal) {
    const feed = await deps.fetchFeed(signal);
    if (!feed || signal.aborted) return;
    updatedAt = feed.receivedAt;
    if (feed.clockOffsetMs !== undefined && offsets.push(feed.clockOffsetMs) > 10) offsets.shift();
    if (catalog) {
      const now = trueNow();
      tracks = trackBuses(tracks, feed.features.map(toLiveBus), catalog, index, now);
      const s = smoothEtas(smooth, etas(index, catalog, tracks, now));
      smooth = s.byId;
      list = s.list;
    }
    recompute();
  }

  function maybeNotify(a: Advice) {
    if (!armed) return;
    if (deps.now() - armedAt > ARM_MAX_MS) return arm(false);
    const t = a.target;
    // Solo "Salí ya". Con "capaz lo alcanzás" no suena: en el backtesting, quien salía ahí perdía el colectivo la mitad
    // de las veces o más; mejor esperar el "Salí ya" del siguiente. Tampoco por un bus del que no estamos seguros
    // (fantasma, en la terminal, ambiguo): mejor no avisar que avisar mal.
    if (a.state !== "leave-now" || !t || t.confidence === "low" || notified.has(t.busId)) return;
    notified.add(t.busId);
    const now = trueNow();
    deps.notify({
      title: `Salí ya para el ${lineName(t)}`,
      body: `Llega a tu parada en ${minutes(t.earlyAt - now)}–${minutes(t.lateAt - now)} min.`,
      tag: "rc-departure",
    });
    arm(false);
  }

  function recompute() {
    const now = trueNow();
    const walk = effectiveWalk(trip.walk, trip.stop, fix);
    const advice = catalog
      ? advise(list, { now, walkS: walk.minutes * 60, marginS: trip.marginMin * 60, feedAgeS: updatedAt === null ? null : (deps.now() - updatedAt) / 1000, lastPassedAt: lastCrossing(tracks) })
      : advise([], { now, walkS: 0, marginS: 0, feedAgeS: null });
    maybeNotify(advice);
    snapshot = { catalog: catalogState, trip, tripStatus, advice, buses: list, walk, armed, updatedAt, now };
    for (const l of listeners) l();
  }

  function arm(on: boolean) {
    armed = on;
    armedAt = deps.now();
    if (on) notified.clear();
    deps.keepScreenOn(on);
    recompute();
  }

  // Al volver a la página, el navegador ya soltó la pantalla prendida.
  const onVisibility = () => {
    if (armed && deps.doc.visibilityState === "visible") deps.keepScreenOn(true);
  };

  recompute();

  return {
    async start() {
      const gen = ++generation;
      const load = await deps.loadCatalog();
      // Se detuvo (o se volvió a arrancar) mientras bajaba el catálogo: no se toca nada, ni el viaje guardado.
      if (gen !== generation) return;
      useCatalog(load);
      recompute();
      polling = startPolling(poll, { intervalMs: REFRESH_MS, keepWhenHidden: () => armed, doc: deps.doc });
      tick = setInterval(() => deps.doc.visibilityState === "visible" && recompute(), TICK_MS);
      recheck = setInterval(async () => {
        const load = await deps.loadCatalog({ maxAgeMs: CATALOG_RECHECK_MS });
        if (gen !== generation) return;
        useCatalog(load);
        recompute();
      }, CATALOG_RECHECK_MS);
      deps.doc.addEventListener("visibilitychange", onVisibility);
    },
    stop() {
      generation++;
      polling?.stop();
      clearInterval(tick);
      clearInterval(recheck);
      deps.doc.removeEventListener("visibilitychange", onVisibility);
      if (armed) deps.keepScreenOn(false);
    },
    arm,
    /** La ubicación del momento, para el tiempo de caminata; `null` si no hay. No se guarda. */
    setFix(f: Fix | null) {
      fix = f;
      recompute();
    },
    /** El viaje cambió (minutos de caminata, margen, nombre): se recalcula sin perder el seguimiento. */
    setTrip(t: Trip) {
      const before = trip.passes;
      trip = t;
      reconcile();
      if (JSON.stringify(trip.passes) !== JSON.stringify(before)) {
        index = indexPasses(trip.passes);
        tracks = new Map();
        smooth = new Map();
        list = [];
      }
      recompute();
    },
    refresh: () => polling?.refresh(),
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getSnapshot: () => snapshot,
  };
}

export type DepartureController = ReturnType<typeof createDepartureController>;

export function browserDeps(): ControllerDeps {
  return {
    fetchFeed: (signal) => fetchLiveBuses(signal),
    loadCatalog: (o) => loadCatalog(o),
    now: () => Date.now(),
    doc: document,
    notify: alertNow,
    keepScreenOn,
    saveTrip: updateTrip,
  };
}
