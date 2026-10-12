-- Histórico del VMT (ver packages/core/src/vmt-history.ts). Las posiciones crudas y compactadas viven en S3
-- (vmt/ del bucket Media); acá quedan solo resúmenes chicos para medir la disponibilidad desde la app.

-- Una fila por empresa en cada consulta de VmtCollector (una por minuto): ¿respondió el VMT y con datos frescos?
CREATE TABLE vmt_polls (
  polled_at     timestamptz NOT NULL,
  company_code  int         NOT NULL,
  http_status   smallint,                 -- NULL: sin respuesta (timeout, conexión)
  latency_ms    int         NOT NULL,
  error         text,
  buses         int,                      -- buses en la respuesta (NULL si falló)
  fresh_buses   int,                      -- de esos, los que reportaron en los últimos 2 minutos
  median_age_s  int,                      -- edad mediana del último reporte de cada bus
  PRIMARY KEY (polled_at, company_code)
);

-- Actividad por hora y recorrido, calculada una vez por día por VmtCompactor a partir de las posiciones.
CREATE TABLE bus_route_activity (
  hour          timestamptz NOT NULL,     -- inicio de la hora
  company_code  int         NOT NULL,
  route_hex     text        NOT NULL,     -- '0000': buses sin recorrido asignado
  buses         int         NOT NULL,     -- buses distintos que reportaron en la hora
  moving_buses  int         NOT NULL,     -- de esos, los que reportaron alguna vez a 5 km/h o más
  reports       int         NOT NULL,
  avg_speed     real,                     -- km/h promedio de los reportes en movimiento
  PRIMARY KEY (hour, company_code, route_hex)
);
