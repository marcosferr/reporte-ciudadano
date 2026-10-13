import { describe, expect, it } from "vitest";
import { angleDiff, bearing, bearingAt, distanceM, forwardArc, makeFrame, nearProjections, pointAt, preparePolyline, project, signedArc, toXY, type LngLat } from "../src/geo";

const LAT = -25.3;
const frame = makeFrame([-57.6, LAT]);
// Grados de longitud por metro a esta latitud.
const DLNG = 1 / (111_320 * Math.cos((LAT * Math.PI) / 180));
const DLAT = 1 / 111_320;
/** Un punto a `x` m al este y `y` m al norte del origen. */
const at = (x: number, y = 0): LngLat => [-57.6 + x * DLNG, LAT + y * DLAT];
const xy = (x: number, y = 0) => toXY(frame, at(x, y));

describe("distancias y rumbos", () => {
  it("mide en metros y grados desde el norte", () => {
    expect(distanceM([-57.6, LAT], [-57.6, LAT + 0.001])).toBeCloseTo(111.3, 1);
    expect(bearing(at(0), at(0, 100))).toBeCloseTo(0);
    expect(bearing(at(0), at(100))).toBeCloseTo(90);
    expect(bearing(at(0), at(0, -100))).toBeCloseTo(180);
    expect(bearing(at(0), at(-100))).toBeCloseTo(270);
    expect(angleDiff(350, 10)).toBe(20);
    expect(angleDiff(90, 270)).toBe(180);
  });
});

describe("líneas", () => {
  it("acumula el largo, descarta vértices repetidos y reconoce un circular", () => {
    const l = preparePolyline(frame, [at(0), at(0), at(100), at(100, 100)]);
    expect(l.xs.length).toBe(3);
    expect(l.length).toBeCloseTo(200, 0);
    expect(l.closed).toBe(false);
    const loop = preparePolyline(frame, [at(0), at(1000), at(1000, 1000), at(0, 1000), at(0, 50)]);
    expect(loop.closed).toBe(true);
    // Los 50 m que faltan para volver al inicio cuentan.
    expect(loop.length).toBeCloseTo(4000, 0);
    // Las partes de un MultiLineString se unen en orden.
    expect(preparePolyline(frame, [[at(0), at(100)], [at(200), at(300)]]).length).toBeCloseTo(300, 0);
  });

  it("proyecta un punto sobre la línea", () => {
    const l = preparePolyline(frame, [at(0), at(1000)]);
    const p = project(l, ...xy(400, 30));
    expect(p.s).toBeCloseTo(400, 0);
    expect(p.offsetM).toBeCloseTo(30, 0);
    expect(project(l, ...xy(-50)).s).toBe(0);
    expect(project(l, ...xy(1100)).s).toBeCloseTo(1000, 0);
    const [x, y] = pointAt(l, 250);
    expect(x).toBeCloseTo(xy(250)[0], 0);
    expect(y).toBeCloseTo(0, 0);
    expect(bearingAt(l, 500)).toBeCloseTo(90);
  });

  it("mide hacia adelante y hacia atrás, dando la vuelta en un circular", () => {
    const l = preparePolyline(frame, [at(0), at(1000)]);
    expect(signedArc(l, 800, 200)).toBe(-600);
    const loop = preparePolyline(frame, [at(0), at(1000), at(1000, 1000), at(0, 1000), at(0, 0)]);
    expect(signedArc(loop, 3900, 100)).toBeCloseTo(200, 0);
    expect(forwardArc(loop, 200, 100)).toBeCloseTo(3900, 0);
  });
});

describe("pasadas cerca de un punto", () => {
  it("una línea que zigzaguea en el borde del radio es una sola pasada", () => {
    // Entra al radio (47 m), sale a 58 m y vuelve a entrar. Sin fusionar mínimos, solo la histéresis la mantiene junta.
    const l = preparePolyline(frame, [at(-300, 45), at(-15, 45), at(-5, 58), at(5, 58), at(15, 45), at(300, 45)]);
    expect(nearProjections(l, ...xy(0), 50, { mergeArcM: 0 })).toHaveLength(1);
    expect(nearProjections(l, ...xy(0), 50, { mergeArcM: 0, hysteresisM: 0 })).toHaveLength(2);
  });

  it("una rotonda frente al punto es una pasada; ir y volver lejos sobre la línea son dos", () => {
    const roundabout = preparePolyline(frame, [at(-500), at(-20), at(0, 30), at(20), at(0, -30), at(-20, 5), at(500)]);
    expect(nearProjections(roundabout, ...xy(0), 50)).toHaveLength(1);
    // Va 3 km al este por la calle y vuelve por la misma: pasa dos veces, a 6 km de distancia sobre la línea.
    const outAndBack = preparePolyline(frame, [at(-3000, 10), at(3000, 10), at(3000, -10), at(-3000, -10)]);
    const passes = nearProjections(outAndBack, ...xy(0), 50);
    expect(passes.map((p) => Math.round(p.s / 100) * 100)).toEqual([3000, 9000]);
  });

  it("en un circular, pasar por el inicio es una sola pasada", () => {
    const loop = preparePolyline(frame, [at(0), at(2000), at(2000, 2000), at(0, 2000), at(0, 10)]);
    expect(loop.closed).toBe(true);
    expect(nearProjections(loop, ...xy(0, 0), 50)).toHaveLength(1);
  });

  it("un punto lejos no tiene pasadas", () => {
    const l = preparePolyline(frame, [at(0), at(1000)]);
    expect(nearProjections(l, ...xy(500, 200), 50)).toEqual([]);
    expect(nearProjections(l, ...xy(5000), 50)).toEqual([]);
  });
});
