import type { StoredTokens, TokenStore } from "@aziru/api-client";
import { ext } from "../platform/ext";

export type { StoredTokens, TokenStore };

const KEY = "aziru.auth.tokens";

// Tokens live in storage.local — scoped to the extension, persists across
// panel open/close and service-worker death (the panel is destroyed when closed,
// so in-memory state cannot be relied on). The whole pair is stored under one
// key as JSON, mirroring the mobile secure-store shape.
export const extensionTokenStore: TokenStore = {
  async get() {
    const out = await ext.storage.local.get(KEY);
    const raw = out[KEY] as string | undefined;
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as StoredTokens;
      if (!parsed.accessToken || !parsed.refreshToken) return null;
      return parsed;
    } catch {
      return null;
    }
  },
  async set(tokens) {
    await ext.storage.local.set({ [KEY]: JSON.stringify(tokens) });
  },
  async clear() {
    await ext.storage.local.remove(KEY);
  },
};
