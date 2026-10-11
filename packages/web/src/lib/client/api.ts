export interface NewReport {
  category: string;
  title: string;
  description: string;
  lat: number;
  lng: number;
  address?: string;
  extra: Record<string, string>;
}

export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number) {
    super(message);
  }
}

export async function api<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  // Las escrituras siempre van como JSON: el servidor rechaza otros tipos (protección CSRF).
  const isWrite = !!init?.method && !["GET", "HEAD"].includes(init.method);
  const json = init?.json ?? (isWrite ? {} : undefined);
  const res = await fetch(url, {
    ...init,
    headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...init?.headers },
    body: json !== undefined ? JSON.stringify(json) : init?.body,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data?.error?.code ?? "http", data?.error?.message ?? `Error ${res.status}`, res.status);
  return data as T;
}

export type Upload = { url: string; fields: Record<string, string> };

/** Una foto que no se va a poder subir aunque se reintente. */
export class PhotoRejected extends Error {}

/** Sube una foto a S3 con el POST prefirmado que devolvió la API. */
export async function uploadPhoto(u: Upload, photo: Blob) {
  // Un Blob guardado en IndexedDB que el navegador ya no puede leer (pasa en Safari) no se arregla reintentando.
  await photo.slice(0, 1).arrayBuffer().catch(() => {
    throw new PhotoRejected("No se pudo leer una foto");
  });
  const form = new FormData();
  for (const [k, v] of Object.entries(u.fields)) form.append(k, v);
  form.append("file", photo, "foto.jpg");
  const res = await fetch(u.url, { method: "POST", body: form });
  // S3 responde 4xx cuando la foto no cumple la política (tamaño, tipo) o el permiso no sirve.
  if (res.status >= 400 && res.status < 500) throw new PhotoRejected("No se pudo subir una foto");
  if (!res.ok) throw new Error("No se pudo subir una foto");
}

export async function uploadPhotos(uploads: Upload[], photos: Blob[], onProgress?: (done: number) => void) {
  let done = 0;
  await Promise.all(
    uploads.map(async (u, i) => {
      await uploadPhoto(u, photos[i]);
      onProgress?.(++done);
    }),
  );
  return done;
}
