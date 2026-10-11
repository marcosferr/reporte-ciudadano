// Reportes hechos desde este dispositivo (sin cuenta). El token permite agregar fotos luego.
export interface MyReport {
  id: string;
  code: string;
  path: string;
  title: string;
  token?: string;
  created_at: string;
  /** Fotos que no se pudieron subir (sin lugar en el reporte); se pueden agregar desde la página del reporte. */
  photos_missing?: number;
}

const KEY = "rc:my-reports";

export function getMyReports(): MyReport[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function saveMyReport(r: MyReport) {
  try {
    const list = getMyReports().filter((x) => x.id !== r.id);
    localStorage.setItem(KEY, JSON.stringify([r, ...list].slice(0, 200)));
  } catch {
    /* almacenamiento no disponible */
  }
}

export function setMissingPhotos(id: string, count: number) {
  const r = getMyReports().find((x) => x.id === id);
  if (r) saveMyReport({ ...r, photos_missing: count || undefined });
}
