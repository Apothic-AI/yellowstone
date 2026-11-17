import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";
import vike from "vike/plugin";
import vikeSolid from "vike-solid/vite";
import { apiMiddleware } from "./src/server/api.ts";

/** The API is a Vite middleware so `vite` (dev) and `vite preview` (the built
 * app) serve the same read-only endpoints from the same code. */
function fleetGraphApi(): Plugin {
  return {
    name: "fleet-graph-api",
    configureServer(server) {
      server.middlewares.use(apiMiddleware());
    },
    configurePreviewServer(server) {
      server.middlewares.use(apiMiddleware());
    }
  };
}

export default defineConfig({
  server: { port: Number(process.env.PORT ?? 5174), strictPort: false },
  preview: { port: Number(process.env.PORT ?? 5174) },
  optimizeDeps: {
    include: ["solid-js", "solid-js/web", "solid-js/store", "vike-solid/usePageContext"]
  },
  plugins: [fleetGraphApi(), solid({ ssr: true }), vikeSolid(), vike()]
});
