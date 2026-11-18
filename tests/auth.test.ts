import { describe, expect, it } from "bun:test";
import { authorize, configuredApiKey, isExemptPath, keysMatch, presentedKey } from "../src/lib/auth";

const req = (path: string, headers: Record<string, string> = {}) =>
  new Request(`https://adult.kumoritv.top/api${path}`, { headers });

describe("api key gate", () => {
  it("reads the key from either env name, trimmed", () => {
    expect(configuredApiKey({ API_KEY: "a".repeat(32) })).toBe("a".repeat(32));
    expect(configuredApiKey({ WATCHHENTAI_API_KEY: "  b  " })).toBe("b");
    expect(configuredApiKey({})).toBeNull();
    expect(configuredApiKey({ API_KEY: "   " })).toBeNull();
  });

  it("leaves health open and closes everything else", () => {
    expect(isExemptPath("/api/health")).toBe(true);
    expect(isExemptPath("/api/search")).toBe(false);
    expect(authorize(req("/health"), {})).toBe("ok");
    expect(authorize(req("/search"), {})).toBe("unconfigured");
  });

  it("rejects a missing or wrong key and accepts the right one", () => {
    const env = { API_KEY: "secret-key-value" };
    expect(authorize(req("/watch/x"), env)).toBe("unauthorized");
    expect(authorize(req("/watch/x", { "x-api-key": "nope" }), env)).toBe("unauthorized");
    expect(authorize(req("/watch/x", { "x-api-key": "secret-key-value" }), env)).toBe("ok");
    expect(authorize(req("/watch/x", { authorization: "Bearer secret-key-value" }), env)).toBe("ok");
    expect(authorize(req("/watch/x?apiKey=secret-key-value"), env)).toBe("ok");
  });

  it("compares without leaking length", () => {
    expect(keysMatch("abc", "abc")).toBe(true);
    expect(keysMatch("abc", "abcd")).toBe(false);
    expect(keysMatch("abc", "ab")).toBe(false);
    expect(keysMatch("", "")).toBe(true);
  });

  it("reads the presented key from all three places", () => {
    expect(presentedKey(req("/x", { "x-api-key": " k " }))).toBe("k");
    expect(presentedKey(req("/x?apiKey=q"))).toBe("q");
    expect(presentedKey(req("/x"))).toBeNull();
  });
});
