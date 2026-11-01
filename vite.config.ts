import { defineConfig } from "vite";
import istanbul from "vite-plugin-istanbul";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [
    react(),
    istanbul({
      include: ["src/web/**"],
      exclude: [],
      requireEnv: true,
      forceBuildInstrument: true,
    }),
  ],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:47921",
      "/media": "http://127.0.0.1:47921",
    },
  },
  build: { outDir: "dist", sourcemap: true },
});
