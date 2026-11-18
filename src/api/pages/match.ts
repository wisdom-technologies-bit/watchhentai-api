import { Hono } from "hono";
import { scrapeSearch } from "../../lib/scraper";
import { detectVariant } from "../../lib/variant";

/**
 * Title to candidates, for the mapping step.
 *
 * Deliberately narrow: it searches the source and ranks what came back. It does
 * not fetch each series page, so one call is one upstream request. Once a
 * candidate is chosen, `/api/series/:slug` has the episodes.
 */

export type Variant = "censored" | "uncensored" | "unknown";

export type Candidate = {
  title: string;
  slug: string;
  url: string;
  poster: string;
  variant: Variant;
  score: number;
};

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&[a-z]+;/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * 1 for the same title, then progressively weaker matches, 0 when the query and
 * the candidate share nothing.
 */
export function scoreTitle(candidate: string, query: string): number {
  const a = normalize(candidate);
  const b = normalize(query);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const stripped = a.replace(/\b(uncensored|censored|sub|dub)\b/g, "").replace(/\s+/g, " ").trim();
  if (stripped === b) return 0.97;
  if (a.startsWith(b) || stripped.startsWith(b)) return 0.9;
  if (a.includes(b) || stripped.includes(b)) return 0.75;

  const queryTokens = new Set(b.split(" ").filter((t) => t.length > 2));
  if (queryTokens.size === 0) return 0;
  const candidateTokens = new Set(stripped.split(" ").filter((t) => t.length > 2));
  let shared = 0;
  for (const token of queryTokens) if (candidateTokens.has(token)) shared += 1;
  const coverage = shared / queryTokens.size;
  return coverage >= 0.5 ? 0.4 + 0.3 * coverage : 0;
}

/**
 * Only ever claims "uncensored" when the source says so. An unmarked title is
 * `unknown`, never a guess at "censored".
 */
export function variantHint(value: string): Variant {
  return detectVariant({ title: value });
}

function slugOf(url: string): string {
  return url.replace(/\/+$/, "").split("/").pop() ?? "";
}

const match = new Hono();

// GET /api/match?title=overflow&limit=8
match.get("/", async (c) => {
  const title = (c.req.query("title") || c.req.query("q") || "").trim();
  if (!title) {
    return c.json({ success: false, error: "TITLE_REQUIRED", message: "Pass ?title=" }, 400);
  }
  const rawLimit = Number(c.req.query("limit") ?? 8);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 20) : 8;

  try {
    const results = await scrapeSearch(title, 1);
    const candidates: Candidate[] = (results.results as Array<{ title: string; url: string; poster?: string }>)
      .map((item) => {
        const slug = slugOf(item.url);
        return {
          title: item.title,
          slug,
          url: item.url,
          poster: item.poster ?? "",
          variant: variantHint(`${item.title} ${slug}`),
          score: Number(scoreTitle(item.title, title).toFixed(2)),
        };
      })
      .filter((candidate) => candidate.score > 0 && candidate.slug)
      // The listing can repeat a series (censored and uncensored cards share a
      // slug), so collapse to one row per slug, keeping the best score.
      .filter((candidate, index, all) => all.findIndex((other) => other.slug === candidate.slug) === index)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return c.json({
      success: true,
      data: { query: title, candidates },
      meta: { scrapedAt: new Date().toISOString(), source: `https://watchhentai.net/?s=${encodeURIComponent(title)}` },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.json({ success: false, error: message }, 500);
  }
});

export default match;
