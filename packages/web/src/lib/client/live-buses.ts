/**
 * Colectivos en vivo (/api/buses), para el mapa y para ¿Cuándo salgo?. Los dos piden lo mismo, cada 10 s, sin
 * cookies ni Referer: el servidor no puede distinguir quién pregunta ni desde qué página.
 */
import type { LiveBus } from "@rc/core/departure";
import type { BusFeature } from "../server/buses";

export const REFRESH_MS = 10_000;
export const PRIVATE_FETCH = { credentials: "omit", referrerPolicy: "no-referrer" } as const satisfies RequestInit;

export interface LiveFeed {
  features: BusFeature[];
  /** Cuándo llegó la respuesta, con el reloj del teléfono. */
  receivedAt: number;
  /** Cuánto adelanta el reloj del teléfono respecto del servidor (ms), si se pudo medir. */
  clockOffsetMs?: number;
}

/** `null`: el VMT no respondió (502) o hubo otro error del servidor. */
export async function fetchLiveBuses(signal?: AbortSignal, f: typeof fetch = fetch): Promise<LiveFeed | null> {
  const res = await f("/api/buses", { ...PRIVATE_FETCH, signal });
  if (!res.ok) return null;
  const receivedAt = Date.now();
  const data = (await res.json()) as { features: BusFeature[] };
  const clockOffsetMs = clockOffsetFrom(res.headers, receivedAt);
  return { features: data.features, receivedAt, ...(clockOffsetMs === undefined ? {} : { clockOffsetMs }) };
}

/**
 * Desfasaje del reloj del teléfono: la respuesta se armó en `Date` (redondeado al segundo) y estuvo `Age` segundos
 * en la cache de CloudFront. La demora de la red lo infla, por eso se usa el mínimo de varias (`bestOffset`).
 */
export function clockOffsetFrom(headers: Headers, receivedAt: number): number | undefined {
  const date = Date.parse(headers.get("Date") ?? "");
  if (!Number.isFinite(date)) return undefined;
  const age = Number(headers.get("Age") ?? 0);
  return receivedAt - (date + (Number.isFinite(age) ? age : 0) * 1000 + 500);
}

/**
 * El desfasaje a usar: el mínimo de las últimas mediciones (menos de 5 s no vale la pena). Uno grande también se
 * corrige: con el reloj del teléfono muy atrasado, todos los buses parecerían reportar desde el futuro.
 */
export function bestOffset(samples: number[]): number {
  if (!samples.length) return 0;
  const min = Math.min(...samples.slice(-5));
  return Math.abs(min) < 5_000 ? 0 : min;
}

export function toLiveBus(f: BusFeature): LiveBus {
  const p = f.properties;
  return {
    id: p.id, companyCode: p.companyCode, route: p.route, line: p.line, coordinates: f.geometry.coordinates,
    at: Date.parse(p.at), speed: p.speed, ...(p.heading === undefined ? {} : { heading: p.heading }),
  };
}

type Doc = Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;

/**
 * Corre `run` cada `intervalMs` mientras la página está a la vista (o siempre que `keepWhenHidden` diga que sí, p. ej.
 * con el aviso armado), y apenas vuelve a estar a la vista. Un pedido nuevo cancela el anterior.
 */
export function startPolling(run: (signal: AbortSignal) => Promise<void>, { intervalMs, keepWhenHidden = () => false, doc = document }: { intervalMs: number; keepWhenHidden?: () => boolean; doc?: Doc }) {
  let ctrl: AbortController | undefined;
  const tick = () => {
    if (doc.visibilityState !== "visible" && !keepWhenHidden()) return;
    ctrl?.abort();
    ctrl = new AbortController();
    run(ctrl.signal).catch(() => {
      /* sin conexión o cancelado: queda lo último */
    });
  };
  const onVisibility = () => {
    if (doc.visibilityState === "visible") tick();
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  doc.addEventListener("visibilitychange", onVisibility);
  return {
    refresh: tick,
    stop() {
      clearInterval(timer);
      doc.removeEventListener("visibilitychange", onVisibility);
      ctrl?.abort();
    },
  };
}
