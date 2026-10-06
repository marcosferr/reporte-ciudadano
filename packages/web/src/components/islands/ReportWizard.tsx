import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import { STATUS_LABEL, type Status } from "@rc/core/status";
import { ApiError, api, submitReport, type Created } from "../../lib/client/api";
import { compressImage } from "../../lib/client/image";
import { ASU_BOUNDS, BASEMAP_STYLE, collapseAttribution } from "../../lib/client/map";
import { queueReport } from "../../lib/client/outbox";
import { timeAgo } from "../../lib/format";

interface Category {
  slug: string; name: string; description: string | null; icon: string; color: string; accepting: boolean;
  extra_fields: { key: string; label: string }[];
}
interface Nearby { id: string; code: string; path: string; title: string; status: Status; distance_m: number; confirmations: number; created_at: string }
interface Photo { blob: Blob; url: string }

type Step = "category" | "location" | "details" | "done";

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
  const [exifPoint, setExifPoint] = useState<{ lat: number; lng: number }>();
  const [busy, setBusy] = useState<string>("");
  const [err, setErr] = useState("");
  const [created, setCreated] = useState<Created & { queued?: boolean }>();
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

  async function addPhotos(files: FileList | null) {
    if (!files) return;
    setErr("");
    const room = 4 - photos.length;
    for (const file of Array.from(files).slice(0, room)) {
      if (!file.type.startsWith("image/")) continue;
      try {
        if (!exifPoint) {
          const { gps } = await import("exifr");
          const g = await gps(file).catch(() => null);
          if (g?.latitude && g?.longitude) setExifPoint({ lat: g.latitude, lng: g.longitude });
        }
        const blob = await compressImage(file);
        setPhotos((p) => [...p, { blob, url: URL.createObjectURL(blob) }].slice(0, 4));
      } catch {
        setErr("No pudimos leer una de las fotos. Probá con otra.");
      }
    }
  }

  async function submit() {
    if (!category || !point) return;
    setErr("");
    const data = { category: category.slug, title: title.trim(), description: description.trim(), lat: point.lat, lng: point.lng, address: place || undefined, extra, turnstile: captcha };
    if (!navigator.onLine) {
      await queueReport(data, photos.map((p) => p.blob));
      setCreated({ queued: true } as any);
      setStep("done");
      return;
    }
    try {
      const res = await submitReport(data, photos.map((p) => p.blob), setBusy);
      setCreated(res);
      setStep("done");
    } catch (e) {
      if (e instanceof ApiError) setErr(e.message);
      else {
        // Sin señal a mitad del envío: se guarda para reintentar.
        await queueReport(data, photos.map((p) => p.blob));
        setCreated({ queued: true } as any);
        setStep("done");
      }
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
              <div className={`mb-1 h-1.5 rounded-full ${i <= stepIndex ? "bg-brand-600" : "bg-slate-200"}`} />
              <span className={i === stepIndex ? "text-brand-700" : "text-slate-400"}>{i + 1}. {s}</span>
            </li>
          ))}
        </ol>
      )}

      {step === "category" && (
        <section>
          <h1 className="mb-1 text-2xl font-extrabold">¿Qué problema querés reportar?</h1>
          <p className="mb-4 text-slate-600">Elegí la categoría que mejor lo describa.</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {categories.map((c) => (
              <button key={c.slug} disabled={!c.accepting} onClick={() => choose(c)}
                className="card flex min-h-28 flex-col items-center justify-center gap-1 p-3 text-center transition hover:ring-2 hover:ring-brand-500 disabled:opacity-40">
                <span className="text-3xl" aria-hidden>{c.icon}</span>
                <span className="text-sm leading-tight font-semibold">{c.name}</span>
                {!c.accepting && <span className="text-[11px] text-slate-500">No disponible ahora</span>}
              </button>
            ))}
          </div>
        </section>
      )}

      {step === "location" && category && (
        <LocationStep
          category={category}
          initial={point ?? exifPoint}
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
              <p className="text-sm text-slate-500">{place || "Ubicación marcada en el mapa"}</p>
            </div>
          </div>

          {nearby.length > 0 && (
            <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4">
              <p className="font-semibold text-amber-900">¿Es alguno de estos? Ya fueron reportados muy cerca:</p>
              <ul className="mt-2 space-y-2">
                {nearby.map((n) => (
                  <li key={n.id} className="flex items-center justify-between gap-2 rounded-xl bg-white p-2 text-sm">
                    <a href={n.path} className="min-w-0">
                      <p className="truncate font-semibold">{n.title}</p>
                      <p className="text-xs text-slate-500">a {n.distance_m} m · {STATUS_LABEL[n.status]} · {timeAgo(n.created_at)}</p>
                    </a>
                    <ConfirmExisting id={n.id} path={n.path} />
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-amber-800">Confirmar un reporte existente le da más fuerza que crear uno repetido.</p>
            </div>
          )}

          <div>
            <span className="label">Fotos (hasta 4)</span>
            <div className="grid grid-cols-4 gap-2">
              {photos.map((p, i) => (
                <div key={p.url} className="relative aspect-square overflow-hidden rounded-xl bg-slate-100">
                  <img src={p.url} alt={`Foto ${i + 1}`} className="h-full w-full object-cover" />
                  <button onClick={() => setPhotos(photos.filter((_, j) => j !== i))} className="absolute top-1 right-1 h-6 w-6 rounded-full bg-black/60 text-xs text-white" aria-label="Quitar foto">✕</button>
                </div>
              ))}
              {photos.length < 4 && (
                <label className="flex aspect-square cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-300 text-slate-500 hover:border-brand-500">
                  <span className="text-2xl">📷</span>
                  <span className="text-[11px] font-semibold">Agregar</span>
                  <input type="file" accept="image/*" capture="environment" multiple className="sr-only" onChange={(e) => addPhotos(e.target.files)} />
                </label>
              )}
            </div>
            <p className="mt-1 text-xs text-slate-500">Las caras se difuminan automáticamente y se borra la información oculta de la foto.</p>
          </div>

          <div>
            <label className="label" htmlFor="title">Título</label>
            <input id="title" className="input" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ej: Bache profundo frente a la escuela" />
          </div>
          <div>
            <label className="label" htmlFor="desc">Descripción <span className="font-normal text-slate-400">(opcional)</span></label>
            <textarea id="desc" className="input min-h-28" maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)}
              placeholder="¿Desde cuándo está así? ¿A quién afecta? Referencias para encontrarlo." />
          </div>
          {category.extra_fields.map((f) => (
            <div key={f.key}>
              <label className="label" htmlFor={`x-${f.key}`}>{f.label} <span className="font-normal text-slate-400">(opcional)</span></label>
              <input id={`x-${f.key}`} className="input" maxLength={200} value={extra[f.key] ?? ""} onChange={(e) => setExtra({ ...extra, [f.key]: e.target.value })} />
            </div>
          ))}

          {!loggedIn && turnstileSiteKey && <Turnstile siteKey={turnstileSiteKey} onToken={setCaptcha} />}

          {err && <p className="rounded-xl bg-red-50 p-3 text-sm text-red-700" role="alert">{err}</p>}
          <button className="btn-alert w-full text-lg" disabled={!!busy || title.trim().length < 5 || (!loggedIn && !!turnstileSiteKey && !captcha)} onClick={submit}>
            {busy || "Publicar reporte"}
          </button>
          <p className="text-center text-xs text-slate-500">
            Al publicar aceptás los <a className="underline" href="/terminos">términos de uso</a>. No incluyas datos personales ni acusaciones a personas.
          </p>
        </section>
      )}

      {step === "done" && created && (
        <section className="py-8 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-green-100 text-3xl">✓</div>
          {created.queued ? (
            <>
              <h1 className="text-2xl font-extrabold">Reporte guardado</h1>
              <p className="mt-2 text-slate-600">No hay conexión ahora. Lo vamos a enviar automáticamente cuando vuelvas a tener señal y abras la app.</p>
            </>
          ) : (
            <>
              <h1 className="text-2xl font-extrabold">¡Gracias por reportar!</h1>
              <p className="mt-2 text-slate-600">Tu código de seguimiento es</p>
              <p className="my-2 font-mono text-2xl font-bold tracking-wider text-brand-700">{created.report.code}</p>
              {created.photosUploaded > 0 && <p className="text-sm text-slate-500">Las fotos aparecen en unos segundos, cuando terminan de procesarse.</p>}
              {!loggedIn && <p className="mt-2 text-sm text-slate-500">Lo guardamos en este dispositivo, en <a className="underline" href="/mis-reportes">Mis casos</a>. Iniciá sesión si querés recibir avisos por correo.</p>}
              <div className="mt-6 grid gap-2">
                <a className="btn-primary" href={created.report.path}>Ver mi reporte</a>
                <a className="btn-ghost" target="_blank" rel="noopener"
                  href={`https://wa.me/?text=${encodeURIComponent(`Reporté "${created.report.title}" en Reporte Ciudadano. Sumate confirmándolo: ${location.origin}${created.report.path}`)}`}>
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
    map.on("load", update);
    map.on("moveend", update);
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
    if (!navigator.geolocation) return setGeoErr("Tu navegador no permite ubicarte. Mové el mapa hasta el lugar.");
    setLocating(true);
    setGeoErr("");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        mapRef.current?.flyTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: 17 });
      },
      () => {
        setLocating(false);
        setGeoErr("No pudimos obtener tu ubicación. Mové el mapa hasta el lugar del problema.");
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  const zoomOk = (mapRef.current?.getZoom() ?? 0) >= 14;

  async function confirm() {
    if (!center) return;
    setChecking(true);
    try {
      const near = await api<Nearby[]>(`/api/reports/nearby?lat=${center.lat}&lng=${center.lng}&category=${category.slug}`).catch(() => []);
      onConfirm(center, place, near);
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
          <p className="text-sm text-slate-500">Mové el mapa para que el pin quede sobre el problema.</p>
        </div>
      </div>
      <div className="relative h-[55dvh] overflow-hidden rounded-2xl ring-1 ring-slate-200">
        <div ref={el} className="h-full w-full" />
        <div className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-full text-4xl drop-shadow" aria-hidden>
          <svg width="36" height="48" viewBox="0 0 36 48"><path d="M18 0C8 0 0 8 0 18c0 13 18 30 18 30s18-17 18-30C36 8 28 0 18 0z" fill={category.color} /><circle cx="18" cy="18" r="7" fill="#fff" /></svg>
        </div>
        <button onClick={locate} className="btn-ghost absolute bottom-3 left-3 py-2 text-sm shadow" disabled={locating}>
          {locating ? "Ubicando…" : "📍 Mi ubicación"}
        </button>
      </div>
      <p className="mt-2 min-h-5 text-sm font-semibold text-slate-700">{place}</p>
      {geoErr && <p className="text-sm text-amber-700">{geoErr}</p>}
      {!zoomOk && <p className="text-sm text-slate-500">Acercá el mapa para marcar el lugar con precisión.</p>}
      <button className="btn-primary mt-3 w-full" disabled={!center || !zoomOk || checking} onClick={confirm}>
        {checking ? "Verificando…" : "Confirmar ubicación"}
      </button>
    </section>
  );
}

function ConfirmExisting({ id, path }: { id: string; path: string }) {
  const [done, setDone] = useState(false);
  return done ? (
    <a href={path} className="chip shrink-0 bg-green-100 text-green-800">¡Confirmado! Ver</a>
  ) : (
    <button className="chip shrink-0 bg-brand-600 text-white" onClick={async () => {
      await api(`/api/reports/${id}/confirm`, { method: "POST" }).catch(() => null);
      setDone(true);
    }}>Es este</button>
  );
}

declare global {
  interface Window { turnstile?: any }
}

function Turnstile({ siteKey, onToken }: { siteKey: string; onToken: (t: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const render = () => window.turnstile?.render(ref.current, { sitekey: siteKey, callback: onToken, language: "es", appearance: "interaction-only" });
    if (window.turnstile) return void render();
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = render;
    document.head.append(s);
  }, []);
  return <div ref={ref} />;
}
