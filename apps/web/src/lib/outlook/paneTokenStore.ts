import type { StoredTokens, TokenStore } from "@aziru/api-client";

// Bearer tokens for the Outlook task pane.
//
// The pane cannot use the web app's own cookie session: inside Outlook it is a
// third-party frame, so the session cookie is partitioned away (and blocked
// outright once third-party cookies are). It therefore authenticates the same
// way the extension and the mobile app do — an access/refresh pair from
// /auth/login, held client-side.
//
// Same storage key and JSON shape as the extension's chrome.storage.local store,
// so the three clients stay recognisably one design. localStorage in an Office
// task pane is partitioned per top-level site, which is the behaviour we want:
// the pane's tokens are not readable by the surrounding Outlook page, and are
// scoped to the Outlook context rather than leaking into the normal web app.

const KEY = "aziru.auth.tokens";

function parse(raw: string | null): StoredTokens | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredTokens>;
    if (!parsed.accessToken || !parsed.refreshToken) return null;
    return parsed as StoredTokens;
  } catch {
    return null;
  }
}

export const paneTokenStore: TokenStore = {
  async get() {
    // Storage access throws in some embedded contexts rather than returning
    // null; a pane that cannot read tokens is signed out, not broken.
    try {
      return parse(window.localStorage.getItem(KEY));
    } catch {
      return null;
    }
  },
  async set(tokens: StoredTokens) {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(tokens));
    } catch {
      // Nothing useful to do: the session simply will not survive a reload.
    }
  },
  async clear() {
    try {
      window.localStorage.removeItem(KEY);
    } catch {
      // Ignore.
    }
  },
};
