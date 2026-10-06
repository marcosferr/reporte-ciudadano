/**
 * Un solo bucket para fotos:
 *   uploads/   originales subidos por el público (privados, se borran a los 90 días)
 *   review/    versiones difuminadas que esperan a un moderador (privadas: el staff las ve con URL firmada)
 *   public/    versiones difuminadas aprobadas y miniaturas, servidas por CloudFront en /media/*
 *   withheld/  fotos de reportes ocultados por un moderador (privadas; vuelven a public/ si se republica)
 */
export function createStorage() {
  const account = aws.getCallerIdentityOutput({}).accountId;
  const media = new sst.aws.Bucket("Media", {
    access: "cloudfront",
    cors: {
      allowOrigins: ["*"],
      allowMethods: ["POST", "GET", "HEAD"],
      allowHeaders: ["*"],
      maxAge: "1 day",
    },
    lifecycle: [{ id: "expire-originals", prefix: "uploads/", expiresIn: "90 days" }],
    transform: {
      // SST da a CloudFront lectura de todo el bucket y sin condición de origen: cualquier distribución,
      // incluso de otra cuenta, podría leer los originales sin difuminar. Se limita a public/ y a esta cuenta.
      policy: (args) => {
        args.policy = $resolve([args.policy, account]).apply(([policy, accountId]) => {
          const doc = typeof policy === "string" ? JSON.parse(policy) : policy;
          for (const st of doc.Statement) {
            if (st.Principal?.Service !== "cloudfront.amazonaws.com") continue;
            st.Resource = String(st.Resource).replace(/\/\*$/, "/public/*");
            st.Condition = { StringEquals: { "AWS:SourceAccount": accountId } };
          }
          return JSON.stringify(doc);
        });
      },
    },
  });
  return { media };
}

/** Permisos mínimos sobre prefijos del bucket (en vez de `link`, que da s3:* sobre todo el bucket). */
export function mediaPermissions(
  media: ReturnType<typeof createStorage>["media"],
  rules: { actions: string[]; prefixes: string[] }[],
) {
  return rules.map((r) => ({
    actions: r.actions,
    resources: r.prefixes.map((p) => $interpolate`${media.arn}/${p}*`),
  }));
}
