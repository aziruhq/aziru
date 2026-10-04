import { describe, it, expect, beforeEach } from "vitest";
import { extensionTokenStore, type StoredTokens } from "./tokenStore";
import { resetChromeStorage } from "../test-setup";

const TOKENS: StoredTokens = {
  accessToken: "a1",
  refreshToken: "r1",
  refreshTokenExpiresAt: "2030-01-01T00:00:00.000Z",
};

beforeEach(() => resetChromeStorage());

describe("extensionTokenStore", () => {
  it("returns null when nothing is stored", async () => {
    expect(await extensionTokenStore.get()).toBeNull();
  });

  it("round-trips a token pair through chrome.storage.local", async () => {
    await extensionTokenStore.set(TOKENS);
    expect(await extensionTokenStore.get()).toEqual(TOKENS);
  });

  it("clears the stored pair", async () => {
    await extensionTokenStore.set(TOKENS);
    await extensionTokenStore.clear();
    expect(await extensionTokenStore.get()).toBeNull();
  });

  it("returns null for malformed JSON", async () => {
    await chrome.storage.local.set({ "aziru.auth.tokens": "{not json" });
    expect(await extensionTokenStore.get()).toBeNull();
  });

  it("returns null when required fields are missing", async () => {
    await chrome.storage.local.set({
      "aziru.auth.tokens": JSON.stringify({ accessToken: "a1" }),
    });
    expect(await extensionTokenStore.get()).toBeNull();
  });
});
