import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

function resolveBasePath(): string {
  const repositorySlug = process.env.GITHUB_REPOSITORY;
  if (!repositorySlug) {
    return "/";
  }

  const repositoryName = repositorySlug.split("/")[1];
  if (!repositoryName || repositoryName.endsWith(".github.io")) {
    return "/";
  }

  return `/${repositoryName}/`;
}

export default defineConfig({
  base: resolveBasePath(),
  server: {
    proxy: {
      "/api/mbta": {
        target: "https://mbta-proxy.handorff-paul.workers.dev",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/mbta/, ""),
        proxyTimeout: 15_000
      }
    }
  },
  build: {
    rollupOptions: {
      input: {
        home: fileURLToPath(new URL("./index.html", import.meta.url)),
        projects: fileURLToPath(new URL("./projects/index.html", import.meta.url))
      }
    }
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "worker/**/*.test.js"]
  }
});

