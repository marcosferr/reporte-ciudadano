/**
 * Viajes guardados de ¿Cuándo salgo?: la parada, las líneas que le sirven a la persona y lo que tarda en llegar.
 * Quedan solo en este teléfono (localStorage); no se guarda desde dónde sale, solo los minutos.
 */
import { choiceOf, passesFor, STOP_CFG, type Catalog, type StopOption, type TripPlace } from "@rc/core/bus-catalog";
import type { LngLat } from "@rc/core/geo";

export type WalkMode = "auto" | "manual" | "measured";
export interface Walk {
  /** auto: con la ubicación del momento, o los minutos guardados si no hay; manual: lo que puso la persona;
   *  measured: lo que tardó las últimas veces que tocó "Ya salí". */
  mode: WalkMode;
  minutes: number;
  paceKmh: number;
  /** Últimas caminatas medidas (minutos). */
  samples: number[];
}

export interface Trip extends TripPlace { v: 1; id: string; name: string; walk: Walk; marginMin: number; updatedAt: number }

export const PACES = [
  { label: "Tranqui", kmh: 3.5 },
  { label: "Normal", kmh: 4.5 },
  { label: "Rápido", kmh: 5.5 },
] as const;
export const DEFAULT_MARGIN_MIN = 2;

export const TRIPS_KEY = "rc:trips";
const SELECTED_KEY = "rc:trip";

export function getTrips(): Trip[] {
  try {
    const list = JSON.parse(localStorage.getItem(TRIPS_KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((t): t is Trip => t?.v === 1 && Array.isArray(t.stop) && Array.isArray(t.choices)) : [];
  } catch {
    return [];
  }
}

function write(list: Trip[]) {
  try {
    if (list.length) localStorage.setItem(TRIPS_KEY, JSON.stringify(list));
    else localStorage.removeItem(TRIPS_KEY);
  } catch {
    /* sin almacenamiento: el viaje dura lo que la pestaña */
  }
}

export function saveTrip(t: Trip) {
  const list = getTrips();
  const i = list.findIndex((x) => x.id === t.id);
  if (i >= 0) list[i] = t;
  else list.push(t);
  write(list);
}

/** Reemplaza un viaje que ya está guardado; uno que la persona borró no vuelve. */
export function updateTrip(t: Trip) {
  const list = getTrips();
  const i = list.findIndex((x) => x.id === t.id);
  if (i < 0) return;
  list[i] = t;
  write(list);
}

export function deleteTrip(id: string) {
  write(getTrips().filter((t) => t.id !== id));
}

/** "Borrar mis paradas": no queda nada de ¿Cuándo salgo? en el teléfono. */
export function clearTrips() {
  write([]);
  try {
    localStorage.removeItem(SELECTED_KEY);
  } catch {
    /* sin almacenamiento */
  }
}

export function getSelectedTrip(): string | null {
  try {
    return localStorage.getItem(SELECTED_KEY);
  } catch {
    return null;
  }
}

export function setSelectedTrip(id: string) {
  try {
    localStorage.setItem(SELECTED_KEY, id);
  } catch {
    /* sin almacenamiento */
  }
}

const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export function newTrip(input: { name: string; stop: LngLat; options: StopOption[]; radiusM: number; walk: Walk; marginMin: number }, catalog: Catalog, now = Date.now()): Trip {
  const choices = input.options.map(choiceOf);
  return {
    v: 1, id: newId(), name: input.name.trim() || "Mi parada", stop: input.stop, choices, radiusM: input.radiusM,
    passes: passesFor(catalog, input.stop, choices, input.radiusM + STOP_CFG.RECONCILE_EXTRA_M),
    catalogVersion: catalog.version, walk: input.walk, marginMin: input.marginMin, updatedAt: now,
  };
}

/** Suma una caminata medida (se guardan las últimas 5) y desde ahí se usa lo medido. */
export function withMeasuredWalk(t: Trip, minutes: number, now = Date.now()): Trip {
  return { ...t, walk: { ...t.walk, mode: t.walk.mode === "manual" ? "manual" : "measured", samples: [...t.walk.samples, minutes].slice(-5) }, updatedAt: now };
}
