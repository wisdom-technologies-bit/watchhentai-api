import { Hono } from "hono";
import { fetchPage } from "../../lib/scraper";
import { cleanText, resolveUrl } from "../../lib/format";

const search = new Hono();

// ─── types ────────────────────────────────────────────────────────────────────

interface SearchResult {
  title: string;
  url: string;
  poster: string;
  year: string;
  description: string;
}

interface SearchPagination {
  currentPage: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
  nextPage: number | null;
  prevPage: number | null;
}

// ─── parser ───────────────────────────────────────────────────────────────────

function parseSearchHtml(html: string, query: string, page: number) {
  // Current markup: each hit is a card with <div class="poster"> … <div class="data">
  // holding an <h3><a href title>, a data-src poster and a <span class="year">.
  // The `.search-page` / `.result-item` shape this parser expected is gone.
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  // Each hit is an <h3><a href title>, with the poster just above it in the same
  // card and the year just below. Anchoring on the heading is what survives a
  // theme change, because the wrapper class names do not.
  const linkRe = /<h3>\s*<a href="([^"]+)"([^>]*)>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    const url = resolveUrl(m[1]);
    const title = cleanText(m[3].replace(/<[^>]+>/g, " ")) || cleanText(m[2].match(/title="([^"]*)"/)?.[1] ?? "");
    if (!url || !title || seen.has(url)) continue;

    const before = html.slice(Math.max(0, m.index - 1400), m.index);
    const after = html.slice(m.index, m.index + 700);
    const poster =
      before.match(/data-src="([^"]+\/uploads\/[^"]+)"/i)?.[1] ??
      before.match(/src="([^"]+\/uploads\/[^"]+)"/i)?.[1] ??
      "";
    const year = after.match(/class="year"[^>]*>\s*(\d{4})/i)?.[1] ?? "";
    const description = cleanText(
      (after.match(/<div class="contenido">([\s\S]*?)<\/div>/i)?.[1] ?? "").replace(/<[^>]+>/g, " ")
    );

    seen.add(url);
    results.push({ title, url, poster, year, description });
  }

  // Pagination — "Page X of Y" wherever the theme renders it.
  const pagMatch = html.match(/Page\s+(\d+)\s+of\s+(\d+)/i);
  const currentPage = pagMatch ? parseInt(pagMatch[1], 10) : page;
  const totalPages = pagMatch ? parseInt(pagMatch[2], 10) : 1;

  const pagination: SearchPagination = {
    currentPage,
    totalPages,
    hasNext: currentPage < totalPages,
    hasPrev: currentPage > 1,
    nextPage: currentPage < totalPages ? currentPage + 1 : null,
    prevPage: currentPage > 1 ? currentPage - 1 : null,
  };

  return { query, results, pagination };
}

// ─── handler ──────────────────────────────────────────────────────────────────

async function handleSearch(c: any) {
  // ?q=... or ?s=... (both supported for convenience)
  const query = (c.req.query("q") || c.req.query("s") || "").trim();
  if (!query) {
    return c.json(
      { success: false, error: "Missing search query. Use ?q=your+query" },
      400
    );
  }

  // Page number: path param takes priority, then query param
  const pathPage = c.req.param("page");
  const queryPage = c.req.query("page");
  const page = Math.max(
    1,
    parseInt(pathPage || queryPage || "1", 10) || 1
  );

  // Build the URL the site expects:
  // page 1  → /?s=query
  // page N  → /page/N/?s=query
  const encodedQuery = encodeURIComponent(query);
  const path =
    page === 1 ? `/?s=${encodedQuery}` : `/page/${page}/?s=${encodedQuery}`;

  try {
    const html = await fetchPage(path);
    const data = parseSearchHtml(html, query, page);

    return c.json({
      success: true,
      data,
      meta: {
        scrapedAt: new Date().toISOString(),
        source: `https://watchhentai.net${path}`,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.json({ success: false, error: message }, 500);
  }
}

// ─── routes ───────────────────────────────────────────────────────────────────

// GET /api/search?q=keyword
// GET /api/search?q=keyword&page=2
// GET /api/search/:page?q=keyword
search.get("/", async (c) => handleSearch(c));
search.get("/:page", async (c) => handleSearch(c));

export default search;
