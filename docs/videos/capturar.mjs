// Recorre la app como un vecino sin cuenta (celular) y genera .capturas/ciudadano/manual.json para manual-video.
//
//   BASE=http://localhost:4399 PLAYWRIGHT=<ruta a playwright/index.mjs> node docs/videos/capturar.mjs
//
// Usar SIEMPRE contra el servidor local con datos de ejemplo (`pnpm db:seed -- --demo`): el recorrido publica un reporte.
// La ubicación simulada queda a ~25 m del bache de ejemplo de Mcal. López para mostrar el aviso de duplicados.
import fs from "node:fs";
import path from "node:path";

const { chromium } = await import(process.env.PLAYWRIGHT ?? "playwright");
const BASE = process.env.BASE ?? "http://localhost:4399";
const DIR = path.join(path.dirname(new URL(import.meta.url).pathname), ".capturas");
const OUT = path.join(DIR, "ciudadano");
const VISTA = { width: 390, height: 844 };
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: VISTA, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: "es-PY",
  geolocation: { latitude: -25.29345, longitude: -57.59082 }, permissions: ["geolocation"],
});
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("pageerror:", e.message));

async function asentar(ms = 600) {
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(ms);
}

const pasos = [];
async function paso(texto, locators, { nota, espera, scroll = true } = {}) {
  // Centrado (no "if needed"): la barra de navegación fija de abajo taparía lo que queda al borde.
  if (scroll) await locators[0].evaluate((el) => el.scrollIntoView({ block: "center" }));
  await asentar(espera);
  const cajas = [];
  for (const l of locators) {
    const b = await l.boundingBox();
    if (!b) throw new Error(`Sin caja para el paso: ${texto}`);
    cajas.push({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) });
  }
  const archivo = `paso-${String(pasos.length + 1).padStart(2, "0")}.png`;
  await page.screenshot({ path: path.join(OUT, archivo) });
  pasos.push({ texto, ...(nota ? { nota } : {}), imagenLimpia: archivo, cajas, vista: VISTA });
  console.log("✓", archivo, texto.replace(/\*\*/g, ""));
}

// 1. Inicio
await page.goto(`${BASE}/`);
await asentar(3500);
const navReportar = page.locator('nav[aria-label="Navegación"] a[href="/reportar"]');
await paso("Desde el mapa, tocá **Reportar** en la barra de abajo. No hace falta tener cuenta.", [navReportar], { espera: 1500 });

// 2. Qué pasa
await navReportar.click();
await page.waitForURL("**/reportar");
const bache = page.getByRole("button", { name: "Bache", exact: true });
await paso("Elegí la categoría que mejor describe el problema.", [bache]);

// 3–4. Dónde
await bache.click();
await page.getByText("¿Dónde está?").waitFor();
await page.waitForTimeout(4000); // la app pide la ubicación y vuela hasta ahí
const pin = page.locator('svg[viewBox="0 0 36 48"]');
const miUbicacion = page.getByRole("button", { name: /Mi ubicación/ });
await paso("La app te ubica con el GPS. Mové el mapa hasta que el pin quede sobre el problema; **Mi ubicación** te vuelve a centrar.", [pin, miUbicacion], { espera: 2500, scroll: false });
const lugar = page.locator("section p.min-h-5");
await lugar.filter({ hasText: /\S/ }).waitFor();
const confirmar = page.getByRole("button", { name: "Confirmar ubicación" });
await paso("Revisá el barrio y la ciudad que aparecen debajo del mapa y tocá **Confirmar ubicación**.", [lugar, confirmar], { espera: 1500, scroll: false });

// 5. Duplicados
await confirmar.click();
const aviso = page.locator("div.border-amber-300");
await aviso.waitFor();
await paso("Si alguien ya lo reportó muy cerca, aparece acá. Si es el mismo problema, tocá **Es este** para confirmarlo.",
  [aviso], { nota: "Confirmar un reporte existente le da más fuerza que crear uno repetido." });

// 6. Fotos
await page.locator('input[type="file"]').setInputFiles(path.join(DIR, "bache-demo.jpg"));
await page.getByAltText("Foto 1").waitFor();
const fotos = page.locator("span.label", { hasText: "Fotos" }).locator("..");
await paso("Agregá hasta cuatro fotos con **📷 Agregar**.", [fotos],
  { nota: "Las caras se difuminan automáticamente y se borra la información oculta de la foto." });

// 7. Título y descripción
await page.locator("#title").fill("Bache profundo frente a la parada");
await page.locator("#desc").fill("Está así desde la última lluvia. Los autos frenan de golpe para esquivarlo y se junta agua.");
await paso("Escribí un **Título** corto y, si querés, una **Descripción** con referencias.", [page.locator("#title"), page.locator("#desc")]);

// 8. Publicar
const publicar = page.getByRole("button", { name: "Publicar reporte" });
await paso("Tocá **Publicar reporte**.", [publicar], { nota: "No incluyas datos personales ni acusaciones a personas." });

// 9. Listo
await publicar.click();
await page.getByText("¡Gracias por reportar!").waitFor({ timeout: 20000 });
const codigo = page.locator("p.font-mono");
const guardado = page.getByText("Lo guardamos en este dispositivo", { exact: false });
await paso("Listo: el reporte queda publicado con un **código de seguimiento**.", [codigo, guardado]);

// 10. Mis casos
await page.goto(`${BASE}/mis-reportes`);
await asentar(1200);
const enDispositivo = page.getByRole("heading", { name: "Hechos desde este dispositivo" }).locator("..");
await paso("En **Mis casos** encontrás los reportes hechos desde este celular, aunque no tengas cuenta.", [enDispositivo]);

const manual = {
  rol: "ciudadano",
  nombreRol: "Sin iniciar sesión",
  usuario: "(sin cuenta)",
  resumen: "Cualquier vecino puede reportar un problema desde el celular sin crear una cuenta.",
  procesos: [{
    titulo: "Publicar un reporte",
    descripcion: "Categoría, ubicación, fotos y detalles: el reporte queda en el mapa con un código de seguimiento.",
    pasos,
  }],
};
fs.writeFileSync(path.join(OUT, "manual.json"), JSON.stringify(manual, null, 2));
console.log(`manual.json con ${pasos.length} pasos`);
await browser.close();
