import { describe, expect, it } from "vitest";
import { extractApiKey, generateApiKey, hashApiKey, parseApiKey, safeEqualHex } from "./api-keys";

const PEPPER = "test-pepper-0123456789abcdef";

describe("clés API", () => {
  it("génère une clé au format attendu, jamais deux fois la même", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.key).toMatch(/^rdk_live_[a-z0-9]{8}_[A-Za-z0-9]{32}$/);
    expect(a.key.startsWith(a.prefix)).toBe(true);
    expect(a.key).not.toBe(b.key);
  });
  it("hash HMAC stable, dépendant du poivre, comparaison à temps constant", () => {
    const { key } = generateApiKey();
    const h1 = hashApiKey(key, PEPPER);
    expect(h1).toHaveLength(64);
    expect(hashApiKey(key, PEPPER)).toBe(h1);
    expect(hashApiKey(key, PEPPER + "x")).not.toBe(h1);
    expect(safeEqualHex(h1, hashApiKey(key, PEPPER))).toBe(true);
    expect(safeEqualHex(h1, hashApiKey(key + "x", PEPPER))).toBe(false);
  });
  it("refuse un poivre trop court et les clés mal formées", () => {
    expect(() => hashApiKey("x", "short")).toThrow();
    expect(parseApiKey("rdk_live_abc_def")).toBeNull();
    expect(parseApiKey("Bearer x")).toBeNull();
    const { key, prefix } = generateApiKey("test");
    expect(parseApiKey(` ${key} `)).toEqual({ key, prefix });
  });
  it("lit Authorization: Bearer ou X-API-Key", () => {
    expect(extractApiKey(new Headers({ authorization: "Bearer abc" }))).toBe("abc");
    expect(extractApiKey(new Headers({ "x-api-key": "xyz" }))).toBe("xyz");
  });
});
