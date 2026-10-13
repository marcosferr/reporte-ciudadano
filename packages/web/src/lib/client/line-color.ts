/** Color de cada línea de colectivo, igual en el mapa y en ¿Cuándo salgo?. */

export const NO_LINE_COLOR = "#495057";
// Como en Google Maps, cada línea tiene su color, y el mismo número de línea cae siempre en el mismo.
export const LINE_COLORS = ["#d6336c", "#1971c2", "#2b8a3e", "#e8590c", "#7048e8", "#0c8599", "#c2255c", "#5c940d", "#9c36b5", "#1864ab", "#d9480f", "#087f5b"];

export function lineColor(line: string | null): string {
  if (!line) return NO_LINE_COLOR;
  let h = 0;
  for (const ch of line.split(" - ")[0]) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return LINE_COLORS[h % LINE_COLORS.length];
}
