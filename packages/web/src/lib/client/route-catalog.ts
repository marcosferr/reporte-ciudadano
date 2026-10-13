/**
 * Catálogo de todos los recorridos (/api/buses/routes), guardado en el teléfono. Se baja entero (~130 KB) y como
 * mucho una vez por día: elegir las líneas de una parada no le dice al servidor cuáles son.
 *
 * Va en IndexedDB y no en la Cache Storage: el service worker borra sus cachés en cada versión (sw.js).
 */
import { buildCatalog, type Catalog, type CatalogFile } from "@rc/core/bus-catalog";
import { PRIVATE_FETCH } from "./live-buses";

const DB = "rc-transit", STORE = "catalog", KEY = "current";
export const CATALOG_MAX_AGE_MS = 24 * 3_600_000;

interface Stored { file: CatalogFile; fetchedAt: number }

export interface CatalogLoad {
  catalog: Catalog | null;
  fetchedAt: number | null;
  /** No se pudo actualizar: es la última copia guardada (o no hay ninguna). */
  stale: boolean;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function read(): Promise<Stored | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).get(KEY);
    req.onsuccess = () => resolve(req.result as Stored | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function write(value: Stored): Promise<void> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, "readwrite");
    t.objectStore(STORE).put(value, KEY);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function clearCatalog(): Promise<void> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, "readwrite");
    t.objectStore(STORE).delete(KEY);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

const valid = (f: unknown): f is CatalogFile =>
  !!f && typeof f === "object" && typeof (f as CatalogFile).version === "string" && Array.isArray((f as CatalogFile).features);

// Armar el catálogo (proyectar ~45 mil vértices) se hace una vez por versión.
let built: Catalog | undefined;
const build = (file: CatalogFile) => (built?.version === file.version ? built : (built = buildCatalog(file)));

/** Arma el catálogo guardado; una copia que no se puede armar (de una versión anterior, dañada) no sirve. */
function tryBuild(file: CatalogFile): Catalog | null {
  try {
    return build(file);
  } catch {
    return null;
  }
}

export async function loadCatalog({ maxAgeMs = CATALOG_MAX_AGE_MS, force = false, now = Date.now(), fetch: f = fetch }: { maxAgeMs?: number; force?: boolean; now?: number; fetch?: typeof fetch } = {}): Promise<CatalogLoad> {
  let stored = await read().then((s) => (s && valid(s.file) && Number.isFinite(s.fetchedAt) ? s : undefined), () => undefined);
  const storedCatalog = stored ? tryBuild(stored.file) : null;
  if (!storedCatalog) stored = undefined;
  if (stored && storedCatalog && !force && now - stored.fetchedAt < maxAgeMs) return { catalog: storedCatalog, fetchedAt: stored.fetchedAt, stale: false };
  try {
    const res = await f("/api/buses/routes", PRIVATE_FETCH);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const file: unknown = await res.json();
    if (!valid(file)) throw new Error("catálogo inválido");
    const catalog = build(file);
    await write({ file, fetchedAt: now }).catch(() => {
      /* sin almacenamiento: se usa igual */
    });
    return { catalog, fetchedAt: now, stale: false };
  } catch {
    if (stored && storedCatalog) return { catalog: storedCatalog, fetchedAt: stored.fetchedAt, stale: true };
    return { catalog: null, fetchedAt: null, stale: true };
  }
}
