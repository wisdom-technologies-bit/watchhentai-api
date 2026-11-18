import { describe, expect, it } from "bun:test";
import { detectVariant } from "../src/lib/variant";

describe("censored or uncensored", () => {
  it("trusts the genre list first", () => {
    expect(detectVariant({ genres: ["Drama", "Uncensored"] })).toBe("uncensored");
    expect(detectVariant({ genres: [{ name: "Censored" }] })).toBe("censored");
  });

  it("reads the wording when the page carries no genre", () => {
    expect(detectVariant({ title: "Arisugawa Ren – Episode 1 Uncensored" })).toBe("uncensored");
    expect(detectVariant({ slug: "some-title-uncensored-id-01" })).toBe("uncensored");
  });

  it("does not mistake uncensored for censored", () => {
    expect(detectVariant({ title: "Some Show Uncensored" })).toBe("uncensored");
    expect(detectVariant({ title: "Some Show Censored" })).toBe("censored");
  });

  it("stays unknown rather than guessing", () => {
    expect(detectVariant({ title: "Hitori Tsuma" })).toBe("unknown");
    expect(detectVariant({})).toBe("unknown");
  });
});
