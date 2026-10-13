/**
 * Cuánto tarda la persona en llegar a su parada. Todo en el teléfono: la ubicación se usa en el momento y no se
 * guarda; del viaje solo quedan minutos.
 */
import { CFG, medianWalk, walkMinutes } from "@rc/core/departure";
import { distanceM, type LngLat } from "@rc/core/geo";
import type { Walk } from "./trips";

export interface Fix { lngLat: LngLat; accuracy: number; t: number }

// Una ubicación menos precisa que esto no sirve para medir unos cientos de metros.
const MAX_ACCURACY_M = 100;
// Más cerca que esto, ya está en la parada.
export const AT_STOP_M = 30;
// Si lo estimado desde donde está difiere de lo medido en más de esto, no está saliendo del lugar de siempre.
const SAME_PLACE_RATIO = 0.4;

export interface WalkEstimate {
  minutes: number;
  source: "here" | "at-stop" | "measured" | "manual" | "saved";
  distanceM?: number;
}

/**
 * Lo que va a tardar: lo que puso a mano; si no, lo medido cuando sale del lugar de siempre (lo estimado desde
 * donde está se parece); si no, lo estimado desde donde está; si no hay ubicación, lo guardado.
 */
export function effectiveWalk(walk: Walk, stop: LngLat, fix: Fix | null): WalkEstimate {
  if (walk.mode === "manual") return { minutes: walk.minutes, source: "manual" };
  const measured = walk.mode === "measured" ? medianWalk(walk.samples) : undefined;
  const here = fix && fix.accuracy <= MAX_ACCURACY_M ? distanceM(fix.lngLat, stop) : undefined;
  if (here !== undefined && here <= AT_STOP_M) return { minutes: 0, source: "at-stop", distanceM: Math.round(here) };
  if (here === undefined) return measured !== undefined ? { minutes: measured, source: "measured" } : { minutes: walk.minutes, source: "saved" };
  const estimate = walkMinutes(fix!.lngLat, stop, walk.paceKmh);
  if (measured !== undefined && Math.abs(estimate - measured) <= measured * SAME_PLACE_RATIO) return { minutes: measured, source: "measured", distanceM: Math.round(here * CFG.WALK_DETOUR) };
  return { minutes: estimate, source: "here", distanceM: Math.round(here * CFG.WALK_DETOUR) };
}

/** Se corta la medición si no llega en este tiempo (se fue a otro lado o se olvidó). */
export const MEASURE_TIMEOUT_MS = 30 * 60_000;

/**
 * Mide la caminata: desde ahora hasta que la ubicación entra a la parada. `watch` es `watchPosition` (inyectado para
 * testear) y devuelve cómo dejar de mirar. Llama a `done` con los minutos, o `null` si no llegó a tiempo.
 */
export function measureWalk(stop: LngLat, watch: (onFix: (f: Fix) => void) => () => void, done: (minutes: number | null) => void, now = () => Date.now()): () => void {
  const start = now();
  let finished = false;
  let unwatch = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (minutes: number | null) => {
    if (finished) return;
    finished = true;
    unwatch();
    clearTimeout(timer);
    done(minutes);
  };
  timer = setTimeout(() => finish(null), MEASURE_TIMEOUT_MS);
  const stopWatching = watch((f) => {
    if (f.t - start > MEASURE_TIMEOUT_MS) return finish(null);
    if (distanceM(f.lngLat, stop) <= AT_STOP_M + Math.min(f.accuracy, 50) / 2) finish(Math.max(1, Math.round((f.t - start) / 60_000)));
  });
  // Una ubicación que llegó antes de que `watch` devolviera cómo dejar de mirar ya pudo terminar la medición.
  if (finished) stopWatching();
  else unwatch = stopWatching;
  return () => finish(null);
}

/** `watchPosition` del navegador como lo usa `measureWalk`. */
export function browserWatch(onFix: (f: Fix) => void, onError?: (e: GeolocationPositionError) => void): () => void {
  if (!("geolocation" in navigator)) return () => {};
  const id = navigator.geolocation.watchPosition(
    (p) => onFix({ lngLat: [p.coords.longitude, p.coords.latitude], accuracy: p.coords.accuracy, t: p.timestamp }),
    (e) => onError?.(e),
    { enableHighAccuracy: true, maximumAge: 10_000, timeout: 30_000 },
  );
  return () => navigator.geolocation.clearWatch(id);
}
