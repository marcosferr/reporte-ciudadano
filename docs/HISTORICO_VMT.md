# Histórico de colectivos (VMT)

Desde que se despliega `VmtCollector`, cada minuto se guarda la posición de todos los colectivos que publica el prototipo del VMT (MOPC), y una vez por día sus recorridos. Sirve para medir dos cosas:

- **Disponibilidad de la API del VMT**: si respondió, en cuánto tiempo y con datos de hace cuánto.
- **Disponibilidad del servicio**: cuántos buses circularon por línea y por hora, cuáles reportan recorridos sin publicar, y más adelante frecuencias.

El código está en `packages/core/src/vmt-history.ts` y las Lambdas en `infra/buses.ts`.

## Dónde queda cada cosa

| Qué | Dónde | Quién lo escribe | Retención |
|---|---|---|---|
| Respuesta cruda de `/buses` de las 34 empresas | S3 `vmt/raw/buses/date=AAAA-MM-DD/HHMMSS.json.gz` (~31 KB) | `VmtCollector`, cada minuto | 60 días |
| Respuesta cruda de `/itinerarios` (historial de recorridos) | S3 `vmt/raw/itineraries/date=AAAA-MM-DD.json.gz` (~1,4 MB) | `BusRoutesSync`, una vez por día | indefinida |
| Un reporte por fila, sin repetir | S3 `vmt/positions/date=AAAA-MM-DD/positions.parquet` | `VmtCompactor`, 04:00 del día siguiente | indefinida |
| Cómo respondió cada empresa en cada consulta | Postgres `vmt_polls` | `VmtCollector` | indefinida |
| Actividad por hora y recorrido | Postgres `bus_route_activity` | `VmtCompactor` | indefinida |

Todo está bajo `vmt/` en el bucket `Media`, que es privado salvo `public/`. Las fechas y horas de las claves son de Paraguay (UTC-3); las columnas de tiempo de los Parquet y de la base están en UTC.

Lo crudo se guarda tal como llega, salvo `driver_id`: hoy viene vacío o con un valor de relleno, pero podría identificar a un chofer. Así, si después interesa un campo que hoy no se usa, está.

### `positions.parquet`

| Columna | Tipo | Qué es |
|---|---|---|
| `reported_at` | timestamp (UTC) | `fecha_hora` del reporte del bus |
| `seen_at` | timestamp (UTC) | primera consulta que lo trajo; `seen_at - reported_at` es la demora del VMT |
| `company_code` | int | `cod_catalogo` de la empresa |
| `bus_id` | int | `id_bus` |
| `route_hex` | string | `route_id` en minúsculas; `0000` = sin recorrido asignado |
| `line` | string | `linea_label` |
| `lat`, `lon` | double | posición (EPSG:4326) |
| `speed`, `heading` | int | `velocidad` (km/h) y `rumbo` del GPS; el `rumbo` es poco confiable |
| `calc_speed`, `calc_heading`, `prev_distance_m` | int | calculados por el VMT contra el reporte anterior; nulos si no lo tiene |
| `ramp` | bool | `tiene_rampa` |

Un reporte es único por `bus_id` y `reported_at`. El VMT devuelve el último reporte de cada bus en cada consulta, y los buses reportan cada ~10 s; al consultar cada minuto se guarda más o menos uno de cada seis reportes.

## Consultas

### Con DuckDB, sobre S3

Sin infraestructura extra: hace falta una credencial de AWS con lectura sobre `vmt/` del bucket.

```sql
INSTALL httpfs; LOAD httpfs;
CREATE SECRET (TYPE s3, PROVIDER credential_chain);

-- Buses distintos por línea y hora en un mes.
SELECT date_trunc('hour', reported_at - INTERVAL 3 HOUR) AS hora_py, line, count(DISTINCT bus_id) AS buses
FROM read_parquet('s3://<bucket>/vmt/positions/date=2026-11-*/positions.parquet', hive_partitioning = true)
GROUP BY ALL ORDER BY ALL;

-- Demora con que el VMT publica los reportes.
SELECT quantile_cont(epoch(seen_at - reported_at), [0.5, 0.9]) AS demora_s
FROM read_parquet('s3://<bucket>/vmt/positions/date=2026-11-*/positions.parquet');
```

Para trabajar sin conexión: `aws s3 sync s3://<bucket>/vmt/positions/ ./positions/` y apuntar `read_parquet` a la carpeta local.

### Disponibilidad de la API, en Postgres

```sql
-- Por empresa, en los últimos 30 días.
SELECT company_code,
       round(100.0 * count(*) FILTER (WHERE http_status = 200) / count(*), 2) AS disponible_pct,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS latencia_p95_ms,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY median_age_s) AS edad_mediana_s
FROM vmt_polls
WHERE polled_at > now() - interval '30 days'
GROUP BY company_code ORDER BY disponible_pct;
```

Un `http_status` nulo es que no hubo respuesta (timeout de 20 s o conexión cortada). Si el VMT no devuelve ni la lista de empresas, se registra la falla para todas las conocidas, porque el mapa tampoco puede mostrar ninguna. Una respuesta 200 con `fresh_buses` bajo y `median_age_s` alto también es una degradación: el mapa solo muestra buses que reportaron en los últimos 2 minutos.

## Operación

- **Volver a compactar un día** (por ejemplo, después de corregir un error): invocar `VmtCompactor` con `{"date": "AAAA-MM-DD"}`. Reemplaza el Parquet y la actividad de ese día. Solo funciona mientras los archivos crudos existan (60 días).
- **Si se cae el recolector**, ese tramo no se puede recuperar: el VMT no tiene histórico. Los huecos se ven como minutos sin filas en `vmt_polls`, que son distintos de los minutos en que el VMT falló (filas con error).
- **Costo**: ~43.200 ejecuciones de unos 3 s por mes con 256 MB, ~1 GB por mes en S3 y ~150 MB por mes en la base. Menos de USD 2 por mes.

## Pendiente

- **Licencia**: el prototipo del VMT no tiene licencia de datos abiertos. Antes de publicar estos datos (por ejemplo, un dataset mensual descargable) hay que confirmarlo con el MOPC. Mientras tanto quedan privados.
- **Agrupar `vmt_polls`** por hora pasados unos meses, si el tamaño empieza a pesar en la base.
- **Página de disponibilidad** en la app, que lea `vmt_polls` y `bus_route_activity`.
- **Frecuencias por línea**: ubicar cada posición sobre el recorrido vigente ese día (`vmt/raw/itineraries/`).
