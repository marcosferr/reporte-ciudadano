-- Nombre de la empresa de cada recorrido (`eot_nombre` del itinerario), para el catálogo que se baja entero en
-- /cuando-salgo: ahí hay que nombrar las líneas que pasan por una parada sin depender de los buses en vivo.
-- Queda NULL hasta la siguiente sincronización.
ALTER TABLE bus_routes ADD COLUMN company_name text;
