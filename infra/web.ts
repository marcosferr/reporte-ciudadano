import { createAuth } from "./auth";
import { edgeSecret, internalSecrets, turnstileSecret } from "./secrets";
import { mediaPermissions, type createStorage } from "./storage";

export const DOMAIN = "ciudadano.tereredev.com";

/**
 * CloudFront (Router) delante de todo:
 *   /media/*  → bucket (fotos públicas difuminadas)
 *   /*        → Astro SSR en Lambda (páginas, API y tiles MVT)
 *
 * El DNS está en Hostinger, así que el certificado ACM se valida a mano y se pasa con CERT_ARN.
 */
export function createWeb(opts: {
  media: ReturnType<typeof createStorage>["media"];
  db: sst.Linkable<any> | sst.aws.Postgres;
  vpc: { privateSubnets: $util.Input<string>[]; securityGroups: $util.Input<string>[] } | undefined;
}) {
  const certArn = process.env.CERT_ARN;
  const useDomain = $app.stage === "production" && !!certArn;

  const router = new sst.aws.Router("Router", {
    domain: useDomain ? { name: DOMAIN, dns: false, cert: certArn } : undefined,
    edge: {
      viewerRequest: {
        // La IP real del visitante (no falsificable, a diferencia de X-Forwarded-For) y la prueba de que el
        // pedido pasó por CloudFront. Pisan cualquier valor que mande el cliente con esos nombres.
        injection: $interpolate`event.request.headers["x-rc-viewer-ip"] = { value: event.viewer.ip };
  event.request.headers["x-rc-edge"] = { value: "${edgeSecret.result}" };`,
      },
    },
  });
  router.routeBucket("/media", opts.media, { rewrite: { regex: "^/media/(.*)$", to: "/public/$1" } });

  const siteUrl = useDomain ? `https://${DOMAIN}` : router.url;

  // SES: se habilita con SES_ENABLED=1 una vez cargados en Hostinger los registros de verificación/DKIM
  // (el deploy espera a que el dominio esté verificado). Sin SES los avisos quedan en los logs y los
  // correos de cuenta salen del remitente de Cognito.
  const email = $app.stage === "production" && process.env.SES_ENABLED === "1"
    ? new sst.aws.Email("Email", { sender: DOMAIN, dns: false })
    : undefined;
  const auth = createAuth(siteUrl, email);

  const web = new sst.aws.Astro("Web", {
    path: "packages/web",
    router: { instance: router },
    link: [opts.db, auth.userPool, auth.client, turnstileSecret, internalSecrets, ...(email ? [email] : [])],
    permissions: [
      ...mediaPermissions(opts.media, [
        // Firma las subidas del navegador a uploads/.
        { actions: ["s3:PutObject"], prefixes: ["uploads/"] },
        // Moderación: aprobar, rechazar, ocultar y republicar mueven o borran versiones procesadas.
        { actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], prefixes: ["review/", "public/", "withheld/"] },
      ]),
      {
        actions: ["cloudfront:CreateInvalidation"],
        resources: [$interpolate`arn:aws:cloudfront::${aws.getCallerIdentityOutput({}).accountId}:distribution/${router.distributionID}`],
      },
    ],
    vpc: opts.vpc,
    environment: {
      SITE_URL: siteUrl,
      COGNITO_HOSTED_UI: auth.hostedUi,
      GOOGLE_LOGIN: auth.googleEnabled ? "1" : "",
      MEDIA_BUCKET: opts.media.name,
      CDN_DISTRIBUTION_ID: router.distributionID,
      PUBLIC_TURNSTILE_SITE_KEY: process.env.PUBLIC_TURNSTILE_SITE_KEY ?? "",
      MAIL_FROM: email ? `Reporte Ciudadano <avisos@${DOMAIN}>` : "",
    },
    server: {
      memory: "1024 MB",
      architecture: "arm64",
      timeout: "20 seconds",
    },
  });

  return { router, web, auth, siteUrl };
}
