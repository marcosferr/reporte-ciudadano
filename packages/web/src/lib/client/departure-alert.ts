/**
 * El aviso de "Salí ya", todo local: notificación del propio teléfono, vibración y un sonido en la página. No hay push:
 * para eso el servidor tendría que saber a qué hora sale cada uno. Por eso solo funciona con la página abierta
 * (o recién pasada a segundo plano), y mantiene la pantalla prendida mientras espera.
 */

export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export async function requestNotifications(): Promise<NotificationPermission | "unsupported"> {
  if (!notificationsSupported()) return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  return Notification.requestPermission();
}

/** Dos pitidos cortos con Web Audio (no hace falta ningún archivo). */
function beep() {
  try {
    const ctx = new AudioContext();
    for (const at of [0, 0.35]) {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.2, ctx.currentTime + at);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + at + 0.25);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + at);
      osc.stop(ctx.currentTime + at + 0.25);
    }
    setTimeout(() => ctx.close(), 1000);
  } catch {
    /* sin audio */
  }
}

/** Avisa por todos los medios disponibles. `true` si se pudo mostrar la notificación. */
export async function alertNow({ title, body, tag }: { title: string; body: string; tag: string }): Promise<boolean> {
  navigator.vibrate?.([300, 150, 300]);
  beep();
  if (!notificationsSupported() || Notification.permission !== "granted") return false;
  try {
    // Con el service worker la notificación sigue aunque se cierre la pestaña, y tocarla vuelve a esta página.
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) await reg.showNotification(title, { body, tag, icon: "/icon-192.png", badge: "/icon-192.png", data: { url: "/cuando-salgo" } });
    else new Notification(title, { body, tag, icon: "/icon-192.png" });
    return true;
  } catch {
    return false;
  }
}

let lock: WakeLockSentinel | null = null;
let wanted = false;

/** Pantalla prendida mientras espera para avisar. El navegador la suelta al ocultar la página; hay que volver a pedirla. */
export async function keepScreenOn(on: boolean): Promise<void> {
  wanted = on;
  try {
    if (!on) {
      await lock?.release();
      lock = null;
      return;
    }
    if (lock && !lock.released) return;
    const got = (await navigator.wakeLock?.request("screen")) ?? null;
    // Se desarmó mientras el navegador concedía el pedido (p. ej. avisó enseguida): se suelta ya.
    if (!wanted) await got?.release();
    else lock = got;
  } catch {
    lock = null;
  }
}
