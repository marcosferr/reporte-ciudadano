# Entorno de desarrollo

Cómo levantar Reporte Ciudadano en tu máquina, correr los tests y trabajar contra AWS cuando haga falta.

## Requisitos

| Herramienta | Versión | Para qué |
|---|---|---|
| Node.js | 24 (ver `.nvmrc`) | todo el monorepo |
| pnpm | 11 (fijado en `packageManager`) | dependencias y scripts |
| Docker | cualquiera reciente | PostGIS local |
| AWS CLI v2 | opcional | solo para `sst dev` o desplegar |

Con [Corepack](https://nodejs.org/api/corepack.html) no hace falta instalar pnpm a mano: `corepack enable` usa la versión fijada en `package.json`.

## Modos de trabajo

Hay dos formas de correr el proyecto. La mayoría de los cambios se hacen con la primera.

| | Local puro | `sst dev` |
|---|---|---|
| Necesita cuenta AWS | No | Sí |
| Base de datos | PostGIS en Docker | PostGIS en Docker (la misma) |
| Login | `DEV_LOGIN=1` (usuario de prueba) | Cognito real |
| Subida de fotos | Desactivada | S3 + moderación con Rekognition |
| Correos | Avisos en la consola | Avisos en la consola; los de cuenta salen de Cognito |
| Costo | Cero | Centavos por uso en tu stage personal |

## Local puro (recomendado)

### 1. Instalar dependencias

```bash
pnpm install
```

### 2. Levantar la base

```bash
pnpm db:up
```

Arranca `postgis/postgis:16-3.4` en **localhost:5433** (usuario `postgres`, contraseña `password`, base `reporte`). El puerto 5433 evita choques con un Postgres que ya tengas en el 5432. Los datos persisten en el volumen `pgdata`.

> En Mac con Apple Silicon la imagen corre emulada (`platform: linux/amd64`), así que el primer arranque tarda un poco más.

### 3. Migrar y cargar datos

```bash
pnpm db:migrate
pnpm db:seed -- --demo
pnpm db:bus-routes
```

- `db:migrate` aplica en orden los `.sql` de `packages/core/migrations/` que aún no corrieron (se registran en `schema_migrations`).
- `db:seed` descarga de geoBoundaries los 17 departamentos + Asunción y sus distritos (necesita internet). Con `--demo` agrega reportes de ejemplo en Asunción, San Lorenzo, Encarnación y Ciudad del Este.
- `db:bus-routes` trae del prototipo del VMT los recorridos de los colectivos (tarda unos segundos). En AWS los actualiza una vez por día la Lambda `BusRoutesSync`, y `VmtCollector` guarda además el histórico de posiciones ([HISTORICO_VMT.md](HISTORICO_VMT.md)); en local no corre.

### 4. Correr la web

```bash
cd packages/web
DATABASE_URL=postgres://postgres:password@localhost:5433/reporte DEV_LOGIN=1 pnpm dev
```

Abrí http://localhost:4321.

**Entrar con un usuario de prueba**: con `DEV_LOGIN=1`, visitá `/auth/dev?as=admin` (admin) o `/auth/dev?as=vecino` (ciudadano común). Podés agregar `&next=/admin` para volver a una página. Esta ruta solo funciona fuera de Lambda; en producción no existe aunque alguien defina la variable.

**Limitaciones del modo local**: sin bucket no se suben fotos (el reporte se crea igual, sin imágenes), no hay captcha y los avisos por correo se escriben en la consola.

## Contra AWS con `sst dev`

Para probar fotos, moderación o el login real necesitás credenciales de AWS.

```bash
pnpm db:up                   # sst dev también usa la base local
AWS_PROFILE=<tu-perfil> pnpm dev
```

`sst dev` crea en tu **stage personal** (tu usuario del sistema) el bucket, la Lambda de moderación y el pool de Cognito, y corre Astro y las Lambdas en tu máquina con hot reload. No crea VPC ni RDS (ver `sst.config.ts`), así que el costo es prácticamente cero.

Cuando termines, borrá el stage para no dejar recursos:

```bash
AWS_PROFILE=<tu-perfil> npx sst remove
```

Si tu perfil usa `aws login` (sesiones `login_session`), SST todavía no lo soporta: mirá el perfil puente en [DESPLIEGUE.md](DESPLIEGUE.md#credenciales).

## Variables de entorno

En desarrollo local solo importan estas:

| Variable | Dónde | Valor local |
|---|---|---|
| `DATABASE_URL` | web, scripts, tests | `postgres://postgres:password@localhost:5433/reporte` |
| `DEV_LOGIN` | web | `1` para habilitar `/auth/dev` |
| `TEST_ADMIN_URL` | tests de `core` | por defecto `postgres://postgres:password@localhost:5433/postgres` |
| `SITE_URL` | web | por defecto `http://localhost:4321` |

Las variables de despliegue (`CERT_ARN`, `ALERT_EMAIL`, Turnstile, Google) están en `.env.example` y se explican en [DESPLIEGUE.md](DESPLIEGUE.md). **Nunca subas `.env`**: ya está en `.gitignore`.

## Scripts

Desde la raíz:

| Comando | Qué hace |
|---|---|
| `pnpm db:up` | Levanta PostGIS en Docker |
| `pnpm db:migrate` | Aplica migraciones pendientes |
| `pnpm db:seed [-- --demo]` | Carga áreas administrativas (y reportes de ejemplo) |
| `pnpm db:bus-routes` | Carga los recorridos de los colectivos desde el VMT |
| `pnpm --filter @rc/core backtest:prepare <csv>` | Prepara el histórico del billetaje para el backtesting de ¿Cuándo salgo? |
| `pnpm --filter @rc/core backtest:run` | Corre el backtesting y deja un reporte en `data/backtest/` |
| `pnpm test` | Tests de dominio y GIS (`packages/core`) contra PostGIS |
| `pnpm --filter @rc/functions test` | Tests de las Lambdas (imágenes, correos) |
| `pnpm --filter @rc/web test` | Tests de la web (respuestas a través del adaptador de Lambda) |
| `pnpm typecheck` | `tsc` en core y functions, `astro check` en web |
| `pnpm dev` | `sst dev` (necesita AWS) |
| `pnpm run deploy` | Despliega a producción (ver DESPLIEGUE.md) |

En `packages/web`: `pnpm dev`, `pnpm build`, `pnpm preview`.

## Tests

```bash
pnpm db:up
pnpm test                            # core: 19 tests, ~4 s
pnpm --filter @rc/functions test     # functions: sin base, < 1 s
pnpm --filter @rc/web test           # web: sin base, < 1 s
pnpm typecheck
```

Los tests de `core` crean y destruyen una base `reporte_test` en el mismo servidor, así que **no tocan tus datos de desarrollo**. Corren en serie (`fileParallelism: false`) porque comparten esa base.

Qué cubren:

- **core**: creación de reportes y asignación automática de departamento/distrito, transiciones de estado, duplicados cercanos, confirmaciones y denuncias, tiles MVT, estadísticas y consultas por polígono, reserva de fotos, rate limiting.
- **functions**: decisión de moderación según etiquetas de Rekognition, difuminado de caras, y que los correos de Cognito incluyan el código, escapen datos y no pasen el límite de 20.000 caracteres.
- **web**: que los tiles MVT lleguen intactos a través del adaptador de Lambda (`astro-sst` solo codifica en base64 los tipos que reconoce como binarios; el resto lo manda como texto y corrompe los bytes).

El CI corre exactamente estos cuatro comandos en cada pull request.

## Backtesting de ¿Cuándo salgo?

El cálculo de `/cuando-salgo` (`packages/core/src/departure.ts`) se prueba contra lo que pasó de verdad: se simula a alguien que abre la app en una parada a cierta hora, con las posiciones que se conocían hasta ese momento, y se compara con cuándo pasó cada bus. Las constantes de `CFG` salen de acá.

Todo queda en `data/backtest/` (en `.gitignore`). **No subas esos datos a ningún lado.**

Hace falta el catálogo de recorridos en la base local (`pnpm db:migrate && pnpm db:bus-routes`); la primera corrida lo guarda en `data/backtest/catalog.json`.

**Con nuestro histórico del VMT** (una posición por minuto desde que corre `VmtCollector`, ver [HISTORICO_VMT.md](HISTORICO_VMT.md)):

```bash
aws s3 sync s3://<bucket Media>/vmt/positions/ data/backtest/vmt/ --exclude "*" --include "date=2026-10-1*"
pnpm --filter @rc/core backtest:run -- --source vmt --days 7 --stops 60
```

**Con el billetaje electrónico del VMT** (enero de 2022 a marzo de 2023, los "8 CDs" que reúne [monda-guasu](https://github.com/luchobenitez/monda-guasu)). Cada validación es un bus detenido en una parada real, así que sirve para probar en paradas donde de verdad sube gente:

1. Bajá a mano uno o dos meses de CSV de la carpeta de Drive a `data/backtest/raw/`.
2. Preparalos. **Cada fila trae `serialtarjeta`, el hash de la tarjeta de un pasajero**: el script lo descarta al leer, junto con el monto y el producto, y solo guarda validador, hora, lugar y recorrido.

   ```bash
   pnpm --filter @rc/core backtest:prepare data/backtest/raw/*.csv
   rm -r data/backtest/raw       # los CSV crudos no hacen falta más
   ```

3. Corré el backtesting:

   ```bash
   pnpm --filter @rc/core backtest:run -- --source billetaje --days 7 --stops 40
   ```

La simulación corre el mismo código que el teléfono, con la página abierta (una consulta cada 10 s, `--poll`), y solo compara llegadas que los datos alcanzan a cubrir (si no, quedarían solo los buses rápidos). El reporte (`data/backtest/report-*.md`) trae:

- el error de la llegada estimada según cuánto faltaba;
- cuántas veces el bus pasó dentro del rango y cuántas antes de lo más temprano;
- **qué porcentaje de colectivos se pierde siguiendo el consejo** (meta: menos del 5 %), saliendo cuando suena el aviso o mirando una sola vez;
- los `FACTORS` y la velocidad comercial (`DEFAULT_KMH`) sugeridos.

Si cambiás `CFG`, poné el reporte en la descripción del PR. Con pocos datos (una hora) las caminatas largas casi no se pueden evaluar: lo más tarde estimado cae fuera de los datos.

Para juntar una muestra del VMT sin AWS se puede correr `collectBuses` y `DayCompactor` de `@rc/core/vmt-history` en un loop (una consulta cada 30 s) y guardar el Parquet en `data/backtest/vmt/date=AAAA-MM-DD/positions.parquet`.

## Migraciones

Las migraciones son SQL plano en `packages/core/migrations/`, numeradas: `0005_lo_que_sea.sql`.

- **Nunca edites una migración ya mergeada**: producción la registró como aplicada y no la va a volver a correr. Creá una nueva.
- Cada archivo corre dentro de una transacción. Si falla, no queda a medias.
- En producción las aplica la Lambda `DatabaseMigrator` en cada deploy, con un lock para que dos deploys no migren a la vez.
- Para empezar de cero en local: `docker compose down -v && pnpm db:up && pnpm db:migrate && pnpm db:seed -- --demo`.

## Explorar la base

```bash
docker compose exec db psql -U postgres reporte
```

O conectá QGIS / DBeaver a `localhost:5433`. Las tablas principales están descritas en [ARQUITECTURA.md](ARQUITECTURA.md#modelo-de-datos).

## Problemas frecuentes

**`ECONNREFUSED 127.0.0.1:5433`**: la base no está levantada. `pnpm db:up` y esperá unos segundos.

**`relation "reports" does not exist`**: faltan migraciones. `pnpm db:migrate`.

**El mapa no muestra departamentos ni distritos**: faltó `pnpm db:seed`.

**`pnpm install` se queja de builds bloqueados**: pnpm 11 solo ejecuta scripts de instalación de los paquetes listados en `allowBuilds` (`pnpm-workspace.yaml`). Si sumás una dependencia que los necesita, agregala ahí.

**`sst dev` falla con error de credenciales**: revisá `AWS_PROFILE`; si usás `aws login`, necesitás el perfil puente.

**Cambié el esquema y los tests fallan raro**: los tests recrean `reporte_test` desde cero, pero tu base de desarrollo no; migrala con `pnpm db:migrate`.
