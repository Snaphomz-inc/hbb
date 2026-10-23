import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * One codebase, one city per build. `VITE_CITY` (env or .env; default "la") picks a folder under
 * cities/: its city.json becomes the `__CITY__` constant in the bundle and fills index.html, and
 * its data/ folder is served and shipped at /data/. Set VITE_BASE (for example "/neighborhoods/")
 * when the site is served under a sub-path.
 */
const ROOT = path.dirname(fileURLToPath(import.meta.url));

export type CityConfig = {
  slug: string;
  name: string;
  domain: string;
  headline: string;
  sources: { credits: string };
};

function loadCity(slug: string): CityConfig {
  const file = path.join(ROOT, "cities", slug, "city.json");
  if (!fs.existsSync(file)) {
    const known = fs.existsSync(path.join(ROOT, "cities")) ? fs.readdirSync(path.join(ROOT, "cities")).join(", ") : "none";
    throw new Error(`VITE_CITY="${slug}" has no cities/${slug}/city.json (known cities: ${known})`);
  }
  return JSON.parse(fs.readFileSync(file, "utf-8")) as CityConfig;
}

function cityPlugin(slug: string): Plugin {
  const city = loadCity(slug);
  const dataDir = path.join(ROOT, "cities", slug, "data");
  const publicCity = { slug: city.slug, name: city.name, domain: city.domain, headline: city.headline, credits: city.sources.credits };
  let base = "/";
  let outDir = "dist";
  return {
    name: "snaphomz-city",
    config: () => ({ define: { __CITY__: JSON.stringify(publicCity) } }),
    configResolved(config) {
      base = config.base;
      outDir = config.build.outDir;
    },
    transformIndexHtml: (html) => html.replaceAll("%CITY_NAME%", city.name),
    // Dev and preview: /data/* comes straight from the city folder.
    configureServer(server) {
      const prefix = `${base.replace(/\/$/, "")}/data/`;
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0];
        if (!url.startsWith(prefix)) return next();
        const file = path.join(dataDir, path.normalize(decodeURIComponent(url.slice(prefix.length))));
        if (!file.startsWith(dataDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return next();
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        fs.createReadStream(file).pipe(res);
      });
    },
    // Build: the city's data folder is copied into dist/data, the only non-hashed files in the bundle.
    closeBundle() {
      if (!fs.existsSync(dataDir)) throw new Error(`cities/${slug}/data is missing; run "npm run data" first`);
      fs.cpSync(dataDir, path.join(ROOT, outDir, "data"), { recursive: true });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, ROOT, "VITE_"), ...process.env };
  const city = env.VITE_CITY || "la";
  return {
    base: env.VITE_BASE ?? "/",
    plugins: [react(), cityPlugin(city)],
    server: { port: 5190, strictPort: true },
    preview: { port: 5190, strictPort: true },
    build: {
      sourcemap: false,
      chunkSizeWarningLimit: 1100,
      rollupOptions: {
        output: {
          // MapLibre is most of the bundle; keep it in its own long-cached chunk.
          manualChunks: { maplibre: ["maplibre-gl"], react: ["react", "react-dom"] },
        },
      },
    },
  };
});
