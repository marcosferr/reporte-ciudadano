import { mediaPermissions, type createStorage } from "./storage";

/** Procesa cada foto subida: detecta caras y contenido inapropiado, difumina y publica. */
export function createModeration(
  media: ReturnType<typeof createStorage>["media"],
  db: sst.Linkable<any> | sst.aws.Postgres,
  vpc: { privateSubnets: $util.Input<string>[]; securityGroups: $util.Input<string>[] } | undefined,
) {
  media.notify({
    notifications: [
      {
        name: "Moderation",
        function: {
          handler: "packages/functions/src/moderation.handler",
          // Procesa imágenes no confiables: solo puede leer originales y escribir versiones procesadas.
          link: [db],
          environment: { MEDIA_BUCKET: media.name },
          vpc,
          memory: "1536 MB",
          timeout: "60 seconds",
          nodejs: { install: ["sharp"] },
          architecture: "arm64",
          permissions: [
            { actions: ["rekognition:DetectFaces", "rekognition:DetectModerationLabels"], resources: ["*"] },
            ...mediaPermissions(media, [
              { actions: ["s3:GetObject"], prefixes: ["uploads/"] },
              { actions: ["s3:PutObject"], prefixes: ["public/", "review/"] },
            ]),
          ],
        },
        events: ["s3:ObjectCreated:*"],
        filterPrefix: "uploads/",
      },
    ],
  });
}
