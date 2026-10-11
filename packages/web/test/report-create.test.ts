import type { APIContext } from "astro";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../src/pages/api/reports/index";

const { hit, createReport } = vi.hoisted(() => ({
  hit: vi.fn(async () => true),
  createReport: vi.fn(async () => ({ report: { id: "r1", public_code: "PY-2026-000001", title: "Bache", slug: "bache" }, anonToken: "t" })),
}));
vi.mock("@rc/core/ratelimit", () => ({ hit }));
vi.mock("@rc/core/photos", () => ({ reservePhotos: async () => [] }));
vi.mock("@rc/core/reports", async (importOriginal) => ({ ...(await importOriginal<typeof import("@rc/core/reports")>()), createReport }));
vi.mock("../src/lib/server/services", () => ({
  captchaEnabled: () => true,
  verifyTurnstile: async (token?: string) => token === "valido",
  presignUpload: async () => null,
}));

beforeEach(() => {
  hit.mockClear();
  createReport.mockClear();
});

const body = { category: "bache", title: "Bache en la esquina", description: "", lat: -25.3, lng: -57.6, extra: {} };

// El endpoint solo lee el cuerpo, la sesión y la IP.
function request(json: unknown, user?: { id: string }): APIContext {
  const ctx: Pick<APIContext, "request" | "locals" | "clientAddress"> = {
    request: new Request("https://ciudadano.test/api/reports", { method: "POST", body: JSON.stringify(json) }),
    locals: { user: user as APIContext["locals"]["user"] },
    clientAddress: "127.0.0.1",
  };
  return ctx as APIContext;
}

describe("POST /api/reports", () => {
  it("sin sesión ni captcha responde captcha sin gastar el límite por IP", async () => {
    const res = await POST(request(body));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "captcha" } });
    expect(hit).not.toHaveBeenCalled();
    expect(createReport).not.toHaveBeenCalled();
  });

  it("con un captcha válido crea el reporte", async () => {
    expect((await POST(request({ ...body, turnstile: "valido" }))).status).toBe(201);
    expect(hit).toHaveBeenCalled();
  });

  it("con sesión no pide captcha", async () => {
    expect((await POST(request(body, { id: "u1" }))).status).toBe(201);
  });
});
