/**
 * Railway (and any container) entry point.
 *
 * The app itself is the Hono instance exported by `src/index.ts`. Vercel mounts
 * it through `api/[[...route]].ts`, which does not exist on Railway, so this
 * file is the plain server: one process, PORT from the environment, the same
 * routes.
 *
 * Runs on Bun (`bun run server.ts`); `Dockerfile` ships that runtime.
 */
import app from "./src/index";

const port = Number(process.env.PORT ?? 3000);

export default {
  port,
  fetch: app.fetch,
  // The upstreams are slow scrapes; a hung socket should not hold a request.
  idleTimeout: 60,
};
