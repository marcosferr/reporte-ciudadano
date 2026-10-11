import { ApiError, PhotoRejected, api, uploadPhoto, type NewReport, type Upload } from "./api";
import { saveMyReport, setMissingPhotos } from "./my-reports";

// Cola de reportes (IndexedDB guarda también las fotos). Cada etapa del envío queda anotada en el ítem, así
// que un reintento sigue donde quedó: si el reporte ya se creó, solo se suben las fotos que faltan.
const DB = "rc-outbox", STORE = "reports";
// Los POST prefirmados de S3 vencen a los 10 minutos (lib/server/services.ts): se piden de nuevo antes.
const UPLOAD_TTL_MS = 9 * 60 * 1000;
/** Se emite en `window` cuando cambia la cola. */
export const OUTBOX_EVENT = "rc:outbox";

export interface SentReport { id: string; code: string; path: string; title: string }

export interface OutboxItem {
  id?: number;
  data: NewReport;
  photos: Blob[];
  queued_at: number;
  /** Sin valor (ítems de versiones anteriores) equivale a "pending". */
  status?: "pending" | "captcha" | "failed";
  error?: string;
  created?: SentReport & { anonToken?: string };
  uploads?: Upload[];
  uploads_at?: number;
  uploaded?: number;
  /** Fotos que se dejaron de lado: rechazadas, o sin lugar en el reporte. Van antes de la próxima a subir. */
  skipped?: number;
}

