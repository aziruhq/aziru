import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ApiClient } from "@aziru/api-client";
import { useWorkspaceEvents } from "./useWorkspaceEvents";
import { resetChromeStorage } from "../test-setup";

// The panel guarantees "never more than one live connection". The guard is
// close() at the top of connect(), but the connection's AbortController is only
// created after two awaits (me() + the token read). A regression here reopens
// the race where a hidden->visible flip starts a second connect while the first
// is suspended, leaving two live SSE streams and firing onSynced twice.

const TOKEN_KEY = "aziru.auth.tokens";
const ENCODER = new TextEncoder();

type FetchCall = {
  url: string;
  signal: AbortSignal | undefined;
  stream: ReadableStreamDefaultController<Uint8Array>;
};

let visibility: DocumentVisibilityState;

function setVisibility(state: DocumentVisibilityState): void {
  visibility = state;
  document.dispatchEvent(new Event("visibilitychange"));
}

// A me() that never resolves on its own: the test drives each call's resolution
// so it can suspend a connect() exactly between the top guard and the controller.
function makeDeferredMeClient(): { client: ApiClient; resolveMe: (i: number) => void } {
  const resolvers: Array<() => void> = [];
  const client = {
    me: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        }),
    ),
  } as unknown as ApiClient;
  return { client, resolveMe: (i) => resolvers[i]?.() };
}

async function flush(): Promise<void> {
  // Several chained awaits (me -> gen check -> token read -> fetch -> read loop).
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

describe("useWorkspaceEvents", () => {
  const eventsUrl = (id: string) => `/workspaces/${id}/events`;
  let fetchCalls: FetchCall[];

  beforeEach(async () => {
    resetChromeStorage();
    await chrome.storage.local.set({
      [TOKEN_KEY]: JSON.stringify({ accessToken: "tok", refreshToken: "ref" }),
    });
    visibility = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });

    fetchCalls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init: RequestInit) => {
        let stream!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
          },
        });
        fetchCalls.push({ url: String(url), signal: init.signal ?? undefined, stream });
        return Promise.resolve({ ok: true, body } as unknown as Response);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function eventsCalls(id: string): FetchCall[] {
    return fetchCalls.filter((c) => c.url.includes(eventsUrl(id)));
  }

  it("opens exactly one stream when a hidden->visible flip races the initial connect", async () => {
    const onSynced = vi.fn();
    const { client, resolveMe } = makeDeferredMeClient();

    // Initial connect A mounts and suspends at me() (call 0), before it can
    // create/store a controller.
    renderHook(() => useWorkspaceEvents(client, "ws-1", onSynced));
    await flush();
    expect(client.me).toHaveBeenCalledTimes(1);
    expect(eventsCalls("ws-1")).toHaveLength(0);

    // Flip hidden then visible while A is still suspended: close() (no controller
    // to abort yet) then connect B, which suspends at its own me() (call 1).
    act(() => setVisibility("hidden"));
    act(() => setVisibility("visible"));
    await flush();
    expect(client.me).toHaveBeenCalledTimes(2);

    // A resumes first: it was superseded by close()+B, so it must bail without
    // opening a stream.
    resolveMe(0);
    await flush();
    expect(eventsCalls("ws-1")).toHaveLength(0);

    // B resumes and opens the single live stream.
    resolveMe(1);
    await flush();
    const live = eventsCalls("ws-1");
    expect(live).toHaveLength(1);

    // A "synced" event on that one stream fires the callback exactly once.
    act(() => {
      live[0]!.stream.enqueue(ENCODER.encode("event: synced\ndata: ws-1\n\n"));
    });
    await flush();
    expect(onSynced).toHaveBeenCalledTimes(1);
  });

  // The panel injected into Gmail/Outlook watches one thread, so it needs the
  // per-thread event as well as the workspace-level "synced".
  it("delivers thread events to the optional handler", async () => {
    const onSynced = vi.fn();
    const onThread = vi.fn();
    const { client, resolveMe } = makeDeferredMeClient();

    renderHook(() => useWorkspaceEvents(client, "ws-1", onSynced, onThread));
    await flush();
    resolveMe(0);
    await flush();

    const live = eventsCalls("ws-1");
    act(() => {
      live[0]!.stream.enqueue(
        ENCODER.encode(
          'event: thread\ndata: {"type":"classified","threadId":"t1","providerThreadId":"18f0"}\n\n',
        ),
      );
    });
    await flush();
    expect(onThread).toHaveBeenCalledWith({
      type: "classified",
      threadId: "t1",
      providerThreadId: "18f0",
    });
    expect(onSynced).not.toHaveBeenCalled();
  });

  it("aborts the live stream on unmount", async () => {
    const onSynced = vi.fn();
    const { client, resolveMe } = makeDeferredMeClient();

    const { unmount } = renderHook(() => useWorkspaceEvents(client, "ws-1", onSynced));
    await flush();
    resolveMe(0);
    await flush();

    const calls = eventsCalls("ws-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.signal?.aborted).toBe(false);

    act(() => unmount());
    expect(calls[0]!.signal?.aborted).toBe(true);
  });
});
