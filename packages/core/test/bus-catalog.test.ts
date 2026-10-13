import { describe, expect, it } from "vitest";
import { buildCatalog, choiceOf, normLine, normPlace, passesFor, passesNear, reconcileTrip, stopOptions, STOP_CFG } from "../src/bus-catalog";
import { at, file, route } from "./transit-fixtures";

const stop = at(0, 0);
// Por la parada (en el origen) pasan:
const features = [
  // dos variantes del 41 hacia Asunción, por la mano norte de la calle
  route(22, "00A1", [[-5000, 10], [5000, 10]]),
  route(22, "00a2", [[-3000, 12], [6000, 12]], { line: "41 - 2", to: "Asuncion " }),
  // el 41 de vuelta, por la otra mano
  route(22, "00a3", [[5000, -10], [-5000, -10]], { direction: "vuelta", from: "ASUNCIÓN", to: "LAMBARÉ" }),
  // otra empresa
  route(44, "0100", [[-4000, 20], [4000, 20]], { line: "30", to: "LUQUE" }),
  // un circular que va y vuelve por la misma calle: pasa dos veces, una para cada lado
  route(8, "0200", [[-3000, 15], [3000, 15], [3000, -15], [-3000, -15], [-3000, 15]], { line: "12", direction: "circular", to: "CAPIATÁ" }),
  // termina a 40 m de la parada: ahí no se sube nadie
  route(8, "0201", [[-6000, 5], [40, 5]], { line: "13" }),
  // pasa a 300 m
  route(44, "0101", [[-4000, 300], [4000, 300]], { line: "30" }),
];
const catalog = buildCatalog(file(features));

describe("líneas que pasan por una parada", () => {
  it("encuentra dónde pasa cada recorrido y hacia dónde va", () => {
    const passes = passesNear(catalog, stop);
    const byKey = Object.fromEntries(passes.map((p) => [p.key, p]));
    expect(Object.keys(byKey).sort()).toEqual(["22:00a1", "22:00a2", "22:00a3", "44:0100", "8:0200"]);
    expect(byKey["22:00a1"].s).toBeCloseTo(5000, -1);
    expect(byKey["22:00a1"].bearing).toBeCloseTo(90, 0);
    expect(byKey["22:00a3"].bearing).toBeCloseTo(270, 0);
    expect(passes.filter((p) => p.key === "8:0200").map((p) => Math.round(p.bearing))).toEqual([90, 270]);
  });

  it("junta las variantes de una línea hacia el mismo destino y separa los sentidos", () => {
    const options = stopOptions(catalog, stop);
    expect(options.map((o) => [o.line, o.destination, Math.round(o.bearing), o.routes.map((r) => r.key)])).toEqual([
      ["12", "CAPIATÁ", 90, ["8:0200"]],
      ["12", "CAPIATÁ", 270, ["8:0200"]],
      ["30", "LUQUE", 90, ["44:0100"]],
      ["41", "ASUNCIÓN", 90, ["22:00a1", "22:00a2"]],
      ["41", "LAMBARÉ", 270, ["22:00a3"]],
    ]);
    expect(stopOptions(catalog, at(0, 1000))).toEqual([]);
    // Sin línea (el VMT la manda vacía) va al final.
    const blank = buildCatalog(file([route(9, "0300", [[-1000, 0], [1000, 0]], { line: " " }), route(9, "0301", [[-1000, 3], [1000, 3]], { line: "5" })]));
    expect(stopOptions(blank, stop).map((o) => o.line)).toEqual(["5", null]);
  });

  it("normaliza lugares y líneas", () => {
    expect(normPlace("ASUNCIÓN")).toBe(normPlace(" Asuncion "));
    expect(normLine("41 - 1")).toBe("41");
    expect(normLine("41-2")).toBe("41");
    expect(normLine(null)).toBe("");
  });
});

describe("viajes guardados cuando cambia el catálogo", () => {
  const options = stopOptions(catalog, stop);
  const asuncion = options.find((o) => o.line === "41" && o.destination === "ASUNCIÓN")!;
  const choices = [choiceOf(asuncion)];
  const radiusM = STOP_CFG.STOP_RADIUS_M;
  const trip = { stop, choices, passes: passesFor(catalog, stop, choices, radiusM + STOP_CFG.RECONCILE_EXTRA_M), catalogVersion: "v1", radiusM };

  it("con el mismo catálogo no cambia nada", () => {
    expect(trip.passes.map((p) => p.key)).toEqual(["22:00a1", "22:00a2"]);
    expect(reconcileTrip(trip, catalog).status).toBe("same");
  });

  it("toma variantes nuevas, recorridos corridos y destinos renombrados; descarta un hex que ahora va al revés", () => {
    const next = buildCatalog(file([
      route(22, "00a1", [[-5000, 25], [5000, 25]], { to: "ASUNCION (CENTRO)" }),
      route(22, "00a2", [[6000, 12], [-3000, 12]], { line: "41 - 2" }),
      route(22, "00a9", [[-2000, 8], [2000, 8]], { line: "41 - 9" }),
    ], "v2"));
    const { trip: t, status } = reconcileTrip(trip, next);
    expect(status).toBe("updated");
    expect(t.catalogVersion).toBe("v2");
    expect(t.passes.map((p) => [p.key, Math.round(p.s / 10) * 10])).toEqual([["22:00a1", 5000], ["22:00a9", 2000]]);
  });

  it("si ya no pasa ninguna de sus líneas, el viaje queda perdido", () => {
    const next = buildCatalog(file([route(44, "0100", [[-4000, 20], [4000, 20]], { line: "30" })], "v3"));
    expect(reconcileTrip(trip, next)).toMatchObject({ status: "lost", trip: { passes: [], catalogVersion: "v3" } });
  });
});