export interface SendResult { report: SentReport; photosUploaded: number; photosSkipped: number }

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then((db) => new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

const notify = () => window.dispatchEvent(new Event(OUTBOX_EVENT));

/**
 * Guarda el avance de un ítem que sigue en la cola. Uno que se envía directo todavía no tiene `id`, y uno que la
 * persona descartó mientras se enviaba no vuelve a aparecer.
 */
async function save(item: OutboxItem) {
  if (item.id === undefined) return;
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORE, "readwrite");
    const store = t.objectStore(STORE);
    const found = store.getKey(item.id!);
    found.onsuccess = () => {
      if (found.result !== undefined) store.put(item);
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export function newOutboxItem(data: NewReport, photos: Blob[]): OutboxItem {
  return { data, photos, queued_at: Date.now(), status: "pending", uploaded: 0 };
}

export async function queueReport(item: OutboxItem) {
  item.id = await tx<IDBValidKey>("readwrite", (s) => (item.id === undefined ? s.add(item) : s.put(item))) as number;
  notify();
}

export async function listOutbox(): Promise<OutboxItem[]> {
  try {
    return await tx<OutboxItem[]>("readonly", (s) => s.getAll());
  } catch {
    return [];
  }
}

export async function discardOutbox(id: number) {
  const item = await tx<OutboxItem | undefined>("readonly", (s) => s.get(id));
  await tx("readwrite", (s) => s.delete(id));
  // Un reporte ya publicado queda sin las fotos que faltaban: Mis casos lo avisa.
  if (item?.created) setMissingPhotos(item.created.id, item.photos.length - (item.uploaded ?? 0));
  notify();
}

/** Vuelve a intentar un ítem que falló o espera el captcha (p. ej. después de iniciar sesión). */
export async function retryOutbox(ids: number[]) {
  for (const item of await listOutbox()) {
    if (item.id !== undefined && ids.includes(item.id)) await tx("readwrite", (s) => s.put({ ...item, status: "pending", error: undefined }));
  }
  await flushOutbox();
}

/**
 * Envía un reporte etapa por etapa: lo crea (una sola vez) y sube las fotos de a una, anotando cada avance.
 * Si algo falla, el ítem queda con lo hecho hasta ahí y el error sube a quien llamó.
 */
export async function sendReport(item: OutboxItem, opts: { turnstile?: string; onProgress?: (msg: string) => void } = {}): Promise<SendResult> {
  if (!item.created) {
    opts.onProgress?.("Enviando reporte…");
    const res = await api<{ report: SentReport; anonToken?: string; uploads: Upload[] }>("/api/reports", {
      method: "POST",
      json: { ...item.data, turnstile: opts.turnstile, photos: item.photos.length },
    });
    Object.assign(item, { created: { ...res.report, anonToken: res.anonToken }, uploads: res.uploads, uploads_at: Date.now(), uploaded: 0 });
    await save(item);
    saveMyReport({ ...res.report, token: res.anonToken, created_at: new Date().toISOString() });
  }
  const { anonToken, ...report } = item.created!;
  const photosApi = (json: { count: number } | { renew: string[] }) =>
    api<{ uploads: Upload[] }>(`/api/reports/${report.id}/photos`, { method: "POST", json: { ...json, anonToken } }).then((r) => r.uploads);
  const total = item.photos.length;
  const skip = async (count: number) => {
    item.skipped = (item.skipped ?? 0) + count;
    setMissingPhotos(report.id, item.skipped);
    await save(item);
  };
  while ((item.uploaded ?? 0) + (item.skipped ?? 0) < total) {
    const done = item.uploaded ?? 0;
    const next = done + (item.skipped ?? 0);
    if (!item.uploads?.length || Date.now() - (item.uploads_at ?? 0) > UPLOAD_TTL_MS) {
      // Las reservas que vencieron sin recibir su foto siguen ocupando el cupo del reporte: se vuelven a firmar.
      const renewed = item.uploads?.length ? await photosApi({ renew: item.uploads.map((u) => u.fields.key) }) : [];
      const uploads = renewed.length ? renewed : await photosApi({ count: total - next });
      // Sin lugar para más fotos (o sin bucket, en local): el reporte queda publicado con las que entraron.
      if (!uploads.length) {
        item.uploads = [];
        await skip(total - next);
        continue;
      }
      Object.assign(item, { uploads, uploads_at: Date.now() });
      await save(item);
      continue;
    }
    opts.onProgress?.(`Subiendo fotos (${done}/${total})…`);
    try {
      // Si falla, los permisos quedan guardados y el próximo intento los reusa mientras no venzan: pedir nuevos
      // ocuparía más lugares del cupo de fotos del reporte.
      await uploadPhoto(item.uploads[0], item.photos[next]);
    } catch (err) {
      if (!(err instanceof PhotoRejected)) throw err;
      // Esa foto no va a subir nunca: se deja de lado (su permiso sirve para la siguiente) para no trabar la cola.
      await skip(1);
      continue;
    }
    Object.assign(item, { uploaded: done + 1, uploads: item.uploads.slice(1) });
    await save(item);
  }
  return { report, photosUploaded: item.uploaded ?? 0, photosSkipped: item.skipped ?? 0 };
}

/**
 * Envía lo que haya en la cola. `turnstile` es un captcha recién resuelto: sirve para un solo reporte, el
 * primero que espera captcha. Los que esperan captcha sin token no se intentan, porque cada intento gasta el
 * límite de reportes por hora de esa IP.
 */
export async function flushOutbox(turnstile?: string) {
  if (!navigator.onLine || typeof indexedDB === "undefined") return;
  try {
    await exclusive(() => flush(turnstile), !!turnstile);
  } catch {
    /* IndexedDB no disponible */
  } finally {
    notify();
  }
}

let flushing: Promise<void> | undefined;

/**
 * Un solo envío a la vez: si no, dos envíos (dos pestañas, o el de la carga y el del evento `online`) publicaban
 * el mismo reporte. Sin `wait`, si ya hay uno en curso no hace nada; con `wait` (trae un captcha, que no se puede
 * tirar) espera su turno.
 */
async function exclusive(fn: () => Promise<void>, wait: boolean) {
  if (navigator.locks) return void (await navigator.locks.request("rc-outbox", { ifAvailable: !wait }, (lock) => (lock ? fn() : undefined)));
  // Sin Web Locks (Safari anterior a 15.4) solo se cuida esta pestaña.
  if (flushing && !wait) return;
  while (flushing) await flushing.catch(() => {});
  flushing = fn();
  try {
    await flushing;
  } finally {
    flushing = undefined;
  }
}

async function flush(turnstile?: string) {
  let token = turnstile;
  for (const item of await tx<OutboxItem[]>("readonly", (s) => s.getAll())) {
    if (item.status === "failed" || (item.status === "captcha" && !token)) continue;
    // Pudo descartarse mientras se enviaba otro.
    if ((await tx("readonly", (s) => s.getKey(item.id!))) === undefined) continue;
    const useToken = item.status === "captcha" ? token : undefined;
    if (useToken) token = undefined;
    try {
      await sendReport(item, { turnstile: useToken });
      await tx("readwrite", (s) => s.delete(item.id!));
    } catch (err) {
      // Sin conexión, límite de frecuencia o servidor caído: se reintenta en el próximo envío.
      if (!(err instanceof ApiError) || err.status === 429 || err.status >= 500) break;
      // El resto no se arregla reintentando solo: queda en la cola, a la vista, hasta que la persona decida.
      await save({ ...item, status: err.code === "captcha" ? "captcha" : "failed", error: err.message });
    }
  }
}
