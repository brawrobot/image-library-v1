import { describe, expect, it } from "vitest";
import { bustHostCache, memoryHostCache } from "../src/tenancy/lookup.ts";

describe("memoryHostCache", () => {
  it("expires entries after their TTL", async () => {
    let now = 0;
    const cache = memoryHostCache(() => now);
    await cache.set("k", "v", 60);
    now = 59_999;
    expect(await cache.get("k")).toBe("v");
    now = 60_000;
    expect(await cache.get("k")).toBeNull();
  });

  it("busts slug and domain keys", async () => {
    const cache = memoryHostCache();
    await cache.set("il:host:slug:acme", "{}", 60);
    await cache.set("il:host:domain:photos.acme.com", "{}", 60);
    await bustHostCache(cache, { slugs: ["acme"], hostnames: ["photos.acme.com"] });
    expect(await cache.get("il:host:slug:acme")).toBeNull();
    expect(await cache.get("il:host:domain:photos.acme.com")).toBeNull();
  });
});
