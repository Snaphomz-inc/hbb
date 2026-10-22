import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Set VITE_BASE (for example "/neighborhoods/") when the site is served under a sub-path.
export default defineConfig({
  base: process.env.VITE_BASE ?? "/",
  plugins: [react()],
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
});
