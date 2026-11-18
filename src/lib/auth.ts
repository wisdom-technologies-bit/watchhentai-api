/**
 * API key gate.
 *
 * The service is an adult-content resolver, so it is not meant to answer
 * anonymous traffic from the public internet. `API_KEY` (or the aliased
 * `WATCHHENTAI_API_KEY`) is read per request, so rotating it needs only an env
 * change and a restart.
 *
 * An unset key is a misconfiguration, not an open door: non-exempt routes answer
 * 503 until it is set. `/health` stays open so a platform healthcheck can tell
 * "up but unconfigured" from "down".
 */

const ENV_NAMES = ["API_KEY", "WATCHHENTAI_API_KEY"] as const;

/** Paths that never need a key. Compared after the `/api` base path. */
const EXEMPT = new Set(["/health", "/", ""]);

export function configuredApiKey(env: Record<string, string | undefined> = process.env): string | null {
  for (const name of ENV_NAMES) {
    const value = (env[name] ?? "").trim();
    if (value) return value;
  }
  return null;
}

export function isExemptPath(pathname: string): boolean {
  // The app mounts under /api, so the middleware sees "/api/health" even though
  // the route is "/health". Strip that prefix before deciding.
  const path = pathname.replace(/\/+$/, "").replace(/^\/api(?=\/|$)/, "") || "/";
  return EXEMPT.has(path);
}

export function presentedKey(request: Request): string | null {
  const header = request.headers.get("x-api-key");
  if (header && header.trim()) return header.trim();
  const authorization = request.headers.get("authorization");
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    const token = authorization.slice(7).trim();
    if (token) return token;
  }
  try {
    const query = new URL(request.url).searchParams.get("apiKey");
    if (query && query.trim()) return query.trim();
  } catch {
    // A malformed URL is treated as "no key presented".
  }
  return null;
}

/** Length-independent, timing-safe comparison. */
export function keysMatch(expected: string, provided: string): boolean {
  const a = new TextEncoder().encode(expected);
  const b = new TextEncoder().encode(provided);
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export type AuthOutcome = "ok" | "unconfigured" | "unauthorized";

export function authorize(
  request: Request,
  env: Record<string, string | undefined> = process.env,
): AuthOutcome {
  let pathname = "/";
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return "unauthorized";
  }
  if (isExemptPath(pathname)) return "ok";
  const expected = configuredApiKey(env);
  if (!expected) return "unconfigured";
  const provided = presentedKey(request);
  if (!provided) return "unauthorized";
  return keysMatch(expected, provided) ? "ok" : "unauthorized";
}
