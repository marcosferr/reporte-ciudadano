/** Textos de colectivos y paradas, compartidos por el mapa y ¿Cuándo salgo?. */
import { formatNumber } from "../format";

// El VMT escribe los lugares en mayúsculas ("LAMBARÉ").
export function capitalize(s: string): string {
  return s.toLowerCase().replace(/(^|[\s(-])\p{L}/gu, (m) => m.toUpperCase());
}

// Tipos de sociedad que van en mayúsculas ("La Lomita SA", "Vanguardia SACI").
const LEGAL = /\b(Sa|Srl|Saci|Satc|Cisa|Sae|Saeca)\b\.?$/;

/** "LA LOMITA SA" → "La Lomita SA". */
export function companyName(s: string): string {
  return capitalize(s).replace(LEGAL, (m) => m.toUpperCase());
}

const CARDINALS = ["norte", "noreste", "este", "sureste", "sur", "suroeste", "oeste", "noroeste"];

/** "hacia el norte", para un rumbo en grados. */
export const cardinal = (bearing: number) => CARDINALS[Math.round((((bearing % 360) + 360) % 360) / 45) % 8];

/** "650 m", "2,3 km". */
export function distance(m: number): string {
  return m < 1000 ? `${formatNumber(Math.round(m / 10) * 10)} m` : `${formatNumber(Math.round(m / 100) / 10)} km`;
}

/** "9–14 min", "1 min", "ya". */
export function minutesRange(fromMs: number, toMs: number): string {
  const a = Math.max(0, Math.round(fromMs / 60_000)), b = Math.max(a, Math.round(toMs / 60_000));
  if (b === 0) return "ya";
  return a === b ? `${a} min` : `${a}–${b} min`;
}

/** El número de la línea, sin el ramal ("41 - 1" → "41"). */
export const lineNumber = (line: string | null) => line?.split(/\s*-\s*/)[0] ?? null;
