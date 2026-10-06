const rtf = new Intl.RelativeTimeFormat("es", { numeric: "auto" });
const dtf = new Intl.DateTimeFormat("es-PY", { day: "numeric", month: "short", year: "numeric", timeZone: "America/Asuncion" });
const dttf = new Intl.DateTimeFormat("es-PY", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "America/Asuncion" });

export function timeAgo(d: Date | string): string {
  const diff = (new Date(d).getTime() - Date.now()) / 1000;
  const units: [Intl.RelativeTimeFormatUnit, number][] = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];
  for (const [u, s] of units) if (Math.abs(diff) >= s) return rtf.format(Math.round(diff / s), u);
  return "recién";
}

export const formatDate = (d: Date | string) => dtf.format(new Date(d));
export const formatDateTime = (d: Date | string) => dttf.format(new Date(d));
export const formatNumber = (n: number) => new Intl.NumberFormat("es-PY").format(n);
export const pct = (n: number) => `${Math.round(n * 100)}%`;

/**
 * JSON para incrustar dentro de un <script> (p. ej. JSON-LD). JSON.stringify no escapa "<", así que un
 * título con "</script>" cerraría la etiqueta y ejecutaría lo que sigue.
 */
export function safeJson(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** URL de una foto para el staff: la pública si está en public/, si no la del endpoint que exige permisos. */
export function staffPhotoUrl(p: { id: string; s3_key_public: string | null }, thumb = false): string | null {
  if (!p.s3_key_public) return null;
  if (p.s3_key_public.startsWith("public/")) {
    const key = thumb ? p.s3_key_public.replace(/\.jpg$/, "_t.jpg") : p.s3_key_public;
    return `/media/${key.slice("public/".length)}`;
  }
  return `/api/admin/photos/${p.id}/image${thumb ? "?thumb=1" : ""}`;
}
