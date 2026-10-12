import { describe, expect, it } from "vitest";
import { trackHeadings } from "../src/lib/client/bus-heading";

const at = (lng: number, lat: number): [number, number] => [lng, lat];

describe("rumbo de los colectivos", () => {
  it("sigue hacia dónde se movió el bus y, detenido, conserva el último", () => {
    let tracks = trackHeadings(new Map(), [{ id: 1, at: at(-57.6, -25.3) }]);
    expect(tracks.get(1)?.heading).toBeUndefined();
    // ~110 m hacia el este.
    tracks = trackHeadings(tracks, [{ id: 1, at: at(-57.599, -25.3) }]);
    expect(tracks.get(1)?.heading).toBeCloseTo(90, 0);
    // ~5 m: ruido del GPS, conserva el rumbo.
    tracks = trackHeadings(tracks, [{ id: 1, at: at(-57.59895, -25.3) }]);
    expect(tracks.get(1)?.heading).toBeCloseTo(90, 0);
    // ~110 m hacia el sur.
    tracks = trackHeadings(tracks, [{ id: 1, at: at(-57.59895, -25.301) }]);
    expect(tracks.get(1)?.heading).toBeCloseTo(180, 0);
  });

  it("prefiere el rumbo que manda el servidor y lo conserva cuando el bus se detiene", () => {
    let tracks = trackHeadings(new Map(), [{ id: 1, at: at(-57.6, -25.3), heading: 270 }]);
    expect(tracks.get(1)?.heading).toBe(270);
    // ~110 m hacia el este, pero el servidor dice 265: gana el servidor.
    tracks = trackHeadings(tracks, [{ id: 1, at: at(-57.599, -25.3), heading: 265 }]);
    expect(tracks.get(1)?.heading).toBe(265);
    tracks = trackHeadings(tracks, [{ id: 1, at: at(-57.599, -25.3) }]);
    expect(tracks.get(1)?.heading).toBe(265);
  });

  it("olvida los buses que dejaron de reportar", () => {
    const tracks = trackHeadings(new Map([[2, { at: at(-57.6, -25.3), heading: 45 }]]), [{ id: 1, at: at(-57.6, -25.3) }]);
    expect([...tracks.keys()]).toEqual([1]);
  });
});
