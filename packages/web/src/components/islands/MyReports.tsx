import { useEffect, useState } from "react";
import { getMyReports, type MyReport } from "../../lib/client/my-reports";
import { discardOutbox, flushOutbox, listOutbox, OUTBOX_EVENT, retryOutbox, type OutboxItem } from "../../lib/client/outbox";
import { timeAgo } from "../../lib/format";
import Turnstile from "./Turnstile";

function queueStatus(item: OutboxItem): string {
  if (item.status === "captcha") return "Falta confirmar que sos una persona.";
  if (item.status === "failed") return `No se pudo enviar: ${item.error}`;
  return item.created ? "Publicado. Faltan subir las fotos." : "Esperando conexión para enviarse.";
}

/** Reportes hechos desde este dispositivo sin cuenta, y los que todavía no terminaron de enviarse. */
export default function MyReports({ turnstileSiteKey, loggedIn }: { turnstileSiteKey: string; loggedIn: boolean }) {
  const [items, setItems] = useState<MyReport[]>([]);
  const [queue, setQueue] = useState<OutboxItem[]>([]);
  // Cada token de captcha sirve para un solo reporte: al cambiar la key se dibuja un captcha nuevo. Si el envío
  // no avanzó (captcha rechazado, límite de frecuencia), se espera un toque: el captcha se resuelve solo, y
  // dibujar otro enseguida reintentaba cada pocos segundos y gastaba el límite de reportes por hora.
  const [captcha, setCaptcha] = useState({ round: 0, stalled: false });
  const [code, setCode] = useState("");
  useEffect(() => {
    const refresh = () => {
      setItems(getMyReports());
      listOutbox().then(setQueue);
    };
    refresh();
    window.addEventListener(OUTBOX_EVENT, refresh);
    return () => window.removeEventListener(OUTBOX_EVENT, refresh);
  }, []);
  const waitingCaptcha = queue.filter((i) => i.status === "captcha").map((i) => i.id!);
  async function sendWithCaptcha(token: string) {
    await flushOutbox(token);
    const left = (await listOutbox()).filter((i) => i.status === "captcha").length;
    setCaptcha((c) => ({ round: c.round + 1, stalled: left >= waitingCaptcha.length }));
  }
  return (
    <div className="space-y-4">
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (code.trim()) location.href = `/r/${code.trim().toLowerCase()}`; }}>
        <input className="input" placeholder="Buscar por código (PY-2026-000123)" value={code} onChange={(e) => setCode(e.target.value)} aria-label="Código de seguimiento" />
        <button className="btn-primary">Buscar</button>
      </form>
      {queue.length > 0 && (
        <div className="space-y-3 rounded-xl bg-warning-soft p-3 text-sm text-warning">
          <p className="font-semibold">{queue.length === 1 ? "1 reporte sin terminar de enviar" : `${queue.length} reportes sin terminar de enviar`}</p>
          <ul className="space-y-2">
            {queue.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-semibold">{i.data.title}</p>
                  <p>{queueStatus(i)}</p>
                </div>
                {/* Descartar siempre está: un ítem que no termina de salir no tiene que quedar para siempre. */}
                <div className="flex shrink-0 gap-2">
                  {i.status === "failed" && <button className="chip bg-brand-600 text-white" onClick={() => retryOutbox([i.id!])}>Reintentar</button>}
                  <button className="chip bg-surface ring-1 ring-line" onClick={() => discardOutbox(i.id!)}>{i.created ? "Dejar sin fotos" : "Descartar"}</button>
                </div>
              </li>
            ))}
          </ul>
          {waitingCaptcha.length > 0 && (
            loggedIn || !turnstileSiteKey ? (
              <button className="btn-primary w-full py-2" onClick={() => retryOutbox(waitingCaptcha)}>Enviar ahora</button>
            ) : captcha.stalled ? (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p>No se pudo enviar. Probá de nuevo en un rato.</p>
                <button className="chip bg-brand-600 text-white" onClick={() => setCaptcha((c) => ({ ...c, stalled: false }))}>Reintentar</button>
              </div>
            ) : (
              <Turnstile key={captcha.round} siteKey={turnstileSiteKey} onToken={sendWithCaptcha} />
            )
          )}
        </div>
      )}
      {items.length === 0 ? (
        <p className="text-fg-subtle">Todavía no hiciste reportes desde este dispositivo.</p>
      ) : (
        <ul className="card divide-y divide-line">
          {items.map((r) => (
            <li key={r.id}>
              <a href={r.path} className="block p-4 hover:bg-surface-2">
                <p className="font-semibold">{r.title}</p>
                <p className="text-sm text-fg-subtle"><span className="font-mono">{r.code}</span> · {timeAgo(r.created_at)}</p>
                {!!r.photos_missing && (
                  <p className="text-sm text-warning">
                    {r.photos_missing === 1
                      ? "No pudimos subir una foto. Podés agregarla desde el reporte."
                      : `No pudimos subir ${r.photos_missing} fotos. Podés agregarlas desde el reporte.`}
                  </p>
                )}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
