import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { prettyJSON } from "hono/pretty-json";
import home from "./api/pages/home";
import trending from "./api/pages/trending";
import genre from "./api/pages/genre";
import videos from "./api/pages/videos";
import uncensored from "./api/pages/uncensored";
import release from "./api/pages/release";
import calendar from "./api/pages/calendar";
import search from "./api/pages/search";
import series from "./api/pages/series";
import watch from "./api/pages/watch";
import download from "./api/pages/download";
import extra from "./api/pages/extra";
import { scrapeGenreList } from "./lib/scraper";
import match from "./api/pages/match";
import { authorize, configuredApiKey } from "./lib/auth";
import { checkRateLimit } from "./lib/rate-limit";

const app = new Hono().basePath("/api");

// ─── Middleware ───────────────────────────────────────────────────────────────
/**
 * CORS: only the sites that are meant to call this. `ALLOWED_ORIGINS` is a
 * comma list; the default is the public pair, so a forgotten variable cannot
 * quietly open the service to every origin on the web.
 */
const DEFAULT_ORIGINS = ["https://kumoritv.top", "https://www.kumoritv.top"];
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const origins = allowedOrigins.length > 0 ? allowedOrigins : DEFAULT_ORIGINS;

app.use("*", cors({
  origin: (origin) => (origins.includes(origin) ? origin : origins[0]),
  allowMethods: ["GET", "OPTIONS"],
  allowHeaders: ["x-api-key", "authorization", "content-type"],
  maxAge: 86400,
}));
app.use("*", logger());
app.use("*", prettyJSON());

/**
 * Key gate. `/health` stays open so a platform healthcheck can distinguish
 * "running but unconfigured" from "down".
 */
app.use("*", async (c, next) => {
  if (c.req.method === "OPTIONS") return next();
  const outcome = authorize(c.req.raw);
  if (outcome === "ok") return next();
  if (outcome === "unconfigured") {
    return c.json({
      success: false,
      error: "AUTH_NOT_CONFIGURED",
      message: "API_KEY is not set on this service. Set it before calling any route except /api/health.",
    }, 503);
  }
  return c.json({
    success: false,
    error: "UNAUTHORIZED",
    message: "Send the key as x-api-key, Authorization: Bearer <key>, or ?apiKey=",
  }, 401);
});

/** Politeness limit per caller per route. One instance, one budget. */
app.use("*", async (c, next) => {
  const pathname = new URL(c.req.url).pathname;
  if (pathname.replace(/\/+$/, "").endsWith("/health")) return next();
  const limit = Number(process.env.RATE_LIMIT_PER_MIN || 120);
  const ip =
    (c.req.header("x-forwarded-for") || "").split(",")[0].trim() ||
    c.req.header("cf-connecting-ip") ||
    "local";
  const result = checkRateLimit(`${ip}:${pathname}`, Number.isFinite(limit) ? limit : 120, 60_000);
  c.header("x-ratelimit-remaining", String(result.remaining));
  if (!result.allowed) {
    c.header("retry-after", String(result.retryAfterSeconds));
    return c.json({ success: false, error: "RATE_LIMITED", retryAfterSeconds: result.retryAfterSeconds }, 429);
  }
  return next();
});

// ─── Pages ────────────────────────────────────────────────────────────────────
app.route("/home", home);

// ─── Trending ─────────────────────────────────────────────────────────────────
// GET /api/trending
// GET /api/trending?page=N
// GET /api/trending/:page
app.route("/trending", trending);

// ─── Episodes / Videos ───────────────────────────────────────────────────────
// GET /api/videos
// GET /api/videos?page=N
// GET /api/videos/:page
app.route("/videos", videos);

// ─── Uncensored ───────────────────────────────────────────────────────────────
// GET /api/uncensored
// GET /api/uncensored?page=N
// GET /api/uncensored/:page
app.route("/uncensored", uncensored);

