/**
 * Cliente del prototipo del VMT (MOPC): empresas, posición de los colectivos y sus recorridos. No es un dato
 * abierto oficial: no tiene licencia ni garantía de que siga igual, así que todo lo que depende de su formato
 * está acá. Los buses reportan su GPS cada ~10 s.
 */
const VMT_API = "https://sistemas.mopc.gov.py/prototipo_vmt/api";
const TIMEOUT_MS = 5000;

export interface VmtCompany { cod_catalogo: number }
// `linea_label` viene vacío cuando el bus no tiene un recorrido asignado (route_id "0000").
// `punto_anterior` y los campos `*_entre_puntos` faltan cuando el VMT no tiene el reporte anterior del bus.
export interface VmtBus {
  id_bus: number; latitude: number; longitude: number; rumbo: number; velocidad: number;
  fecha_hora: string; linea_label: string | null; eot_nombre: string; route_id: string; tiene_rampa: boolean;
  rumbo_calculado?: number | null; velocidad_calculada?: number | null; distancia_entre_puntos_m?: number | null;
  punto_anterior?: { latitude: number; longitude: number; fecha_hora: string } | null;
}
// Cualquier campo de un itinerario puede venir vacío (p. ej. ruta_linea en la empresa 31).
export interface VmtItinerary {
  ruta_hex: string | null; ruta_linea: string | null; sentido: string | null; origen: string | null; destino: string | null;
  vigente?: boolean | null;
  geojson: { type: "MultiLineString"; coordinates: [number, number][][] } | { type: "LineString"; coordinates: [number, number][] } | null;
}

/** Resultado de un pedido al VMT tal como pasó: para medir su disponibilidad interesan también las fallas. */
export interface VmtResult<T> {
  /** `null` si no hubo respuesta HTTP (timeout, DNS, conexión cortada). */
  status: number | null;
  latencyMs: number;
  data?: T[];
  error?: string;
}

export async function vmtTry<T>(path: string, timeout = TIMEOUT_MS): Promise<VmtResult<T>> {
  const start = Date.now();
  let status: number | null = null;
  try {
    const res = await fetch(`${VMT_API}${path}`, { signal: AbortSignal.timeout(timeout) });
    status = res.status;
    if (!res.ok) return { status, latencyMs: Date.now() - start, error: `VMT ${path}: HTTP ${status}` };
    const body = (await res.json()) as { success: boolean; data: T[] };
    const latencyMs = Date.now() - start;
    if (!body.success || !Array.isArray(body.data)) return { status, latencyMs, error: `VMT ${path}: respuesta inesperada` };
    return { status, latencyMs, data: body.data };
  } catch (err) {
    return { status, latencyMs: Date.now() - start, error: `VMT ${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function vmt<T>(path: string, timeout = TIMEOUT_MS): Promise<T[]> {
  const r = await vmtTry<T>(path, timeout);
  if (!r.data) throw new Error(r.error);
  return r.data;
}
