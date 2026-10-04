import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SessionProvider, useSession } from "./session";
import { resetChromeStorage } from "../test-setup";
import { requestMicrosoftAuth } from "./microsoftAuth";

vi.mock("./microsoftAuth", () => ({
  requestMicrosoftAuth: vi.fn(),
  MicrosoftAuthCancelledError: class MicrosoftAuthCancelledError extends Error {},
}));

// bootstrap() restores a stored session on launch. The invariant under test:
// "signedIn" is asserted ONLY when /auth/me actually succeeds. A failed me() must
// route by cause, not collapse to a single state:
//   - expired/revoked refresh token (tokens cleared by the transport) -> signedOut
//   - transient network error (tokens still present)                  -> error
// The regression this guards: bootstrap used to setStatus("signedIn")
// unconditionally, clobbering the sign-out the transport had just triggered and
// stranding an expired user on the "Connect Gmail" screen instead of sign-in.

const TOKEN_KEY = "aziru.auth.tokens";

// A JWT is decoded (not verified) to read `sub` as the user id. Only the payload
// segment matters; the signature is a placeholder.
function b64url(obj: unknown): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function makeJwt(sub: string): string {
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub })}.sig`;
}

type Res = { ok: boolean; status: number; json: () => Promise<unknown> };
function res(status: number, body: unknown): Res {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// Per-test fetch behaviour, keyed on the request path.
let handler: (url: string, init?: RequestInit) => Promise<Res>;

async function storedTokens(): Promise<unknown> {
  const out = await chrome.storage.local.get(TOKEN_KEY);
  const raw = (out as Record<string, string | undefined>)[TOKEN_KEY];
  return raw ? JSON.parse(raw) : null;
}

const wrapper = ({ children }: { children: ReactNode }) => <SessionProvider>{children}</SessionProvider>;

describe("SessionProvider bootstrap", () => {
  beforeEach(async () => {
    resetChromeStorage();
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => handler(String(url), init)),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function seedTokens(): Promise<void> {
    await chrome.storage.local.set({
      [TOKEN_KEY]: JSON.stringify({
        accessToken: makeJwt("user-1"),
        refreshToken: "ref-1",
        refreshTokenExpiresAt: "2999-01-01T00:00:00.000Z",
      }),
    });
  }

  it("routes an expired/revoked session to signedOut and clears the tokens", async () => {
    await seedTokens();
    // Every authed call 401s and the refresh itself 401s (expired refresh token).
    handler = async () => res(401, { error: "unauthorized" });

    const { result } = renderHook(() => useSession(), { wrapper });

    await waitFor(() => expect(result.current.status).toBe("signedOut"));
    // The transport must have cleared the dead tokens; the user is fully signed out.
    expect(await storedTokens()).toBeNull();
    expect(result.current.userId).toBeNull();
  });

  it("keeps a valid session with no workspace on signedIn (Connect-Gmail is valid here)", async () => {
    await seedTokens();
    handler = async (url) => {
      if (url.includes("/auth/me")) {
        return res(200, {
          userId: "user-1",
          email: "a@b.com",
          name: "Ada",
          emailVerified: true,
          lifecycleEmailsEnabled: true,
          hasPassword: true,
        });
      }
      if (url.includes("/workspaces")) return res(200, []); // account not yet connected
      return res(404, {});
    };

    const { result } = renderHook(() => useSession(), { wrapper });

    await waitFor(() => expect(result.current.status).toBe("signedIn"));
    expect(result.current.userId).toBe("user-1");
    expect(result.current.workspaceId).toBeNull(); // -> App renders <NoWorkspace/>, the correct screen
    expect(await storedTokens()).not.toBeNull();
  });

  it("routes a transient network failure to error without discarding valid tokens", async () => {
    await seedTokens();
    // No 401 -> no refresh attempted; the request itself fails (server unreachable).
    handler = async () => {
      throw new TypeError("Failed to fetch");
    };

    const { result } = renderHook(() => useSession(), { wrapper });

    await waitFor(() => expect(result.current.status).toBe("error"));
    // The session may still be valid once connectivity returns: tokens are kept.
    expect(await storedTokens()).not.toBeNull();
  });

  it("routes a launch with no stored tokens straight to signedOut", async () => {
    handler = async () => res(401, {});

    const { result } = renderHook(() => useSession(), { wrapper });

    await waitFor(() => expect(result.current.status).toBe("signedOut"));
  });

  // consumeJustConnected separates "the user just signed in" from "the panel was
  // reopened", which the loaded data cannot distinguish. TriageGate moves the
  // user's tab to their mailbox on the former, so a false positive here would
  // hijack a tab every time the panel opens.
  it("reports no connect gesture when a stored session is merely restored", async () => {
    await seedTokens();
    handler = async (url) => {
      if (url.includes("/auth/me")) {
        return res(200, {
          userId: "user-1",
          email: "a@b.com",
          name: "Ada",
          emailVerified: true,
          lifecycleEmailsEnabled: true,
          hasPassword: true,
        });
      }
      if (url.includes("/workspaces")) return res(200, []);
      return res(404, {});
    };

    const { result } = renderHook(() => useSession(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("signedIn"));

    expect(result.current.consumeJustConnected()).toBe(false);
  });
});

// signInWithMicrosoft is the Outlook mirror of signInWithGoogle: it runs the
// Microsoft grant, posts the code to /auth/microsoft (a raw fetch, since there is
// no token yet), stores the returned pair, and bootstraps the session.
describe("signInWithMicrosoft", () => {
  beforeEach(() => {
    resetChromeStorage();
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => handler(String(url), init)),
    );
    vi.mocked(requestMicrosoftAuth).mockResolvedValue({
      code: "ms-code-123",
      scope: "Mail.Read offline_access User.Read",
      redirectUri: "https://abcdefghijklmnop.chromiumapp.org/",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the grant to /auth/microsoft, stores the tokens, and signs in", async () => {
    let microsoftBody: unknown = null;
    handler = async (url, init) => {
      if (url.includes("/auth/microsoft")) {
        microsoftBody = JSON.parse(String(init?.body));
        return res(200, {
          accessToken: makeJwt("user-7"),
          refreshToken: "ref-7",
          refreshTokenExpiresAt: "2999-01-01T00:00:00.000Z",
        });
      }
      if (url.includes("/auth/me")) {
        return res(200, {
          userId: "user-7",
          email: "m@b.com",
          name: "Mo",
          emailVerified: true,
          lifecycleEmailsEnabled: true,
          hasPassword: false,
        });
      }
      if (url.includes("/workspaces")) return res(200, []);
      return res(404, {});
    };

    const { result } = renderHook(() => useSession(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("signedOut"));

    await result.current.signInWithMicrosoft();

    // The code goes over verbatim — the redirect URI must match the one it was
    // minted for or the API's exchange fails.
    expect(microsoftBody).toEqual({
      code: "ms-code-123",
      scope: "Mail.Read offline_access User.Read",
      redirectUri: "https://abcdefghijklmnop.chromiumapp.org/",
    });
    await waitFor(() => expect(result.current.status).toBe("signedIn"));
    expect(result.current.userId).toBe("user-7");
    expect(await storedTokens()).not.toBeNull();

    // A gesture the user performed, so the panel may take them to their mailbox.
    // Once only: a second reader must not repeat the tab move.
    expect(result.current.consumeJustConnected()).toBe(true);
    expect(result.current.consumeJustConnected()).toBe(false);
  });

  it("surfaces the API error message and stores nothing when sign-in is refused", async () => {
    handler = async (url) => {
      if (url.includes("/auth/microsoft")) {
        return res(403, { error: "Outlook read access (Mail.Read) was not granted" });
      }
      return res(404, {});
    };

    const { result } = renderHook(() => useSession(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("signedOut"));

    await expect(result.current.signInWithMicrosoft()).rejects.toThrow(
      "Outlook read access (Mail.Read) was not granted",
    );
    expect(await storedTokens()).toBeNull();
    expect(result.current.status).toBe("signedOut");
  });
});
