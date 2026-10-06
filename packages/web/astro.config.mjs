import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import sst from "astro-sst";

export default defineConfig({
  site: process.env.SITE_URL ?? "https://ciudadano.tereredev.com",
  output: "server",
  adapter: sst({ responseMode: "buffer" }),
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
    ssr: { noExternal: ["@rc/core"] },
    optimizeDeps: { include: ["maplibre-gl", "exifr", "terra-draw", "terra-draw-maplibre-gl-adapter"] },
  },
  security: { checkOrigin: true },
  devToolbar: { enabled: false },
  // Astro 7 cambió el default a "jsx" (quita espacios entre elementos inline con saltos de línea);
  // mantenemos el comportamiento de Astro 5 para no alterar el texto de las páginas.
  compressHTML: true,
});
