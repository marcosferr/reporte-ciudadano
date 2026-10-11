import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import { STATUS_LABEL, type Status } from "@rc/core/status";
import { ApiError, api } from "../../lib/client/api";
import { compressImage } from "../../lib/client/image";
import { ASU_BOUNDS, BASEMAP_STYLE, collapseAttribution } from "../../lib/client/map";
import { newOutboxItem, queueReport, sendReport, type SentReport } from "../../lib/client/outbox";
import { timeAgo } from "../../lib/format";
import Turnstile from "./Turnstile";

interface Category {
  slug: string; name: string; description: string | null; icon: string; color: string; accepting: boolean;
  extra_fields: { key: string; label: string }[];
}
interface Nearby { id: string; code: string; path: string; title: string; status: Status; distance_m: number; confirmations: number; created_at: string }
interface Photo { blob: Blob; url: string; gps?: { lat: number; lng: number } }

// Si la foto se sacó más lejos que esto del punto marcado, se ofrece usar su ubicación.
const PHOTO_LOCATION_MIN_M = 30;

type Step = "category" | "location" | "details" | "done";
type Outcome =
  | { queued: true }
  | { queued: false; report: SentReport; photosUploaded: number; photosSkipped: number; photosPending: boolean };

export default function ReportWizard({ categories, turnstileSiteKey, loggedIn, homeBBox }: {
  categories: Category[]; turnstileSiteKey: string; loggedIn: boolean; homeBBox?: [number, number, number, number];
}) {
  const [step, setStep] = useState<Step>("category");
  const [category, setCategory] = useState<Category>();
  const [point, setPoint] = useState<{ lat: number; lng: number }>();
  const [place, setPlace] = useState<string>("");
  const [nearby, setNearby] = useState<Nearby[]>([]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [busy, setBusy] = useState<string>("");
  const [err, setErr] = useState("");
  const [outcome, setOutcome] = useState<Outcome>();
  const online = useOnline();
  const [captcha, setCaptcha] = useState<string>();

  // Preselección por URL: /reportar?categoria=bache
  useEffect(() => {
    const slug = new URLSearchParams(location.search).get("categoria");
    const c = categories.find((x) => x.slug === slug && x.accepting);
    if (c) choose(c);
  }, []);

  function choose(c: Category) {
    setCategory(c);
    setTitle((t) => t || c.name);
    setStep("location");
    window.scrollTo({ top: 0 });
  }

  async function addPhotos(files: File[]) {
    setErr("");
    const room = 4 - photos.length;
    for (const file of files.slice(0, room)) {
      if (!file.type.startsWith("image/")) continue;
      try {
        const gps = await photoLocation(file);
        const blob = await compressImage(file);
        setPhotos((p) => [...p, { blob, url: URL.createObjectURL(blob), gps }].slice(0, 4));
      } catch {
        setErr("No pudimos leer una de las fotos. Probá con otra.");
      }
    }
  }

  // Ubicación guardada en la primera foto que la tenga (se lee antes de comprimir, que borra el EXIF).
  const photoPoint = photos.find((p) => p.gps)?.gps;
  const photoPointFar = !!photoPoint && !!point
    && new maplibregl.LngLat(photoPoint.lng, photoPoint.lat).distanceTo(new maplibregl.LngLat(point.lng, point.lat)) > PHOTO_LOCATION_MIN_M;

  async function submit() {
    if (!category || !point) return;
    setErr("");
    const item = newOutboxItem(
      { category: category.slug, title: title.trim(), description: description.trim(), lat: point.lat, lng: point.lng, address: place || undefined, extra },
      photos.map((p) => p.blob),
    );
    // Se guarda con lo que ya se hizo: si el reporte se creó, la cola solo sube las fotos que faltan.
    const queue = async () => {
      await queueReport(item);
      setOutcome(item.created
        ? { queued: false, report: item.created, photosUploaded: item.uploaded ?? 0, photosSkipped: 0, photosPending: true }
        : { queued: true });
      setStep("done");
    };
    if (!navigator.onLine) return queue();
    try {
      const res = await sendReport(item, { turnstile: captcha, onProgress: setBusy });
      setOutcome({ queued: false, ...res, photosPending: false });
      setStep("done");
    } catch (e) {
      // Un rechazo antes de crear el reporte se muestra; cualquier otra falla (señal que se corta, fotos que no
      // suben) se guarda en la cola, que sigue desde donde quedó.
      if (e instanceof ApiError && !item.created) setErr(e.message);
      else await queue();
    } finally {
      setBusy("");
    }
  }

  const stepIndex = { category: 0, location: 1, details: 2, done: 3 }[step];

  return (
    <div className="mx-auto max-w-xl px-4 pb-10">
      {step !== "done" && (
        <ol className="my-4 grid grid-cols-3 gap-2" aria-label="Pasos">
          {["Qué pasa", "Dónde", "Detalles"].map((s, i) => (
            <li key={s} className="text-center text-xs font-semibold">
              <div className={`mb-1 h-1.5 rounded-full ${i <= stepIndex ? "bg-brand-600" : "bg-fill-strong"}`} />
              <span className={i === stepIndex ? "text-accent" : "text-fg-subtle"}>{i + 1}. {s}</span>
            </li>
          ))}
        </ol>
      )}

      {step === "category" && (
        <section>
          <h1 className="mb-1 text-2xl font-extrabold">¿Qué problema querés reportar?</h1>
          <p className="mb-4 text-fg-muted">Elegí la categoría que mejor lo describa.</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {categories.map((c) => (
              <button key={c.slug} disabled={!c.accepting} onClick={() => choose(c)}
                className="card flex min-h-28 flex-col items-center justify-center gap-1 p-3 text-center transition hover:ring-2 hover:ring-brand-500 disabled:opacity-40">
                <span className="text-3xl" aria-hidden>{c.icon}</span>
                <span className="text-sm leading-tight font-semibold">{c.name}</span>
                {!c.accepting && <span className="text-[11px] text-fg-subtle">No disponible ahora</span>}
              </button>
            ))}
          </div>
        </section>
      )}

      {step === "location" && category && (
        <LocationStep
          category={category}
          initial={point ?? photoPoint}
          homeBBox={homeBBox}
          onBack={() => setStep("category")}
          onConfirm={(p, placeName, near) => {
            setPoint(p);
            setPlace(placeName);
            setNearby(near);
            setStep("details");
            window.scrollTo({ top: 0 });
          }}
        />
      )}

      {step === "details" && category && (
        <section className="space-y-4">
          <div className="flex items-center gap-3">
            <button className="btn-ghost px-3 py-2" onClick={() => setStep("location")} aria-label="Volver">←</button>
            <div>
              <h1 className="text-xl font-extrabold">{category.icon} {category.name}</h1>
              <p className="text-sm text-fg-subtle">{place || "Ubicación marcada en el mapa"}</p>
            </div>
          </div>

          {nearby.length > 0 && (
            <div className="rounded-2xl border border-warning-line bg-warning-soft p-4">
              <p className="font-semibold text-warning">¿Es alguno de estos? Ya fueron reportados muy cerca:</p>
              <ul className="mt-2 space-y-2">
                {nearby.map((n) => (
                  <li key={n.id} className="flex items-center justify-between gap-2 rounded-xl bg-surface p-2 text-sm">
                    <a href={n.path} className="min-w-0">
                      <p className="truncate font-semibold">{n.title}</p>
                      <p className="text-xs text-fg-subtle">a {n.distance_m} m · {STATUS_LABEL[n.status]} · {timeAgo(n.created_at)}</p>
                    </a>
                    <ConfirmExisting id={n.id} path={n.path} />
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-warning">Confirmar un reporte existente le da más fuerza que crear uno repetido.</p>
            </div>
          )}

          <div>
            <span className="label">Fotos (hasta 4)</span>
            <div className="grid grid-cols-4 gap-2">
              {photos.map((p, i) => (
                <div key={p.url} className="relative aspect-square overflow-hidden rounded-xl bg-fill">
                  <img src={p.url} alt={`Foto ${i + 1}`} className="h-full w-full object-cover" />
                  <button onClick={() => setPhotos(photos.filter((_, j) => j !== i))} className="absolute top-1 right-1 h-6 w-6 rounded-full bg-black/60 text-xs text-white" aria-label="Quitar foto">✕</button>
                </div>
              ))}
              {photos.length < 4 && (
                <label className="flex aspect-square cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-line-strong text-fg-subtle hover:border-brand-500">
                  <span className="text-2xl">📷</span>
                  <span className="text-[11px] font-semibold">Agregar</span>
                  <input type="file" accept="image/*" multiple className="sr-only" onChange={(e) => {
                    // Se vacía el input para que volver a elegir el mismo archivo dispare `change` otra vez.
                    const files = Array.from(e.target.files ?? []);
                    e.target.value = "";
                    addPhotos(files);
                  }} />
                </label>
              )}
            </div>
            <p className="mt-1 text-xs text-fg-subtle">Las caras se difuminan automáticamente y se borra la información oculta de la foto.</p>
            {photoPointFar && (
              <div className="mt-2 flex items-center justify-between gap-2 rounded-xl bg-surface p-3 text-sm text-fg ring-1 ring-line-strong">
                <p>La foto se sacó en otro lugar del que marcaste.</p>
                <button className="chip shrink-0 bg-brand-600 text-white" onClick={() => { setPoint(photoPoint); setStep("location"); }}>
                  Usar ubicación de la foto
                </button>
              </div>
            )}
          </div>

          <div>
            <label className="label" htmlFor="title">Título</label>
            <input id="title" className="input" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ej: Bache profundo frente a la escuela" />
          </div>
          <div>
            <label className="label" htmlFor="desc">Descripción <span className="font-normal text-fg-subtle">(opcional)</span></label>
            <textarea id="desc" className="input min-h-28" maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)}
              placeholder="¿Desde cuándo está así? ¿A quién afecta? Referencias para encontrarlo." />
          </div>
          {category.extra_fields.map((f) => (
            <div key={f.key}>
              <label className="label" htmlFor={`x-${f.key}`}>{f.label} <span className="font-normal text-fg-subtle">(opcional)</span></label>
              <input id={`x-${f.key}`} className="input" maxLength={200} value={extra[f.key] ?? ""} onChange={(e) => setExtra({ ...extra, [f.key]: e.target.value })} />
            </div>
          ))}

          {!loggedIn && turnstileSiteKey && <Turnstile siteKey={turnstileSiteKey} onToken={setCaptcha} />}

          {err && <p className="rounded-xl bg-danger-soft p-3 text-sm text-danger" role="alert">{err}</p>}
          <button className="btn-alert w-full text-lg" disabled={!!busy || title.trim().length < 5 || (!loggedIn && !!turnstileSiteKey && !captcha && online)} onClick={submit}>
            {busy || "Publicar reporte"}
          </button>
          <p className="text-center text-xs text-fg-subtle">
            Al publicar aceptás los <a className="underline" href="/terminos">términos de uso</a>. No incluyas datos personales ni acusaciones a personas.
          </p>
        </section>
      )}

      {step === "done" && outcome && (
        <section className="py-8 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-success-soft text-3xl">✓</div>
          {outcome.queued ? (
            <>
              <h1 className="text-2xl font-extrabold">Reporte guardado</h1>
              {/* Sin conexión la página puede venir de la caché, sin sesión: si hace falta el captcha, lo dice el servidor al enviar. */}
              <p className="mt-2 text-fg-muted">
                No hay conexión ahora. Lo vamos a enviar cuando vuelvas a tener señal y abras la app. Si hace falta confirmar
                que sos una persona, te lo pedimos en <a className="underline" href="/mis-reportes">Mis casos</a>.
              </p>
            </>
          ) : (
            <>
              <h1 className="text-2xl font-extrabold">¡Gracias por reportar!</h1>
              <p className="mt-2 text-fg-muted">Tu código de seguimiento es</p>
              <p className="my-2 font-mono text-2xl font-bold tracking-wider text-accent">{outcome.report.code}</p>
              {outcome.photosPending ? (
                <p className="text-sm text-fg-subtle">Faltan subir las fotos: las enviamos solas cuando vuelvas a tener señal y abras la app.</p>
              ) : outcome.photosSkipped > 0 ? (
                <p className="text-sm text-warning">No pudimos subir {outcome.photosSkipped === 1 ? "una de las fotos" : `${outcome.photosSkipped} de las fotos`}.</p>
              ) : (
                outcome.photosUploaded > 0 && <p className="text-sm text-fg-subtle">Las fotos aparecen en unos segundos, cuando terminan de procesarse.</p>
              )}
              {!loggedIn && <p className="mt-2 text-sm text-fg-subtle">Lo guardamos en este dispositivo, en <a className="underline" href="/mis-reportes">Mis casos</a>. Iniciá sesión si querés recibir avisos por correo.</p>}
              <div className="mt-6 grid gap-2">
                <a className="btn-primary" href={outcome.report.path}>Ver mi reporte</a>
                <a className="btn-ghost" target="_blank" rel="noopener"
                  href={`https://wa.me/?text=${encodeURIComponent(`Reporté "${outcome.report.title}" en Reporte Ciudadano. Sumate confirmándolo: ${location.origin}${outcome.report.path}`)}`}>
                  Compartir por WhatsApp
                </a>
                <a className="btn-ghost" href="/reportar">Hacer otro reporte</a>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}

function LocationStep({ category, initial, homeBBox, onBack, onConfirm }: {
  category: Category;
  initial?: { lat: number; lng: number };
  homeBBox?: [number, number, number, number];
  onBack: () => void;
  onConfirm: (p: { lat: number; lng: number }, place: string, nearby: Nearby[]) => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map>(undefined);
  const [center, setCenter] = useState<{ lat: number; lng: number }>();
  const [place, setPlace] = useState("");
  const [locating, setLocating] = useState(false);
  const [geoErr, setGeoErr] = useState("");
  const [checking, setChecking] = useState(false);
  // Sin conexión el mapa base no carga: se marca el lugar con el GPS del teléfono.
  const [mapReady, setMapReady] = useState(false);
  const [mapFailed, setMapFailed] = useState(false);
  const [gps, setGps] = useState<{ lat: number; lng: number; accuracy: number }>();

  useEffect(() => {
    const map = new maplibregl.Map({
      container: el.current!,
      style: BASEMAP_STYLE,
      ...(initial ? { center: [initial.lng, initial.lat], zoom: 17 }
        : { bounds: homeBBox ? [[homeBBox[0], homeBBox[1]], [homeBBox[2], homeBBox[3]]] : ASU_BOUNDS }),
      attributionControl: { compact: true },
      dragRotate: false,
    });
    collapseAttribution(map);
    map.touchZoomRotate.disableRotation();
    mapRef.current = map;
    const update = () => {
      const c = map.getCenter();
      setCenter({ lat: c.lat, lng: c.lng });
    };
    map.on("load", () => {
      setMapReady(true);
      update();
    });
    map.on("moveend", update);
    map.on("error", () => setMapFailed(true));
    if (!initial) locate();
    return () => map.remove();
  }, []);

  // Nombre del lugar (distrito, departamento) al mover el mapa.
  useEffect(() => {
    if (!center) return;
    const t = setTimeout(async () => {
      try {
        const r = await api<{ dept: string | null; district: string | null }>(`/api/locate?lat=${center.lat.toFixed(5)}&lng=${center.lng.toFixed(5)}`);
        setPlace([r.district, r.dept].filter(Boolean).join(", "));
      } catch {
        setPlace("");
      }
    }, 300);
    return () => clearTimeout(t);
  }, [center?.lat, center?.lng]);

  function locate() {
    if (!navigator.geolocation) return setGeoErr("Tu navegador no permite ubicarte.");
    setLocating(true);
    setGeoErr("");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        setGps({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy });
        mapRef.current?.flyTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: 17 });
      },
      () => {
        setLocating(false);
        setGeoErr("No pudimos obtener tu ubicación.");
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  const zoomOk = (mapRef.current?.getZoom() ?? 0) >= 14;
  const noMap = !mapReady && (mapFailed || !navigator.onLine);
  // Con mapa vale el centro (donde está el pin); sin mapa, el GPS o el lugar que ya estaba marcado.
  const chosen = noMap ? (gps ?? initial) : zoomOk ? center : undefined;

  async function confirm() {
    if (!chosen) return;
    const p = { lat: chosen.lat, lng: chosen.lng };
    setChecking(true);
    try {
      const near = await api<Nearby[]>(`/api/reports/nearby?lat=${p.lat}&lng=${p.lng}&category=${category.slug}`).catch(() => []);
      onConfirm(p, place, near);
    } finally {
      setChecking(false);
    }
  }

  return (
    <section>
      <div className="mb-3 flex items-center gap-3">
        <button className="btn-ghost px-3 py-2" onClick={onBack} aria-label="Volver">←</button>
        <div>
          <h1 className="text-xl font-extrabold">¿Dónde está?</h1>
          <p className="text-sm text-fg-subtle">{noMap ? "Usá el GPS de tu teléfono para marcar el lugar." : "Mové el mapa para que el pin quede sobre el problema."}</p>
        </div>
      </div>
      <div className="relative h-[55dvh] overflow-hidden rounded-2xl ring-1 ring-line">
        <div ref={el} className="h-full w-full" />
        <div className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-full text-4xl drop-shadow" aria-hidden>
          <svg width="36" height="48" viewBox="0 0 36 48"><path d="M18 0C8 0 0 8 0 18c0 13 18 30 18 30s18-17 18-30C36 8 28 0 18 0z" fill={category.color} /><circle cx="18" cy="18" r="7" fill="#fff" /></svg>
        </div>
        <button onClick={locate} className="btn-ghost absolute bottom-3 left-3 py-2 text-sm shadow" disabled={locating}>
          {locating ? "Ubicando…" : "📍 Mi ubicación"}
        </button>
      </div>
      <p className="mt-2 min-h-5 text-sm font-semibold text-fg-muted">{place}</p>
      {noMap ? (
        <p className="text-sm text-fg-muted">
          {navigator.onLine ? "No pudimos cargar el mapa." : "Sin conexión no podemos mostrar el mapa."} {gps
            ? `Vamos a usar la ubicación de tu teléfono (precisión de unos ${Math.round(gps.accuracy)} m): parate cerca del problema.`
            : initial
              ? "Vamos a usar el lugar que ya habías marcado, o tocá “Mi ubicación” para usar el GPS."
              : "Tocá “Mi ubicación” para usar el GPS de tu teléfono."}
        </p>
      ) : (
        !zoomOk && <p className="text-sm text-fg-subtle">Acercá el mapa para marcar el lugar con precisión.</p>
      )}
      {geoErr && <p className="text-sm text-warning">{geoErr} {noMap ? "Revisá que el GPS esté activado y probá de nuevo." : "Mové el mapa hasta el lugar del problema."}</p>}
      <button className="btn-primary mt-3 w-full" disabled={!chosen || checking} onClick={confirm}>
        {checking ? "Verificando…" : "Confirmar ubicación"}
      </button>
    </section>
  );
}

/** Coordenadas GPS del EXIF, si las tiene. Es opcional: si falla (p. ej. sin conexión para cargar `exifr`), la foto se agrega igual. */
async function photoLocation(file: File): Promise<{ lat: number; lng: number } | undefined> {
  try {
    const { gps } = await import("exifr");
    const g = await gps(file);
    return g?.latitude && g?.longitude ? { lat: g.latitude, lng: g.longitude } : undefined;
  } catch {
    return undefined;
  }
}

function ConfirmExisting({ id, path }: { id: string; path: string }) {
  const [done, setDone] = useState(false);
  return done ? (
    <a href={path} className="chip shrink-0 bg-success-soft text-success">¡Confirmado! Ver</a>
  ) : (
    <button className="chip shrink-0 bg-brand-600 text-white" onClick={async () => {
      await api(`/api/reports/${id}/confirm`, { method: "POST" }).catch(() => null);
      setDone(true);
    }}>Es este</button>
  );
}

function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}
