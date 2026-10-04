import * as SecureStore from 'expo-secure-store';

// Persisted auth tokens. The access token is short-lived; the refresh token is
// long-lived and single-use (rotated on every /auth/refresh).
export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

// The minimal surface the transport/session depend on, so they can be unit-
// tested with an in-memory stub instead of the real device keystore.
export interface TokenStore {
  get(): Promise<StoredTokens | null>;
  set(tokens: StoredTokens): Promise<void>;
  clear(): Promise<void>;
}

const KEY = 'aziru.auth.tokens';

// expo-secure-store keeps the value in the device keychain/keystore, encrypted
// at rest. We store the whole pair under one key as JSON.
export const secureTokenStore: TokenStore = {
  async get() {
    const raw = await SecureStore.getItemAsync(KEY);
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
    await SecureStore.setItemAsync(KEY, JSON.stringify(tokens));
  },
  async clear() {
    await SecureStore.deleteItemAsync(KEY);
  },
};
