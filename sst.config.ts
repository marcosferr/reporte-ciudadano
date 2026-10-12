/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "reporte-ciudadano",
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: input?.stage === "production",
      home: "aws",
      providers: {
        // Perfil de AWS_PROFILE (p. ej. marcos-sst, ver README) o "marcos"; en CI se usan las credenciales del entorno.
        aws: { region: "us-east-1", profile: process.env.CI || process.env.AWS_ACCESS_KEY_ID ? undefined : (process.env.AWS_PROFILE ?? "marcos") },
        random: "4.18.0",
      },
    };
  },
  async run() {
    const { createVpc } = await import("./infra/vpc");
    const { createDatabase } = await import("./infra/database");
    const { createStorage } = await import("./infra/storage");
    const { createModeration } = await import("./infra/moderation");
    const { createWeb } = await import("./infra/web");
    const { createBudget } = await import("./infra/budget");
    const { createBuses } = await import("./infra/buses");

    // En `sst dev` no se crea VPC ni RDS: todo corre contra Postgres local.
    const vpc = $dev ? undefined : createVpc();
    const lambdaVpc = vpc && { privateSubnets: vpc.privateSubnets, securityGroups: vpc.securityGroups };
    const db = createDatabase(vpc);
    const { media } = createStorage();
    createModeration(media, db, lambdaVpc);
    if (lambdaVpc) createBuses(media, db, lambdaVpc);
    const { router, auth, siteUrl } = createWeb({ media, db, vpc: lambdaVpc });
    if ($app.stage === "production") createBudget(30);

    return {
      url: siteUrl,
      cloudfront: router.url,
      hostedUi: auth.hostedUi,
      natInstance: vpc?.natInstanceId,
    };
  },
});
