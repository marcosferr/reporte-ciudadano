import type { APIContext } from "astro";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../src/pages/api/reports/[id]/photos";

const { reservePhotos, pendingPhotos, presignUpload } = vi.hoisted(() => ({
  reservePhotos: vi.fn(async () => [{ id: "nueva", s3_key_original: "uploads/r1/nueva.jpg" }]),
  pendingPhotos: vi.fn(async () => [{ id: "vieja", s3_key_original: "uploads/r1/vieja.jpg" }]),
  presignUpload: vi.fn(async (key: string) => ({ url: "https://s3.test", fields: { key } })),
}));
vi.mock("@rc/core/photos", () => ({ reservePhotos, pendingPhotos }));
vi.mock("@rc/core/reports", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rc/core/reports")>()),
  getReportById: async (id: string) => (id === "r1" ? { id, reporter_user_id: null } : undefined),
  verifyAnonToken: async (_id: string, token: string) => token === "secreto",
}));
vi.mock("../src/lib/server/services", () => ({ presignUpload }));

beforeEach(() => {
  reservePhotos.mockClear();
  pendingPhotos.mockClear();
});

// El endpoint solo lee `params`, el cuerpo y la sesión.
function request(body: unknown): APIContext {
  const ctx: Pick<APIContext, "params" | "request" | "locals"> = {
    params: { id: "r1" },
    request: new Request("https://ciudadano.test/api/reports/r1/photos", { method: "POST", body: JSON.stringify(body) }),
    locals: {},
  };
  return ctx as APIContext;
}

describe("POST /api/reports/[id]/photos", () => {
  it("vuelve a firmar las reservas pendientes sin ocupar lugares nuevos del cupo", async () => {
    const res = await POST(request({ renew: ["uploads/r1/vieja.jpg"], anonToken: "secreto" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ uploads: [{ url: "https://s3.test", fields: { key: "uploads/r1/vieja.jpg" } }] });
    expect(pendingPhotos).toHaveBeenCalledWith("r1", ["uploads/r1/vieja.jpg"], "report");
    expect(reservePhotos).not.toHaveBeenCalled();
  });

  it("reserva lugares nuevos con count", async () => {
    expect((await POST(request({ count: 2, anonToken: "secreto" }))).status).toBe(200);
    expect(reservePhotos).toHaveBeenCalledWith("r1", 2, "report");
    expect(pendingPhotos).not.toHaveBeenCalled();
  });

  it("no deja renovar a quien no hizo el reporte", async () => {
    expect((await POST(request({ renew: ["uploads/r1/vieja.jpg"], anonToken: "otro" }))).status).toBe(403);
    expect(pendingPhotos).not.toHaveBeenCalled();
  });

  it("rechaza un pedido sin count ni renew", async () => {
    expect((await POST(request({ anonToken: "secreto" }))).status).toBe(400);
  });
});
