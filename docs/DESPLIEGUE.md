# Despliegue y operación

Cómo desplegar Reporte Ciudadano a AWS y operar producción. Solo lo necesitan quienes mantienen la instancia de https://ciudadano.tereredev.com o quieren montar la suya.

> Para desplegar tu propia instancia con otro dominio, cambiá `DOMAIN` en `infra/web.ts` y los textos que mencionan `ciudadano.tereredev.com`.

## Credenciales

Los comandos de SST usan `AWS_PROFILE`. Si tu perfil usa `aws login` (sesiones `login_session`), SST todavía no lo soporta; definí en `~/.aws/config` un perfil puente que reutiliza esa sesión:

```ini
[profile <perfil>-sst]
credential_process = aws configure export-credentials --profile <perfil> --format process
region = us-east-1
```

y corré todo con `AWS_PROFILE=<perfil>-sst`. En CI se usan las credenciales del entorno (`AWS_ACCESS_KEY_ID`), ver `sst.config.ts`.

## Primer despliegue

El DNS de `tereredev.com` está en Hostinger (no en Route 53), así que el certificado y los CNAME se cargan a mano.

### 1. Certificado ACM

```bash
aws acm request-certificate --domain-name ciudadano.tereredev.com \
  --validation-method DNS --region us-east-1
aws acm describe-certificate --certificate-arn <ARN> --region us-east-1 \
  --query 'Certificate.DomainValidationOptions[0].ResourceRecord'
```

Cargá ese CNAME en el DNS y esperá a que el estado sea `ISSUED`. Tiene que estar en `us-east-1` porque lo usa CloudFront.

### 2. Variables

Copiá `.env.example` a `.env` y completá:

| Variable | Obligatoria | Para qué |
|---|---|---|
| `CERT_ARN` | Sí (para el dominio) | Certificado del paso 1. Sin él se publica solo en el dominio de CloudFront |
| `ALERT_EMAIL` | Recomendada | Alerta de presupuesto a USD 30/mes |
| `PUBLIC_TURNSTILE_SITE_KEY` | No | Captcha para reportes anónimos |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | No | Login con Google |
| `SES_ENABLED` | No | `1` cuando el dominio esté verificado en SES (paso 7) |

### 3. Secretos

```bash
npx sst secret set TurnstileSecret <secreto> --stage production
```

Sin secreto el captcha queda desactivado.

### 4. Deploy

```bash
pnpm run deploy        # sst deploy --stage production
```

El migrador aplica las migraciones y, en el primer deploy, carga departamentos y distritos (los descarga de geoBoundaries a través del NAT).

Salidas:

| Salida | Uso |
|---|---|
| `url` | URL pública |
| `cloudfront` | destino del CNAME del dominio |
| `hostedUi` | dominio de Cognito para configurar Google |
| `natInstance` | ID de la instancia para el túnel SSM |

### 5. DNS

CNAME `ciudadano` → el dominio de CloudFront de la salida `cloudfront`.

### 6. Primer admin

Registrate en el sitio y después:

```bash
aws cognito-idp admin-add-user-to-group --region us-east-1 \
  --user-pool-id <id del pool> --username <tu correo> --group-name admin
```

Para moderadores, igual con `--group-name moderador`.

### 7. Correo (SES)

```bash
aws sesv2 get-email-identity --email-identity ciudadano.tereredev.com
```

Cargá los 3 CNAME de DKIM en el DNS, pedí salir del sandbox de SES desde la consola y redesplegá con `SES_ENABLED=1`. Hasta entonces los avisos quedan en los logs y los correos de cuenta salen del remitente de Cognito (límite de 50 por día).

### 8. Google Search Console

Verificá el dominio y enviá `https://ciudadano.tereredev.com/sitemap.xml`.

## Despliegues siguientes

```bash
git switch main && git pull
pnpm install --frozen-lockfile
pnpm typecheck && pnpm test
AWS_PROFILE=<perfil> pnpm run deploy
```

Despliegá solo desde `main` actualizado. Las migraciones nuevas se aplican solas al principio del deploy.

## Acceso a la base (QGIS / psql)

La base no es pública. La instancia NAT funciona como bastión vía SSM:

```bash
aws ssm start-session --target <natInstance> \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters host=<host RDS>,portNumber=5432,localPortNumber=5434
```

Conectá QGIS o psql a `localhost:5434`. Host y credenciales: `npx sst shell --stage production` (variables `SST_RESOURCE_Database`).

Tratá esa conexión como producción: preferí consultas de solo lectura y nunca compartas los datos personales (`reporter_user_id`, correos de `subscriptions`).

## Operación

**Logs**: `npx sst console` o CloudWatch, grupos `/aws/lambda/reporte-ciudadano-production-*`.

**Fotos en revisión**: `/admin/moderacion` lista las fotos con `status = review` y los reportes ocultos por denuncias.

**Backups**: RDS guarda snapshots automáticos 7 días. Antes de una migración riesgosa, sacá uno manual:

```bash
aws rds create-db-snapshot --db-instance-identifier <id> --db-snapshot-identifier pre-<migracion>
```

**Rollback**: volvé `main` al commit anterior y redesplegá. Las migraciones no tienen "down": si una migración rompió algo, corregila con una migración nueva o restaurá el snapshot.

**Histórico de colectivos**: `VmtCollector` corre cada minuto y `VmtCompactor` a las 04:00. Para volver a compactar un día, invocá `VmtCompactor` con `{"date": "AAAA-MM-DD"}`. Detalle y consultas en [HISTORICO_VMT.md](HISTORICO_VMT.md).

**El NAT se cayó**: la web sigue sirviendo (CloudFront → Lambda → RDS no pasa por el NAT) pero fallan las llamadas salientes (Cognito, Rekognition, SES, Turnstile). Reiniciá la instancia desde EC2.

## Borrar un stage

```bash
npx sst remove --stage <stage>
```

En `production` los recursos están protegidos y retenidos; borrarlos requiere desactivar `protect` en `sst.config.ts` a propósito.
