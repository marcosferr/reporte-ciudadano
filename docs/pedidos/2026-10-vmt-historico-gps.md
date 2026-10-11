# Pedido de acceso a la información pública — Histórico GPS de los buses (VMT / MOPC)

> **Cómo presentarlo.** Cargar el texto de abajo en el Portal Unificado de Acceso a la Información Pública
> (<https://informacionpublica.paraguay.gov.py>), eligiendo como institución el **Ministerio de Obras Públicas y
> Comunicaciones (MOPC)**. También se puede presentar por escrito en mesa de entrada del MOPC / Viceministerio de
> Transporte. Completar los datos marcados con `[…]` antes de enviar.
>
> **Plazos (Ley N° 5282/14 y Decreto N° 4064/15).** La institución tiene **15 días hábiles** desde el día siguiente a
> la presentación para responder. Si no responde, el silencio equivale a una denegación y se puede presentar una
> acción judicial (amparo) dentro de los 60 días hábiles. Una negativa solo es válida mediante resolución fundada
> de la máxima autoridad de la institución.
>
> **Seguimiento.** Anotar acá el número de solicitud, la fecha de presentación y la respuesta:
>
> | Fecha | Evento | Detalle |
> |---|---|---|
> | […] | Presentado | N° de solicitud: […] |

---

**Señor/a Ministro/a de Obras Públicas y Comunicaciones**
**Viceministerio de Transporte (VMT)**
**Presente**

Quien suscribe, **[Nombre y apellido]**, con cédula de identidad N° **[…]**, con domicilio en **[…]**, correo
electrónico **[…]**, en ejercicio del derecho de acceso a la información pública reconocido por el artículo 28 de
la Constitución Nacional y la Ley N° 5282/14 “De libre acceso ciudadano a la información pública y transparencia
gubernamental”, solicita respetuosamente la siguiente información:

## 1. Registro histórico de posiciones GPS de los buses del transporte público

El registro histórico de las posiciones GPS que los buses del servicio de transporte público del Área Metropolitana
de Asunción reportan al sistema del VMT, el mismo que alimenta al prototipo publicado en
<https://sistemas.mopc.gov.py/prototipo_vmt>.

- **Período:** desde el primer registro disponible hasta la fecha de respuesta. Si el volumen fuera un impedimento,
  como mínimo los **últimos 12 meses**.
- **Campos por registro** (los que ya existan en la base, sin necesidad de elaborar información nueva):
  - identificador del bus (`id_bus` y/o `mean_id`) y número de orden;
  - empresa / EOT (`agency_id`, `cod_catalogo`, nombre);
  - línea y ramal / itinerario asignado (`route_id`, `linea_label`);
  - fecha y hora del reporte;
  - latitud y longitud;
  - velocidad y rumbo reportados;
  - si el bus tiene rampa de accesibilidad.
- **Se excluye expresamente** cualquier dato personal, como la identificación del conductor (`driver_id`) o datos de
  pasajeros. No se solicita información que permita identificar a personas físicas.
- **Formato:** archivos digitales en formato abierto y procesable (CSV, Parquet o un volcado de la tabla de base de
  datos), separados por mes o por día, entregados por enlace de descarga o en el medio que la institución disponga.

## 2. Itinerarios y paradas

- Los recorridos (itinerarios) de cada línea y ramal, con su geometría, y el listado de paradas con sus coordenadas,
  tal como los usa el prototipo. Si existe una versión en formato **GTFS**, solicitarla en ese formato.
- Si los recorridos cambiaron durante el período solicitado en el punto 1, las versiones anteriores con su fecha de
  vigencia, para poder asociar cada posición histórica con el recorrido vigente en ese momento.

## 3. Documentación del sistema

- Descripción de los campos y del significado de los códigos usados (por ejemplo, `route_id` `0000`, `rn`,
  `velocidad_calculada`).
- Frecuencia con la que cada bus reporta su posición y desde qué fecha el sistema registra datos de manera completa
  (cantidad de buses y empresas incorporadas por período).
- Si el VMT prevé publicar estos datos de manera periódica como datos abiertos o habilitar un acceso al histórico
  en la API del prototipo, y bajo qué condiciones de uso o licencia.

## 4. Datos de tránsito del convenio MOPC – Waze for Cities

En enero de 2020 el MOPC informó su adhesión al programa *Connected Citizens* / *Waze for Cities* de Waze. Se solicita:

- copia del convenio o acuerdo firmado con Waze (Google), incluidas las condiciones de uso y de publicación de los
  datos recibidos;
- en la medida en que dichas condiciones lo permitan, el registro histórico de alertas recibidas (tipo, subtipo,
  ubicación, fecha y hora) para el Área Metropolitana de Asunción. Si las condiciones no lo permiten, se solicita
  indicar la cláusula que lo impide.

---

La información será utilizada en **Reporte Ciudadano** (<https://ciudadano.tereredev.com>), una plataforma abierta y
sin fines de lucro para reportar y dar seguimiento a problemas urbanos de Paraguay. El objetivo es mostrar la
puntualidad, la cobertura y los recorridos reales del transporte público junto a los reportes ciudadanos, y publicar
los resultados como datos abiertos. Esta mención es solo informativa: la Ley N° 5282/14 no exige justificar el
motivo de la solicitud.

Si parte de la información solicitada no existiera o estuviera sujeta a alguna excepción legal, se solicita entregar
la parte restante y fundar la negativa respecto de la parte no entregada, conforme a la ley.

Sin otro particular, saludo atentamente.

**[Firma]**
**[Nombre y apellido]**
**C.I. N° […]**
**[Lugar], [fecha]**
