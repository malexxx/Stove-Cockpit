import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";

const INCLUDE_RE = /<!--\s*@include\s+([a-zA-Z0-9_./-]+)\s*-->/g;

function htmlPartialsPlugin() {
  const rootDir = path.resolve(__dirname);
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
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "../shared"),
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
