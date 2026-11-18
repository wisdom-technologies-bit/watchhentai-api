import { describe, expect, it } from "bun:test";
import { scoreTitle, variantHint } from "../src/api/pages/match";

describe("matching a title to a source candidate", () => {
  it("ranks the same title highest, ignoring case and punctuation", () => {
    expect(scoreTitle("Hitori Tsuma", "hitori tsuma")).toBe(1);
    expect(scoreTitle("Hitori Tsuma!", "hitori tsuma")).toBe(1);
  });

  it("keeps the plain title above its uncensored edition", () => {
    expect(scoreTitle("Hitori Tsuma", "Hitori Tsuma")).toBe(1);
    const uncensored = scoreTitle("Arisugawa Ren Uncensored", "Arisugawa Ren");
    expect(uncensored).toBeGreaterThan(0.7);
    expect(uncensored).toBeLessThan(1);
  });

  it("scores partial and token matches, and nothing for strangers", () => {
    expect(scoreTitle("Hitori Tsuma 2", "hitori tsuma")).toBeGreaterThanOrEqual(0.9);
    expect(scoreTitle("The Hitori Tsuma Story", "hitori tsuma")).toBeGreaterThanOrEqual(0.75);
    expect(scoreTitle("Completely Different Show", "hitori tsuma")).toBe(0);
    expect(scoreTitle("", "hitori")).toBe(0);
  });

  it("only claims uncensored when the source says so", () => {
    expect(variantHint("hitori-tsuma-episode-1-id-01")).toBe("unknown");
    expect(variantHint("series-uncensored-id-01")).toBe("uncensored");
  });
});
