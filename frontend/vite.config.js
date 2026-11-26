// Configuration Vite & Vitest pour Stove Cockpit (injection de partiels HTML, version frontend et alias @shared).
import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";

const INCLUDE_RE = /<!--\s*@include\s+([a-zA-Z0-9_./-]+)\s*-->/g;
const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "package.json"), "utf-8"));

function htmlPartialsPlugin() {
  const rootDir = path.resolve(import.meta.dirname);
  return {
    name: "stove-cockpit-html-partials",
    transformIndexHtml(html) {
      return html.replace(INCLUDE_RE, (full, relPath) => {
        const target = path.resolve(rootDir, relPath.trim());
        if (!target.startsWith(rootDir + path.sep) || !fs.existsSync(target)) {
          return full;
        }
        return fs.readFileSync(target, "utf-8");
      });
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [htmlPartialsPlugin()],
  define: {
    __FRONTEND_VERSION__: JSON.stringify(pkg.version || "0.0.9"),
  },
  resolve: {
    alias: {
      "@shared": path.resolve(import.meta.dirname, "../shared"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.js"],
  },
});
