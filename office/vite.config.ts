import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { readFileSync } from "fs";

const pkg = JSON.parse(readFileSync("../package.json", "utf-8"));

export default defineConfig({
  plugins: [tailwindcss(), react()],
  define: {
    __MAW_VERSION__: JSON.stringify(pkg.version),
    __MAW_BUILD__: JSON.stringify(new Date().toLocaleString("sv-SE", { timeZone: "Asia/Bangkok", dateStyle: "short", timeStyle: "short" })),
  },
  root: ".",
  base: "/",
  build: {
    outDir: "../dist-office",
    emptyOutDir: true,
  },
  server: {
    host: true,
    allowedHosts: [process.env.MAW_HOST || "localhost"],
    proxy: {
      "/api": `http://${process.env.MAW_HOST || "localhost"}:${process.env.MAW_PORT || 3456}`,
      "/ws/pty": { target: `ws://${process.env.MAW_HOST || "localhost"}:${process.env.MAW_PORT || 3456}`, ws: true },
      "/ws": { target: `ws://${process.env.MAW_HOST || "localhost"}:${process.env.MAW_PORT || 3456}`, ws: true },
    },
  },
});
