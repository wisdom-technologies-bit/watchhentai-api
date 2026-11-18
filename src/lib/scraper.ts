import { config } from "../config";
import {
  cleanText,
  normalizeThumbnail,
  parseRelativeTime,
  parseViewCount,
  resolveUrl,
  type EpisodeItem,
  type SeriesItem,
  type SliderItem,
} from "./format";

// ═══════════════════════════════════════════════════════════════════════════════
// Fetch
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch any page — accepts both relative paths ("/series/") and full URLs.
 * Full URLs are used when fetching embedded player pages (jwplayer iframe src).
 */
export async function fetchPage(path: string = "/"): Promise<string> {
  const url = path.startsWith("http") ? path : `${config.baseUrl}${path}`;
  const res = await fetch(url, {
    headers: config.defaultHeaders,
    signal: AbortSignal.timeout(config.timeout),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to fetch ${url}`);
  return res.text();
}

// ═══════════════════════════════════════════════════════════════════════════════
// HtmlDoc — lightweight DOM-like helper (regex-based)
// ═══════════════════════════════════════════════════════════════════════════════

export class HtmlDoc {
  constructor(public html: string) {}

  /** Extract all top-level blocks of a given tag */
  private blocks(tag: string, html = this.html): string[] {
    const results: string[] = [];
    const openRe = new RegExp(`<${tag}(?:\\s[^>]*)?>`, "gi");
    const closeTag = `</${tag}>`;
    let match: RegExpExecArray | null;
    while ((match = openRe.exec(html)) !== null) {
      const start = match.index;
      const closeIdx = html
        .toLowerCase()
        .indexOf(closeTag.toLowerCase(), start + match[0].length);
      if (closeIdx === -1) {
        results.push(match[0]);
        continue;
      }
      results.push(html.slice(start, closeIdx + closeTag.length));
    }
    return results;
  }

  /** All <article> blocks as HtmlDoc instances */
  articles(): HtmlDoc[] {
    return this.blocks("article").map((h) => new HtmlDoc(h));
  }

  /** First value of `attribute` on the first `tag` element */
  attr(tag: string, attribute: string, html = this.html): string {
    const re = new RegExp(`<${tag}(?:\\s[^>]*)?>`, "i");
    const m = html.match(re);
    if (!m) return "";
    const attrRe = new RegExp(`${attribute}=["']([^"']*?)["']`, "i");
    const am = m[0].match(attrRe);
    return am ? am[1] : "";
  }

  /** All values of `attribute` on every `tag` element */
  attrs(tag: string, attribute: string): string[] {
    const re = new RegExp(`<${tag}(?:\\s[^>]*)?>`, "gi");
    const results: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.html)) !== null) {
      const attrRe = new RegExp(`${attribute}=["']([^"']*?)["']`, "i");
      const am = m[0].match(attrRe);
      if (am) results.push(am[1]);
    }
    return results;
  }

  /** Strip all tags and return clean text */
  text(html = this.html): string {
    return cleanText(html.replace(/<[^>]+>/g, " "));
  }

  /** Inner text of first matching tag */
  tagText(tag: string): string {
    const re = new RegExp(
      `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,
      "i"
    );
    const m = this.html.match(re);
    return m ? this.text(m[1]) : "";
  }

  /** Narrow to the element with the given id */
  byId(id: string): HtmlDoc {
    const re = new RegExp(`id=["']${id}["']`, "i");
    const idMatch = this.html.match(re);
    if (!idMatch) return new HtmlDoc("");
    const start = this.html.lastIndexOf("<", idMatch.index!);
    const tagMatch = this.html.slice(start).match(/^<(\w+)/);
    if (!tagMatch) return new HtmlDoc(this.html.slice(start));
    const tag = tagMatch[1];
    const blocks = this.blocks(tag, this.html.slice(start));
    return new HtmlDoc(blocks[0] ?? "");
  }

  /** All href values */
  hrefs(): string[] {
    return this.attrs("a", "href").filter(Boolean);
  }

  /** Simple string-contains check */
  contains(text: string): boolean {
    return this.html.includes(text);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Unwrap a timthumb/PHP resizer URL to the real underlying CDN URL.
 *
 * Handles all variants used by the site:
 *   /timthumb/backdrop.php?src=https://watchhentai.net/uploads/.../backdrop1.jpg
 *   /timthumb/thumb.php?src=https://watchhentai.net/uploads/.../poster.jpg
 *   /timthumb/sidebar.php?src=https://watchhentai.net/uploads/.../poster.jpg
 *
 * Returns the decoded src= value, or the original string if no src= param found.
 */
function unwrapTimthumb(raw: string): string {
  if (!raw) return "";
  // Match ?src= or &src= (case-insensitive, handles URL-encoded values too)
  const m = raw.match(/[?&]src=([^&]+)/i);
  if (!m) return raw;
  try {
    return decodeURIComponent(m[1]);
  } catch (_) {
    return m[1];
  }
}

/**
 * Extract the real image URL from a lazy-loaded <img> tag string.
 *
 * The site uses:  <img data-lazyloaded="1" src="data:..." data-src="REAL_URL">
 * We always want data-src, never src (which is a placeholder gif).
 * Then we unwrap any timthumb PHP wrapper.
 */
function extractImgUrl(imgTagOrHtml: string): string {
  // Prefer data-src (lazy-loaded real URL)
  const dataSrcM = imgTagOrHtml.match(/\bdata-src=["']([^"']+)["']/i);
  if (dataSrcM) return unwrapTimthumb(dataSrcM[1]);

  // Fall back to src only if it's not a base64 placeholder
  const srcM = imgTagOrHtml.match(/\bsrc=["']([^"']+)["']/i);
  if (srcM && !srcM[1].startsWith("data:")) return unwrapTimthumb(srcM[1]);

  return "";
}

/**
 * Extract all <article>...</article> blocks from a raw HTML string.
 *
 * Unlike HtmlDoc.articles() / blocks(), this is nesting-aware for <article>:
 * it tracks open/close tags so deeply-nested elements don't cause early
 * termination. Articles themselves don't nest so a simple indexOf scan works,
 * but we also guard against runaway matches.
 */
function extractArticles(html: string): string[] {
  const results: string[] = [];
  const openTag = "<article";
  const closeTag = "</article>";
  let pos = 0;

  while (pos < html.length) {
    const start = html.toLowerCase().indexOf(openTag.toLowerCase(), pos);
    if (start === -1) break;

    const end = html.toLowerCase().indexOf(closeTag.toLowerCase(), start);
    if (end === -1) break;

    results.push(html.slice(start, end + closeTag.length));
    pos = end + closeTag.length;
  }

  return results;
}

/**
 * Extract the HTML content between two string markers (inclusive of outer wrapper).
 *
 * Used instead of byId() because byId() relies on blocks() which is NOT
 * nesting-aware for <div> — it finds the FIRST </div> after the opening tag,
 * not the matching one. Since slider/section divs contain many nested divs,
 * byId() returns a truncated fragment that contains zero articles.
 *
 * Strategy: find the opening marker (e.g. `id="slider-movies-tvshows"`),
 * then capture everything up to but not including the next section boundary
 * (e.g. `<header` or another known landmark tag).
 */
function extractSectionByIdToNextHeader(
  html: string,
  id: string
): string {
  // Find where this id attribute appears
  const idPattern = new RegExp(`id=["']${id}["']`, "i");
  const idMatch = html.match(idPattern);
  if (!idMatch || idMatch.index === undefined) return "";

  // Walk back to find the opening tag of this element
  const openStart = html.lastIndexOf("<", idMatch.index);
  if (openStart === -1) return "";

  // Slice from the opening tag forward
  const fromHere = html.slice(openStart);

  // Find the end boundary: the next <header or next section with another id=""
  // For the slider, the section ends at the first <header> after it.
  // We use a generous boundary so we don't cut off mid-article.
  const endPatterns = [
    /<header[\s>]/i,
    /<div[^>]+class="[^"]*animation-2[^"]*"/i,
  ];

  let endIdx = fromHere.length;
  for (const pat of endPatterns) {
    const m = fromHere.match(pat);
    if (m && m.index !== undefined && m.index > 0 && m.index < endIdx) {
      endIdx = m.index;
    }
  }

  return fromHere.slice(0, endIdx);
}

/**
 * Extract a named section that starts at `id="sectionId"` and ends before
 * the next section marker.
 *
 * For home page genre sections like dt-tvshows, genre_uncensored etc.
 * The end boundary is either the next <header> or the next id= attribute
 * that looks like another section.
 */
function extractSectionById(html: string, id: string): string {
  const idPattern = new RegExp(`id=["']${id}["']`, "i");
  const idMatch = html.match(idPattern);
  if (!idMatch || idMatch.index === undefined) return "";

  const openStart = html.lastIndexOf("<", idMatch.index);
  if (openStart === -1) return "";

  const fromHere = html.slice(openStart);

  // End at next <header or next known section container
  const endM = fromHere.match(/<header[\s>]/i);
  const endIdx = endM && endM.index ? endM.index : fromHere.length;

  return fromHere.slice(0, endIdx);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Shared parsers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Parse the home-page slider (#slider-movies-tvshows).
 *
 * ROOT CAUSE OF EMPTY RESULTS:
 *   byId() uses blocks("div", ...) to find the enclosing div. blocks() is NOT
 *   nesting-aware — it finds the FIRST </div> after the opening <div ...>, which
 *   is the closing tag of the FIRST nested child div inside the article. So the
 *   returned HtmlDoc contains only a partial fragment with zero <article> tags.
 *
 * FIX:
 *   1. Use extractSectionByIdToNextHeader() to grab everything from the slider
 *      opening tag up to the first <header> that follows it. This range always
 *      contains all the slider <article> blocks.
 *   2. Use extractArticles() (simple indexOf scan) instead of blocks("article")
 *      since articles don't nest and indexOf is reliable here.
 *   3. For each article, extract fields directly via regex on the raw HTML:
 *      - data-src (not src) for the image → unwrap timthumb
 *      - first href for the series URL
 *      - <h3 ...> inner text for the title (with class="title" support)
 *      - <span> text for the year/date label
 */
export function parseSlider(doc: HtmlDoc): SliderItem[] {
  // Get the slider HTML section without relying on nesting-aware block parsing
  const sliderSection = extractSectionByIdToNextHeader(
    doc.html,
    "slider-movies-tvshows"
  );

  if (!sliderSection) return [];

  // Extract all <article> blocks within this section
  const articleBlocks = extractArticles(sliderSection);

  return articleBlocks.map((artHtml) => {
    // Post ID from article[id="post-XXXXX"]
    const idM = artHtml.match(/\bid=["']post-(\d+)["']/i);
    const id = idM ? idM[1] : "";

    // Series URL — first <a href="..."> in the article
    const hrefM = artHtml.match(/<a\s[^>]*\bhref=["']([^"']+)["']/i);
    const href = hrefM ? hrefM[1] : "";

    // Title — <h3 ...>TEXT</h3>  (may have class="title")
    const h3M = artHtml.match(/<h3(?:\s[^>]*)?>([^<]+)<\/h3>/i);
    let title = h3M ? cleanText(h3M[1]) : "";

    // Fall back to img[alt] if h3 is empty
    if (!title) {
      const altM = artHtml.match(/\balt=["']([^"']+)["']/i);
      title = altM ? cleanText(altM[1]) : "";
    }

    // Fall back to img[title] attribute
    if (!title) {
      const titleAttrM = artHtml.match(/\btitle=["']([^"']+)["']/i);
      title = titleAttrM ? cleanText(titleAttrM[1]) : "";
    }

    // Backdrop image — always use data-src (never src which is a placeholder gif)
    // then unwrap the timthumb URL to get the real CDN URL
    const backdrop = extractImgUrl(artHtml);

    // Year/date — <span>TEXT</span> inside the .data div
    const spanM = artHtml.match(/<span[^>]*>([^<]+)<\/span>/i);
    const year = spanM ? cleanText(spanM[1]) : "";

    return {
      id,
      title,
      url: resolveUrl(href),
      backdrop,
      year,
    };
  });
}

export function parseEpisodes(doc: HtmlDoc): EpisodeItem[] {
  // Current markup: every recent episode is an <a class="ep-bd-link"> whose title
  // carries "Series – Episode N", sitting over a thumbnail and a SUB/DUB badge.
  // The old `animation-2 items full` list this parser read is gone.
  const html = doc.html;
  const out: EpisodeItem[] = [];
  const linkRe = /<a class="ep-bd-link" href="([^"]+)" title="([^"]*)"><\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    const href = m[1];
    const fullTitle = cleanText(decodeBasicEntities(m[2]));
    if (!fullTitle) continue;
    const windowHtml = html.slice(Math.max(0, m.index - 1500), m.index);
    const thumb =
      windowHtml.match(/<img[^>]+class="ep-bd-base"[^>]+src="([^"]+)"/i)?.[1] ??
      windowHtml.match(/<img[^>]+src="([^"]+\/uploads\/[^"]+)"/i)?.[1] ??
      "";
    const badge = windowHtml.match(/<span[^>]*>\s*(SUB|DUB)\s*<\/span>/i)?.[1]?.toUpperCase();
    const parts = fullTitle.split(/\s*[–-]\s*/);
    const episode = parts.length > 1 ? parts.slice(1).join(" - ").trim() : "";
    out.push({
      id: href.match(/postid-(\d+)/)?.[1] ?? "",
      title: fullTitle,
      series: (parts[0] ?? fullTitle).trim(),
      episode,
      url: resolveUrl(href),
      thumbnail: normalizeThumbnail(thumb),
      subType: badge ?? (/\bdub\b/i.test(fullTitle) ? "DUB" : "SUB"),
      censored: /uncensored/i.test(fullTitle + href) ? false : true,
      views: 0,
      uploadedAt: "",
      uploadedAtRaw: "",
    });
  }
  return out;
}

/** The few entities the listing markup actually uses. */
function decodeBasicEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export function parseSeriesSection(
  sectionHtml: string,
  sectionId: string
): SeriesItem[] {
  const startRe = new RegExp(`id=["']${sectionId}["']`, "i");
  const idx = sectionHtml.search(startRe);
  if (idx === -1) return [];
  const fromHere = sectionHtml.slice(idx);
  const doc = new HtmlDoc(fromHere);
  return doc.articles().map((art) => {
    const id = art.attr("article", "id").replace("post-", "");
    const href = art.attr("a", "href");
    const title = art.tagText("h3") || art.attr("img", "alt");
    const poster = art.attr("img", "data-src");
    const yearMatch = art.html.match(/buttonyear[^>]*>.*?(\d{4})/s);
    const year = yearMatch ? yearMatch[1] : "";
    const censored = !art.html.includes("buttonuncensured");
    return {
      id,
      title: cleanText(title),
      url: resolveUrl(href),
      poster: normalizeThumbnail(poster),
      year,
      censored,
    };
  });
}

export function parseHomeSections(
  doc: HtmlDoc
): Record<string, SeriesItem[]> {
  const sectionIds = [
    { id: "dt-tvshows",          name: "featured_series" },
    { id: "genre_uncensored",    name: "uncensored"      },
    { id: "genre_harem",         name: "harem"           },
    { id: "genre_school-girls",  name: "school_girls"    },
    { id: "genre_large-breasts", name: "large_breasts"   },
  ];
  const result: Record<string, SeriesItem[]> = {};
  for (const { id, name } of sectionIds) {
    result[name] = parseSeriesSection(doc.html, id);
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Player page scraper
// ═══════════════════════════════════════════════════════════════════════════════

export interface VideoSource {
  src: string;
  type: string;
  label: string;
}

export interface PlayerPageData {
  sources: VideoSource[];
  defaultSrc: string;
  thumbnail: string;
  duration: string;
  downloadUrl: string;
}

function cleanUrl(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/&amp;/g, "&"));
  } catch (_) {
    return raw.replace(/&amp;/g, "&");
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// Media URL decoding
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The player page no longer ships a readable `?source=` URL. Sources arrive in
 * `var whJwSources = [...]` with each `file` obfuscated by this exact routine
 * (copied from the page, so it stays faithful):
 *
 *   s = s.replace(/-/g,"+").replace(/_/g,"/"); pad to %4; atob
 *   xor each byte with (13 + i % 17); reverse; atob
 *
 * A value that is already an http(s) URL is returned untouched, so this is safe
 * to call on every source.
 */
export function decodeMediaUrl(encoded: string): string {
  if (!encoded || /^https?:\/\//i.test(encoded)) return encoded;
  try {
    const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const raw = Buffer.from(padded, "base64");
    let xored = "";
    for (let i = 0; i < raw.length; i++) {
      xored += String.fromCharCode(raw[i] ^ ((13 + (i % 17)) & 255));
    }
    const reversed = xored.split("").reverse().join("");
    const decoded = Buffer.from(reversed, "base64").toString("utf8");
    return /^https?:\/\//i.test(decoded) ? decoded : encoded;
  } catch {
    return encoded;
  }
}

export async function scrapePlayerPage(
  playerUrl: string
): Promise<PlayerPageData> {
  const clean = playerUrl.replace(/&amp;/g, "&");
  const html  = await fetchPage(clean);

  let defaultSrc = "";
  let thumbnail  = "";

  const jwMatch = html.match(/var\s+jw\s*=\s*(\{[\s\S]*?\})\s*(?:<\/script>|;)/);
  if (jwMatch) {
    const fileM  = jwMatch[1].match(/"file"\s*:\s*"([^"]+)"/);
    const imageM = jwMatch[1].match(/"image"\s*:\s*"([^"]+)"/);
    if (fileM)  defaultSrc = cleanUrl(fileM[1].replace(/\\\//g, "/"));
    if (imageM) thumbnail  = cleanUrl(imageM[1].replace(/\\\//g, "/"));
  }

  let duration = "";
  const schemaMatch = html.match(
    /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i
  );
  if (schemaMatch) {
    try {
      const schema = JSON.parse(schemaMatch[1].trim());
      if (!defaultSrc && schema.contentUrl)   defaultSrc = schema.contentUrl;
      if (!thumbnail  && schema.thumbnailUrl)  thumbnail  = schema.thumbnailUrl;
      if (schema.duration)                    duration   = schema.duration;
    } catch (_) {
      const durM = schemaMatch[1].match(/"duration"\s*:\s*"([^"]+)"/);
      const cuM  = schemaMatch[1].match(/"contentUrl"\s*:\s*"([^"]+)"/);
      const thM  = schemaMatch[1].match(/"thumbnailUrl"\s*:\s*"([^"]+)"/);
      if (durM)           duration   = durM[1];
      if (cuM && !defaultSrc) defaultSrc = cuM[1];
      if (thM && !thumbnail)  thumbnail  = thM[1];
    }
  }

  // The current player page declares its sources up front as `whJwSources`;
  // `sources: [...]` inside the jwplayer setup is only a reference to it.
  const sources: VideoSource[] = [];
  const whSourcesM = html.match(/var\s+whJwSources\s*=\s*(\[[\s\S]*?\]);/);
  if (whSourcesM) {
    try {
      const parsed = JSON.parse(whSourcesM[1].replace(/\\\//g, "/")) as Array<{
        file?: string; type?: string; label?: string;
      }>;
      for (const entry of parsed) {
        if (!entry?.file) continue;
        sources.push({
          src:   decodeMediaUrl(entry.file),
          type:  entry.type ?? "video/mp4",
          label: entry.label ?? "default",
        });
      }
    } catch (_) { /* fall through to the legacy block below */ }
  }

  const sourcesBlockM = sources.length === 0 ? html.match(/sources\s*:\s*\[([\s\S]*?)\]/) : null;
  if (sourcesBlockM) {
    const entryRe = /\{([\s\S]*?)\}/g;
    let em: RegExpExecArray | null;
    while ((em = entryRe.exec(sourcesBlockM[1])) !== null) {
      const entry  = em[1];
      const fileM  = entry.match(/["']?file["']?\s*:\s*["']([^"']+)["']/);
      const typeM  = entry.match(/["']?type["']?\s*:\s*["']([^"']+)["']/);
      const labelM = entry.match(/["']?label["']?\s*:\s*["']([^"']+)["']/);
      if (fileM) {
        sources.push({
          src:   decodeMediaUrl(cleanUrl(fileM[1].replace(/\\\//g, "/"))),
          type:  typeM  ? typeM[1]  : "video/mp4",
          label: labelM ? labelM[1] : "default",
        });
      }
    }
  }

  if (sources.length === 0 && defaultSrc) {
    const labelGuess = defaultSrc.match(/_(\d+p)\./)?.[1] ?? "default";
    sources.push({ src: defaultSrc, type: "video/mp4", label: labelGuess });
  }

  const dlM = html.match(
    /window\.open\('(https:\/\/watchhentai\.net\/download\/[^']+)'\)/i
  );
  const downloadUrl = dlM ? dlM[1] : "";

  return { sources, defaultSrc, thumbnail, duration, downloadUrl };
}

// ═══════════════════════════════════════════════════════════════════════════════
// High-level scrape functions
// ═══════════════════════════════════════════════════════════════════════════════

export async function scrapeHome() {
  const html = await fetchPage("/");
  const doc  = new HtmlDoc(html);
  return {
    slider:         parseSlider(doc),
    recentEpisodes: parseEpisodes(doc),
    sections:       parseHomeSections(doc),
  };
}

export async function scrapeSeries(slug: string) {
  const html  = await fetchPage(`/series/${slug}/`);
  const doc   = new HtmlDoc(html);
  const title = cleanText(doc.tagText("h1") || doc.tagText("h2"));
  const descMatch = html.match(
    /<div[^>]*class="[^"]*wp-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i
  );
  const description = descMatch ? doc.text(descMatch[1]) : "";
  const posterMatch = html.match(
    /class="[^"]*poster[^"]*"[\s\S]*?data-src="([^"]+)"/i
  );
  const poster = posterMatch ? normalizeThumbnail(posterMatch[1]) : "";
  const epSection = new HtmlDoc(html);
  const episodes = epSection
    .articles()
    .filter((a) => a.html.includes("episode") || a.html.includes("Episode"))
    .map((art) => ({
      title:     cleanText(art.tagText("h3")),
      url:       resolveUrl(art.attr("a", "href")),
      thumbnail: normalizeThumbnail(art.attr("img", "data-src")),
    }));
  return { title, description, poster, episodes };
}

export async function scrapeGenre(genre: string, page = 1) {
  const path = page > 1 ? `/genre/${genre}/page/${page}/` : `/genre/${genre}/`;
  const html = await fetchPage(path);
  const doc  = new HtmlDoc(html);
  const items = doc.articles().map((art) => ({
    id:    art.attr("article", "id").replace("post-", ""),
    title: cleanText(art.tagText("h3") || art.attr("img", "alt")),
    url:   resolveUrl(art.attr("a", "href")),
    poster: normalizeThumbnail(art.attr("img", "data-src")),
    year:  (art.html.match(/buttonyear[^>]*>.*?(\d{4})/s) ?? [])[1] ?? "",
  }));
  return { genre, page, items };
}

export async function scrapeSearch(query: string, page = 1) {
  const params = new URLSearchParams({ s: query });
  const path   = page > 1 ? `/page/${page}/?${params}` : `/?${params}`;
  const html   = await fetchPage(path);
  const doc    = new HtmlDoc(html);
  const results = doc.articles().map((art) => ({
    id:    art.attr("article", "id").replace("post-", ""),
    title: cleanText(art.tagText("h3") || art.attr("img", "alt")),
    url:   resolveUrl(art.attr("a", "href")),
    poster: normalizeThumbnail(art.attr("img", "data-src")),
  }));
  return { query, page, results };
}

export async function scrapeTrending() {
  const html = await fetchPage("/trending/");
  const doc  = new HtmlDoc(html);
  return doc.articles().map((art) => ({
    id:    art.attr("article", "id").replace("post-", ""),
    title: cleanText(art.tagText("h3") || art.attr("img", "alt")),
    url:   resolveUrl(art.attr("a", "href")),
    poster: normalizeThumbnail(art.attr("img", "data-src")),
    year:  (art.html.match(/buttonyear[^>]*>.*?(\d{4})/s) ?? [])[1] ?? "",
  }));
}

export async function scrapeGenreList() {
  const html     = await fetchPage("/");
  const navMatch = html.match(/<ul[^>]*class="sub-menu"[^>]*>([\s\S]*?)<\/ul>/i);
  if (!navMatch) return [];
  const doc    = new HtmlDoc(navMatch[1]);
  const links  = doc.hrefs();
  const titles = doc.attrs("a", "title");
  const texts  = navMatch[1].match(/<a[^>]*>([^<]+)<\/a>/gi) ?? [];
  return links.map((href, i) => ({
    name:  cleanText(texts[i]?.replace(/<[^>]+>/g, "") ?? ""),
    title: cleanText(titles[i] ?? ""),
    slug:  href.replace(/.*\/genre\//, "").replace(/\/$/, ""),
    url:   resolveUrl(href),
  }));
}
