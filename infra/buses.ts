import { mediaPermissions, type createStorage } from "./storage";

type Vpc = { privateSubnets: $util.Input<string>[]; securityGroups: $util.Input<string>[] };

/**
 * Colectivos del VMT: recorridos para el mapa y el histórico para medir su disponibilidad (ver
 * packages/core/src/vmt-history.ts). Las tres Lambdas salen al VMT por la NAT y llegan a S3 por el endpoint.
 * El primer deploy carga los recorridos con el migrador (infra/database.ts), así el mapa no espera a la primera corrida.
 * En `sst dev` no se crean: la base local se carga con `pnpm db:bus-routes`.
 */
export function createBuses(media: ReturnType<typeof createStorage>["media"], db: sst.Linkable<any> | sst.aws.Postgres, vpc: Vpc) {
  const common = { link: [db], vpc, architecture: "arm64" as const, environment: { MEDIA_BUCKET: media.name } };

  new sst.aws.Cron("BusRoutesSync", {
    // 03:00 de Paraguay (UTC-3), con pocos buses en la calle: pedir los recorridos de todas las empresas es pesado
    // para el prototipo del VMT. Con `rate(1 day)` corría a la hora del último deploy.
    schedule: "cron(0 6 * * ? *)",
    function: {
      ...common,
      handler: "packages/functions/src/bus-routes.handler",
      // Se piden de a 4 empresas y el VMT tarda hasta un minuto en algunas; corta antes de este límite.
      timeout: "15 minutes",
      memory: "512 MB",
      // Si no llegó ningún recorrido, reintentar enseguida suele fallar igual: queda para el día siguiente.
      retries: 0,
      permissions: mediaPermissions(media, [{ actions: ["s3:PutObject"], prefixes: ["vmt/raw/itineraries/"] }]),
    },
  });

  new sst.aws.Cron("VmtCollector", {
    schedule: "rate(1 minute)",
    function: {
      ...common,
      handler: "packages/functions/src/vmt-collector.handler",
      timeout: "60 seconds",
      memory: "256 MB",
      // La consulta del minuto siguiente reemplaza a un reintento.
      retries: 0,
      permissions: mediaPermissions(media, [{ actions: ["s3:PutObject"], prefixes: ["vmt/raw/buses/"] }]),
    },
  });

  new sst.aws.Cron("VmtCompactor", {
    // 04:00 de Paraguay (UTC-3): compacta el día anterior.
    schedule: "cron(0 7 * * ? *)",
    function: {
      ...common,
      handler: "packages/functions/src/vmt-compactor.handler",
      timeout: "10 minutes",
      // Un día son ~1440 consultas y del orden de cientos de miles de reportes en memoria.
      memory: "2048 MB",
      permissions: [
        ...mediaPermissions(media, [
          { actions: ["s3:GetObject"], prefixes: ["vmt/raw/buses/"] },
          { actions: ["s3:PutObject"], prefixes: ["vmt/positions/"] },
        ]),
        {
          actions: ["s3:ListBucket"],
          resources: [media.arn],
          conditions: [{ test: "StringLike", variable: "s3:prefix", values: ["vmt/raw/buses/*"] }],
        },
      ],
    },
  });
}
