/**
 * Censored or uncensored.
 *
 * The badge divs the first version looked for are absent on many pages now, but
 * the genre list always names it and the title or slug usually does too:
 * uncensored releases carry an "Uncensored" genre, censored ones "Censored".
 * Precedence: an explicit genre, then the badge, then the wording.
 */
export type Variant = "censored" | "uncensored" | "unknown";

type Genre = string | { name?: string | null };

export function detectVariant(input: {
  genres?: Genre[] | null;
  title?: string | null;
  slug?: string | null;
  url?: string | null;
  html?: string | null;
} = {}): Variant {
  const names = (input.genres ?? [])
    .map((g) => (typeof g === "string" ? g : g?.name ?? ""))
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean);

  if (names.includes("uncensored")) return "uncensored";
  if (names.includes("censored")) return "censored";

  const html = input.html ?? "";
  if (/buttonuncensured/i.test(html)) return "uncensored";
  if (/buttoncensured/i.test(html)) return "censored";

  const text = `${input.title ?? ""} ${input.slug ?? ""} ${input.url ?? ""}`.toLowerCase();
  if (/\buncensored\b/.test(text)) return "uncensored";
  // "uncensored" contains "censored", so only test for the bare word.
  if (/\bcensored\b/.test(text.replace(/\buncensored\b/g, " "))) return "censored";

  return "unknown";
}
