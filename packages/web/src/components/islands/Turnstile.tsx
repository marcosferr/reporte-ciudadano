import { useEffect, useRef } from "react";
import { resolvedTheme } from "../../lib/client/theme";

declare global {
  interface Window { turnstile?: any }
}

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/** Captcha de Cloudflare Turnstile. Llama a `onToken` con un token de un solo uso. */
export default function Turnstile({ siteKey, onToken }: { siteKey: string; onToken: (t: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // El widget se dibuja una vez: el callback lee siempre el `onToken` del último render.
  const tokenRef = useRef(onToken);
  tokenRef.current = onToken;
  useEffect(() => {
    let widget: string | undefined;
    const render = () => {
      if (widget !== undefined || !window.turnstile || !ref.current) return;
      widget = window.turnstile.render(ref.current, {
        sitekey: siteKey, callback: (t: string) => tokenRef.current(t), language: "es", appearance: "interaction-only", theme: resolvedTheme(),
      });
    };
    const load = () => {
      if (window.turnstile) return render();
      const loading = document.querySelector(`script[src="${SCRIPT_SRC}"]`);
      if (loading) return loading.addEventListener("load", render);
      const s = document.createElement("script");
      s.src = SCRIPT_SRC;
      s.async = true;
      s.onload = render;
      s.onerror = () => s.remove();
      document.head.append(s);
    };
    // Sin conexión el script no carga: se vuelve a pedir cuando vuelve la señal (si no, el botón de publicar
    // quedaba deshabilitado y recargar perdía el formulario).
    load();
    window.addEventListener("online", load);
    return () => {
      window.removeEventListener("online", load);
      if (widget !== undefined) window.turnstile?.remove(widget);
    };
  }, []);
  return <div ref={ref} />;
}
