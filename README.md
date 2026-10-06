# Reporte Ciudadano

Plataforma abierta para reportar y dar seguimiento a problemas urbanos de Paraguay —baches, raudales, inseguridad, vertederos ilegales, propaganda electoral fuera de fecha, alumbrado— con mapa, fotos y consultas GIS.

**Producción:** https://ciudadano.tereredev.com

[![CI](https://github.com/marcosferr/reporte-ciudadano/actions/workflows/ci.yml/badge.svg)](https://github.com/marcosferr/reporte-ciudadano/actions/workflows/ci.yml)

## Qué hace

- **Reportar sin cuenta**: categoría, ubicación en el mapa, descripción y hasta 4 fotos. Funciona sin conexión (el reporte queda en cola y se envía al volver la señal).
- **Privacidad por defecto**: las fotos pasan por moderación automática (Rekognition) que difumina caras y filtra contenido inapropiado antes de publicarse. Las IP se guardan solo como hash con sal.
- **Seguimiento**: cada reporte tiene un código público (`PY-2026-000123`), historial de estados y avisos por correo para quienes lo siguen.
- **Comunidad**: confirmar ("a mí también me pasa"), denunciar reportes falsos y detección de duplicados cercanos.
- **Datos abiertos y GIS**: estadísticas por departamento y distrito, consultas dibujando un polígono, puntos críticos y exportación en GeoJSON/CSV.
- **Panel de administración**: moderación de fotos y denuncias, cambios de estado, gestión de categorías.

## Stack

| Capa | Tecnología |
|---|---|
| Infraestructura | [SST v4](https://sst.dev) (Pulumi) en AWS `us-east-1` |
| Web | Astro 7 SSR en Lambda + islas React 19, Tailwind 4, MapLibre GL 6 |
| Base de datos | PostgreSQL 17 + PostGIS (RDS t4g.micro) |
| Archivos | S3 + CloudFront |
| Moderación | Lambda + Amazon Rekognition + sharp |
| Auth | Amazon Cognito (formularios propios, Google opcional) |
| Mapa base | [OpenFreeMap](https://openfreemap.org) (sin API key) |
| Límites administrativos | DGEEC vía [geoBoundaries](https://www.geoboundaries.org) (CC BY 4.0) |

## Inicio rápido

Requisitos: Node 24, pnpm 11, Docker.

```bash
pnpm install
pnpm db:up              # PostGIS en localhost:5433
pnpm db:migrate
pnpm db:seed -- --demo  # departamentos, distritos y reportes de ejemplo

cd packages/web
DATABASE_URL=postgres://postgres:password@localhost:5433/reporte DEV_LOGIN=1 pnpm dev
```

Abrí http://localhost:4321. Con `DEV_LOGIN=1`, entrá a http://localhost:4321/auth/dev?as=admin para usar el panel como admin de prueba.

La guía completa (variables, tests, trabajo contra AWS, problemas frecuentes) está en [docs/DESARROLLO.md](docs/DESARROLLO.md).

## Documentación

| Documento | Para qué |
|---|---|
| [docs/DESARROLLO.md](docs/DESARROLLO.md) | Preparar el entorno local, correr tests, scripts disponibles |
| [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md) | Cómo encajan las piezas: infraestructura, datos, flujos y decisiones |
| [docs/DESPLIEGUE.md](docs/DESPLIEGUE.md) | Desplegar a AWS y operar producción |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Cómo proponer cambios: ramas, commits, pull requests |
| [SECURITY.md](SECURITY.md) | Cómo reportar una vulnerabilidad |
| [docs/videos/](docs/videos/) | Videos de capacitación para usuarios |

## Estructura

```
packages/core       dominio + SQL PostGIS (reportes, estados, tiles MVT, estadísticas) y migraciones
packages/functions  Lambdas: migrador, moderación de fotos y correos de Cognito
packages/web        app Astro: páginas, API REST, tiles /tiles/{z}/{x}/{y}.pbf, sitemap, PWA
infra/              VPC, RDS, bucket, Cognito, CloudFront y presupuesto (SST)
docs/               documentación técnica y videos
```

## Costo

~USD 21/mes fijos (RDS ~13,5 + NAT ~7,3). El resto es por uso: Lambda, CloudFront, S3 y Rekognition (≈ USD 0,002 por foto). Detalle en [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md#costos).

## Contribuir

Las contribuciones son bienvenidas: código, categorías nuevas, correcciones de nombres de barrios, traducciones o reportes de errores. Empezá por [CONTRIBUTING.md](CONTRIBUTING.md).

## Licencia

[MIT](LICENSE). Los límites administrativos provienen de geoBoundaries (CC BY 4.0) y los datos exportados de reportes se publican como datos abiertos.
