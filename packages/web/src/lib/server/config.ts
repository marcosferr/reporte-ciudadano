import { Resource } from "sst";

/** Lee un recurso vinculado por SST; devuelve undefined si no existe (dev local sin AWS). */
function res<T = any>(name: string): T | undefined {
  try {
    return (Resource as any)[name] as T;
  } catch {
    return undefined;
  }
}

export const config = {
  siteUrl: (process.env.SITE_URL ?? "http://localhost:4321").replace(/\/$/, ""),
  get ipSalt(): string {
    return res<{ ipSalt: string }>("Internal")?.ipSalt ?? "dev-salt";
  },
  /**
   * Secreto que agrega la CloudFront Function. Solo cuenta dentro de Lambda: en `sst dev` y en local la web
   * atiende directo, sin CloudFront, y la IP sale de la conexión.
   */
  get edgeSecret(): string | undefined {
    if (!process.env.AWS_LAMBDA_FUNCTION_NAME) return undefined;
    return res<{ edgeSecret: string }>("Internal")?.edgeSecret || undefined;
  },
  mediaBucket: process.env.MEDIA_BUCKET || undefined,
  cdnDistributionId: process.env.CDN_DISTRIBUTION_ID || undefined,
  get cognito() {
    const pool = res<{ id: string }>("Auth");
    const client = res<{ id: string }>("AuthClient");
    const hostedUi = process.env.COGNITO_HOSTED_UI;
    return pool && client && hostedUi ? { userPoolId: pool.id, clientId: client.id, hostedUi } : undefined;
  },
  get turnstileSecret(): string {
    return res<{ value: string }>("TurnstileSecret")?.value ?? "";
  },
  turnstileSiteKey: process.env.PUBLIC_TURNSTILE_SITE_KEY ?? "",
  mailFrom: process.env.MAIL_FROM ?? "",
  /** Login con Google habilitado en Cognito (lo define infra/web.ts). */
  googleLogin: process.env.GOOGLE_LOGIN === "1",
  /** Solo para desarrollo local sin Cognito: permite entrar como admin de prueba. */
  devLogin: process.env.DEV_LOGIN === "1" && !process.env.AWS_LAMBDA_FUNCTION_NAME,
};