// ─── Release Year ─────────────────────────────────────────────────────────────
// GET /api/release/:year
// GET /api/release/:year?page=N
// GET /api/release/:year/:page
app.route("/release", release);

// ─── Search ───────────────────────────────────────────────────────────────────
// GET /api/search?q=keyword
// GET /api/search?q=keyword&page=2
// GET /api/search/:page?q=keyword
app.route("/search", search);

// ─── Title match (for mapping an anime to a source page) ─────────────────────
// GET /api/match?title=overflow&limit=8
app.route("/match", match);

// ─── Calendar ─────────────────────────────────────────────────────────────────
// GET /api/calendar
app.route("/calendar", calendar);

// ─── Genres ───────────────────────────────────────────────────────────────────
// GET /api/genres
app.get("/genres", async (c) => {
  try {
    const data = await scrapeGenreList();
    return c.json({ success: true, data, meta: { scrapedAt: new Date().toISOString() } });
  } catch (err) {
    return c.json({ success: false, error: (err as Error).message }, 500);
  }
});

// GET /api/genre/:slug
// GET /api/genre/:slug?page=N
// GET /api/genre/:slug/:page
app.route("/genre", genre);

// ─── Series (list + detail) ────────────────────────────────────────────────────
// GET /api/series                  → list page 1
// GET /api/series?page=N           → list page N
// GET /api/series/3                → list page 3 (numeric slug)
// GET /api/series/some-slug-id-01  → series detail
app.route("/series", series);

// ─── Watch (episode video page) ───────────────────────────────────────────────
// GET /api/watch?slug=tsuki-kagerou-episode-1-id-01
// GET /api/watch/tsuki-kagerou-episode-1-id-01
app.route("/watch", watch);

// ─── Download (episode download page) ────────────────────────────────────────
// GET /api/download?slug=seikou-senki-pony-celes-episode-1-id-01
// GET /api/download/seikou-senki-pony-celes-episode-1-id-01
app.route("/download", download);

// ─── Extra (site-wide metadata) ───────────────────────────────────────────────
// GET /api/extra  → logo, menu, genres, years, popular, new, footer
app.route("/extra", extra);

// ─── Health ───────────────────────────────────────────────────────────────────
app.get("/health", (c) =>
  c.json({
    success: true,
    status: "ok",
    auth: configuredApiKey() ? "api-key" : "unconfigured",
    rateLimitPerMinute: Number(process.env.RATE_LIMIT_PER_MIN || 120),
    timestamp: new Date().toISOString(),
  })
);

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.notFound((c) =>
  c.json(
    {
      success: false,
      error: "Route not found",
      available: [
        "GET /api/home",
        "GET /api/trending",
        "GET /api/trending?page=N",
        "GET /api/trending/:page",
        "GET /api/videos",
        "GET /api/videos?page=N",
        "GET /api/videos/:page",
        "GET /api/uncensored",
        "GET /api/uncensored?page=N",
        "GET /api/uncensored/:page",
        "GET /api/search?q=keyword",
        "GET /api/search?q=keyword&page=N",
        "GET /api/search/:page?q=keyword",
        "GET /api/calendar",
        "GET /api/release/:year",
        "GET /api/release/:year?page=N",
        "GET /api/release/:year/:page",
        "GET /api/genre/:slug",
        "GET /api/genre/:slug?page=N",
        "GET /api/genre/:slug/:page",
        "GET /api/series",
        "GET /api/series?page=N",
        "GET /api/series/:page",
        "GET /api/series/:slug",
        "GET /api/watch?slug=episode-slug",
        "GET /api/watch/:slug",
        "GET /api/download?slug=episode-slug",
        "GET /api/download/:slug",
        "GET /api/extra",
        "GET /api/search?q=:query&page=1",
        "GET /api/match?title=:title&limit=8",
        "GET /api/health",
      ],
    },
    404
  )
);

export default app;
