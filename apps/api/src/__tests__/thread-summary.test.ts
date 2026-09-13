import { vi, describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { authed } from "./helpers.js";

const mockBilling = vi.hoisted(() => ({ enforceSummaryQuota: true }));
const { mockResolveInboxQuota, mockRecordMeterUsage, mockGenerateThreadSummary, mockCreateAIProvider } =
  vi.hoisted(() => ({
    mockResolveInboxQuota: vi.fn(),
    mockRecordMeterUsage: vi.fn(),
    mockGenerateThreadSummary: vi.fn(),
    mockCreateAIProvider: vi.fn(),
  }));

vi.mock("@aziru/config", () => ({
  config: {
    redis: { url: "redis://localhost:6379" },
    billing: mockBilling,
    internalApiSecret: "dev-internal-secret",
  },
}));

vi.mock("@aziru/db", () => ({
  Prisma: {},
  db: {
    emailThread: { findFirst: vi.fn() },
    emailAccount: { findMany: vi.fn() },
    workspace: { findUnique: vi.fn() },
    workspaceMember: { findUnique: vi.fn() },
    emailConnection: { findUnique: vi.fn() },
    threadSummary: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
    gmailSyncSettings: { findUnique: vi.fn() },
    inboxUsageMeter: { findUnique: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  },
  resolveInboxQuota: mockResolveInboxQuota,
  recordMeterUsage: mockRecordMeterUsage,
  messageSetSignature: (ids: string[]) =>
    createHash("sha1").update([...ids].sort().join(",")).digest("hex").slice(0, 16),
}));

const SUMMARY_PROMPT_VERSION = "2";

vi.mock("@aziru/ai", () => ({
  createAIProvider: mockCreateAIProvider,
  generateThreadSummary: mockGenerateThreadSummary,
  getSummaryAIProviderConfig: () => ({ provider: "mock" }),
  SUMMARY_PROMPT_VERSION: "2",
}));

const { mockGetThreadSnapshot } = vi.hoisted(() => ({ mockGetThreadSnapshot: vi.fn() }));

vi.mock("@aziru/mail", () => ({
  createMailProvider: () => ({ getThreadSnapshot: mockGetThreadSnapshot }),
}));

import app from "../app.js";
import { db } from "@aziru/db";
import { getThreadSummaryLimit } from "@aziru/shared";

const FREE_LIMIT = getThreadSummaryLimit("FREE");

const WS_ID = "ws-1";
const THREAD_ID = "thread-1";
const PROVIDER_THREAD_ID = "18f0abc123";

function messageAt(providerMessageId: string, hour: number) {
  return {
    providerMessageId,
    subject: "Kickoff",
    senderEmail: "ana@acme.com",
    senderName: "Ana",
    bodyText: "Body text",
    snippet: `snippet for ${providerMessageId}`,
    receivedAt: new Date(Date.UTC(2026, 6, 1, hour)),
  };
}

/** A normal multi-message, non-automated thread: the LLM path. */
function multiMessageThread() {
  return {
    id: THREAD_ID,
    subject: "Kickoff",
    isAutomated: false,
    providerThreadId: PROVIDER_THREAD_ID,
    messages: [messageAt("m1", 9), messageAt("m2", 10)],
  };
}

const SIGNATURE = createHash("sha1").update("m1,m2").digest("hex").slice(0, 16);

function post(path: string, headers: Record<string, string> = {}) {
  return app.request(path, authed({ method: "POST", headers }));
}

/** Run the transaction callback against a tx double backed by the db mocks. */
function wireTransaction() {
  vi.mocked(db.$transaction).mockImplementation(async (fn: unknown) =>
    (fn as (tx: unknown) => Promise<unknown>)({
      $queryRaw: db.$queryRaw,
      threadSummary: db.threadSummary,
      inboxUsageMeter: db.inboxUsageMeter,
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockBilling.enforceSummaryQuota = true;

  vi.mocked(db.workspaceMember.findUnique).mockResolvedValue({ userId: "test-user-1" } as never);
  vi.mocked(db.emailThread.findFirst).mockResolvedValue(multiMessageThread() as never);
  vi.mocked(db.workspace.findUnique).mockResolvedValue({ locale: "en" } as never);
  vi.mocked(db.emailConnection.findUnique).mockResolvedValue({
    provider: "GMAIL",
    emailAddress: "ben@gmail.com",
    encryptedRefreshToken: "enc-token",
  } as never);
  mockGetThreadSnapshot.mockResolvedValue({
    messages: [
      { providerMessageId: "m1", bodyExcerpt: "live body one" },
      { providerMessageId: "m2", bodyExcerpt: "live body two" },
    ],
  });
  vi.mocked(db.threadSummary.findUnique).mockResolvedValue(null as never);
  vi.mocked(db.threadSummary.upsert).mockResolvedValue({} as never);
  vi.mocked(db.threadSummary.update).mockResolvedValue({} as never);
  vi.mocked(db.inboxUsageMeter.findUnique).mockResolvedValue(null as never);
  vi.mocked(db.emailAccount.findMany).mockResolvedValue([{ id: "acc-1" }] as never);
  vi.mocked(db.gmailSyncSettings.findUnique).mockResolvedValue({
    threadSummaryInjectionEnabled: true,
  } as never);
  vi.mocked(db.$queryRaw).mockResolvedValue([] as never);
  wireTransaction();

  mockResolveInboxQuota.mockResolvedValue({
    inboxKey: "ben@gmail.com",
    windowStart: new Date(Date.UTC(2026, 6, 1)),
    plan: "FREE",
    used: 0,
  });
  mockCreateAIProvider.mockReturnValue({ providerName: "mock", modelName: "mock-1" });
  mockGenerateThreadSummary.mockResolvedValue({
    format: "PROSE",
    text: "Ana wants the kickoff date.",
    bullets: [],
  });
});

describe("POST /workspaces/:workspaceId/email-threads/:threadId/summary", () => {
  it("404s when the thread is not in the workspace", async () => {
    vi.mocked(db.emailThread.findFirst).mockResolvedValue(null as never);
    const res = await post(`/workspaces/${WS_ID}/email-threads/${THREAD_ID}/summary`);
    expect(res.status).toBe(404);
    expect(mockGenerateThreadSummary).not.toHaveBeenCalled();
  });

  it("generates, stores, and meters on a cache miss", async () => {
    const res = await post(`/workspaces/${WS_ID}/email-threads/${THREAD_ID}/summary`);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      kind: "summary",
      format: "PROSE",
      summary: "Ana wants the kickoff date.",
      bullets: [],
      locale: "en",
    });
    expect(db.threadSummary.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "READY", summary: "Ana wants the kickoff date." }),
      }),
    );
    expect(mockRecordMeterUsage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "THREAD_SUMMARY", delta: 1 }),
    );
  });

  // The DB stores bodyText: null by policy ("store minimal email data"), so the
  // bodies MUST come from a live provider fetch — the prod bug was a summary of
  // six empty bodies reading "no body content in any of the messages".
  it("feeds live provider bodies to the LLM, not the (null) stored bodyText", async () => {
    await post(`/workspaces/${WS_ID}/email-threads/${THREAD_ID}/summary`);
    expect(mockGetThreadSnapshot).toHaveBeenCalledWith(PROVIDER_THREAD_ID);
    const messages = mockGenerateThreadSummary.mock.calls[0]![1] as Array<{ bodyText: string }>;
    expect(messages.map((m) => m.bodyText)).toEqual(["live body one", "live body two"]);
  });

  it("falls back to the stored snippet when the provider fetch fails", async () => {
    mockGetThreadSnapshot.mockRejectedValue(new Error("gmail down"));
    vi.mocked(db.emailThread.findFirst).mockResolvedValue({
      ...multiMessageThread(),
      messages: [
        { ...messageAt("m1", 9), bodyText: null },
        { ...messageAt("m2", 10), bodyText: null },
      ],
    } as never);
    const res = await post(`/workspaces/${WS_ID}/email-threads/${THREAD_ID}/summary`);
    expect(res.status).toBe(201);
    const messages = mockGenerateThreadSummary.mock.calls[0]![1] as Array<{ bodyText: string }>;
    expect(messages.map((m) => m.bodyText)).toEqual(["snippet for m1", "snippet for m2"]);
  });

  it("does not attempt a provider fetch on the mock/dev path (no connection)", async () => {
    vi.mocked(db.emailConnection.findUnique).mockResolvedValue(null as never);
    const res = await post(`/workspaces/${WS_ID}/email-threads/${THREAD_ID}/summary`);
    expect(res.status).toBe(201);
    expect(mockGetThreadSnapshot).not.toHaveBeenCalled();
    // Stored bodyText (the mock inbox does persist bodies) still reaches the LLM.
    const messages = mockGenerateThreadSummary.mock.calls[0]![1] as Array<{ bodyText: string }>;
    expect(messages.map((m) => m.bodyText)).toEqual(["Body text", "Body text"]);
  });

  it("stores the signature of the current message set on the placeholder", async () => {
    await post(`/workspaces/${WS_ID}/email-threads/${THREAD_ID}/summary`);
    expect(db.threadSummary.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ messageSetSignature: SIGNATURE, status: "GENERATING" }),
      }),
    );
  });

  // ── Snippet-only gate ───────────────────────────────────────────────────────

  // A single-message thread is summarized like any other (client requirement);
  // only automated threads and threads with no stored messages short-circuit.
  it("generates and meters a summary for a single-message thread", async () => {
    vi.mocked(db.emailThread.findFirst).mockResolvedValue({
      id: THREAD_ID,
      subject: "Kickoff",
      isAutomated: false,
      providerThreadId: PROVIDER_THREAD_ID,
      messages: [messageAt("m1", 9)],
    } as never);
    const res = await post(`/workspaces/${WS_ID}/email-threads/${THREAD_ID}/summary`);
    expect(res.status).toBe(201);
    expect(mockGenerateThreadSummary).toHaveBeenCalledTimes(1);
    expect(mockGenerateThreadSummary.mock.calls[0]![1]).toHaveLength(1);
    expect(mockRecordMeterUsage).toHaveBeenCalledTimes(1);
  });

  it("returns an empty snippet for a thread with no stored messages without calling the LLM", async () => {
    vi.mocked(db.emailThread.findFirst).mockResolvedValue({
      id: THREAD_ID,
      subject: "Kickoff",
      isAutomated: false,
      providerThreadId: PROVIDER_THREAD_ID,
      messages: [],
    } as never);
    const res = await post(`/workspaces/${WS_ID}/email-threads/${THREAD_ID}/summary`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: "snippet", snippet: "" });
    expect(mockGenerateThreadSummary).not.toHaveBeenCalled();
    expect(db.threadSummary.upsert).not.toHaveBeenCalled();
    expect(mockRecordMeterUsage).not.toHaveBeenCalled();
  });

  it("returns the stored snippet for an automated thread without calling the LLM", async () => {
    vi.mocked(db.emailThread.findFirst).mockResolvedValue({
      ...multiMessageThread(),
      isAutomated: true,
    } as never);
    const res = await post(`/workspaces/${WS_ID}/email-threads/${THREAD_ID}/summary`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: "snippet", snippet: "snippet for m2" });
    expect(mockGenerateThreadSummary).not.toHaveBeenCalled();
    expect(mockRecordMeterUsage).not.toHaveBeenCalled();
  });

  // ── Cache + invalidation ────────────────────────────────────────────────────

  it("serves a cached READY summary without calling the LLM or metering", async () => {
    vi.mocked(db.threadSummary.findUnique).mockResolvedValue({
      status: "READY",
      summary: "Cached text.",
      bullets: [],
      format: "PROSE",
      promptVersion: SUMMARY_PROMPT_VERSION,
      locale: "en",
      messageSetSignature: SIGNATURE,
      generatedAt: new Date(Date.UTC(2026, 6, 2)),
      updatedAt: new Date(Date.UTC(2026, 6, 2)),
    } as never);
    const res = await post(`/workspaces/${WS_ID}/email-threads/${THREAD_ID}/summary`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ kind: "summary", summary: "Cached text." });
    expect(mockGenerateThreadSummary).not.toHaveBeenCalled();
    expect(mockRecordMeterUsage).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("regenerates when the message set changed (a new message arrived)", async () => {
    vi.mocked(db.threadSummary.findUnique).mockResolvedValue({
      status: "READY",
      summary: "Stale text.",
      bullets: [],
      format: "PROSE",
      promptVersion: SUMMARY_PROMPT_VERSION,
      locale: "en",
      messageSetSignature: "0000000000000000",
      generatedAt: new Date(Date.UTC(2026, 6, 2)),
      updatedAt: new Date(Date.UTC(2026, 6, 2)),
    } as never);
    const res = await post(`/workspaces/${WS_ID}/email-threads/${THREAD_ID}/summary`);
    expect(res.status).toBe(201);
    expect(mockGenerateThreadSummary).toHaveBeenCalledOnce();
  });

  it("regenerates when the workspace locale changed", async () => {
    vi.mocked(db.workspace.findUnique).mockResolvedValue({ locale: "fr" } as never);
    vi.mocked(db.threadSummary.findUnique).mockResolvedValue({
      status: "READY",
      summary: "English text.",
      bullets: [],
      format: "PROSE",
      promptVersion: SUMMARY_PROMPT_VERSION,
      locale: "en",
      messageSetSignature: SIGNATURE,
      generatedAt: new Date(Date.UTC(2026, 6, 2)),
      updatedAt: new Date(Date.UTC(2026, 6, 2)),
    } as never);
    const res = await post(`/workspaces/${WS_ID}/email-threads/${THREAD_ID}/summary`);
    expect(res.status).toBe(201);
    expect(mockGenerateThreadSummary).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ targetLanguage: "French" }),
    );
  });

  it("bypasses the cache when X-Force-Regenerate is set", async () => {
    vi.mocked(db.threadSummary.findUnique).mockResolvedValue({
      status: "READY",
      summary: "Cached text.",
      bullets: [],
      format: "PROSE",
      promptVersion: SUMMARY_PROMPT_VERSION,
      locale: "en",
      messageSetSignature: SIGNATURE,
      generatedAt: new Date(Date.UTC(2026, 6, 2)),
      updatedAt: new Date(Date.UTC(2026, 6, 2)),
    } as never);
    const res = await post(`/workspaces/${WS_ID}/email-threads/${THREAD_ID}/summary`, {
      "X-Force-Regenerate": "1",
    });
    expect(res.status).toBe(201);
    expect(mockGenerateThreadSummary).toHaveBeenCalledOnce();
  });

  it("returns 202 while a fresh generation is in flight", async () => {
    vi.mocked(db.threadSummary.findUnique).mockResolvedValue({
      status: "GENERATING",
      summary: null,
      bullets: [],
      format: "PROSE",
      promptVersion: SUMMARY_PROMPT_VERSION,
      locale: "en",
      messageSetSignature: SIGNATURE,
      generatedAt: null,
      updatedAt: new Date(),
    } as never);
    const res = await post(`/workspaces/${WS_ID}/email-threads/${THREAD_ID}/summary`);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ generating: true });
    expect(mockGenerateThreadSummary).not.toHaveBeenCalled();
  });

  it("retries past a stale GENERATING row instead of polling forever", async () => {
    vi.mocked(db.threadSummary.findUnique).mockResolvedValue({
      status: "GENERATING",
      summary: null,
      bullets: [],
      format: "PROSE",
      promptVersion: SUMMARY_PROMPT_VERSION,
      locale: "en",
      messageSetSignature: SIGNATURE,
      generatedAt: null,
      updatedAt: new Date(Date.now() - 10 * 60 * 1_000),
    } as never);
    const res = await post(`/workspaces/${WS_ID}/email-threads/${THREAD_ID}/summary`);
    expect(res.status).toBe(201);
  });

  // ── Failures ────────────────────────────────────────────────────────────────

  it("marks the row FAILED and does not meter when the LLM returns invalid output", async () => {
    mockGenerateThreadSummary.mockResolvedValue(null);
    const res = await post(`/workspaces/${WS_ID}/email-threads/${THREAD_ID}/summary`);
    expect(res.status).toBe(500);
    expect(db.threadSummary.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) }),
    );
    expect(mockRecordMeterUsage).not.toHaveBeenCalled();
  });

  it("marks the row FAILED and does not meter when the LLM call throws", async () => {
    mockGenerateThreadSummary.mockRejectedValue(new Error("boom"));
    const res = await post(`/workspaces/${WS_ID}/email-threads/${THREAD_ID}/summary`);
    expect(res.status).toBe(500);
    expect(mockRecordMeterUsage).not.toHaveBeenCalled();
  });

  it("returns 503 when no AI provider is configured", async () => {
    mockCreateAIProvider.mockImplementation(() => {
      throw new Error("no key");
    });
    const res = await post(`/workspaces/${WS_ID}/email-threads/${THREAD_ID}/summary`);
    expect(res.status).toBe(503);
    expect(db.threadSummary.upsert).not.toHaveBeenCalled();
  });

  // ── Quota ───────────────────────────────────────────────────────────────────

  it("returns 429 with quota details at the monthly limit", async () => {
    vi.mocked(db.inboxUsageMeter.findUnique).mockResolvedValue({ used: FREE_LIMIT } as never);
    const res = await post(`/workspaces/${WS_ID}/email-threads/${THREAD_ID}/summary`);
    expect(res.status).toBe(429);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toMatch(/quota exceeded/i);
    expect(body.used).toBe(FREE_LIMIT);
    expect(body.limit).toBe(FREE_LIMIT);
    expect(typeof body.resetsAt).toBe("string");
    expect(mockGenerateThreadSummary).not.toHaveBeenCalled();
    expect(db.threadSummary.upsert).not.toHaveBeenCalled();
  });

  it("uses the pooled inbox plan ceiling (PRO allows more than FREE)", async () => {
    mockResolveInboxQuota.mockResolvedValue({
      inboxKey: "ben@gmail.com",
      windowStart: new Date(Date.UTC(2026, 6, 1)),
      plan: "PRO",
      used: FREE_LIMIT + 1,
    });
    vi.mocked(db.inboxUsageMeter.findUnique).mockResolvedValue({ used: FREE_LIMIT + 1 } as never);
    const res = await post(`/workspaces/${WS_ID}/email-threads/${THREAD_ID}/summary`);
    expect(res.status).toBe(201);
  });

  it("still records usage when enforcement is off", async () => {
    mockBilling.enforceSummaryQuota = false;
    vi.mocked(db.inboxUsageMeter.findUnique).mockResolvedValue({ used: FREE_LIMIT } as never);
    const res = await post(`/workspaces/${WS_ID}/email-threads/${THREAD_ID}/summary`);
    expect(res.status).toBe(201);
    expect(mockRecordMeterUsage).toHaveBeenCalledOnce();
  });

  it("does not meter when there is no connected inbox (mock/dev path)", async () => {
    vi.mocked(db.emailConnection.findUnique).mockResolvedValue(null as never);
    const res = await post(`/workspaces/${WS_ID}/email-threads/${THREAD_ID}/summary`);
    expect(res.status).toBe(201);
    expect(mockResolveInboxQuota).not.toHaveBeenCalled();
    expect(mockRecordMeterUsage).not.toHaveBeenCalled();
  });
});

// ─── Native-injection route (resolve by provider thread id) ────────────────────

describe("POST /workspaces/:workspaceId/provider-threads/:providerThreadId/summary", () => {
  // Resolution is one indexed lookup on (workspaceId, providerThreadId); the
  // workspace filter is the tenancy boundary.
  it("resolves the thread within the workspace and generates", async () => {
    vi.mocked(db.emailThread.findFirst)
      .mockResolvedValueOnce({ id: THREAD_ID } as never)
      .mockResolvedValueOnce(multiMessageThread() as never);
    const res = await post(`/workspaces/${WS_ID}/provider-threads/${PROVIDER_THREAD_ID}/summary`);
    expect(res.status).toBe(201);
    expect(db.emailThread.findFirst).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { workspaceId: WS_ID, providerThreadId: PROVIDER_THREAD_ID },
      }),
    );
  });

  it("404s when the provider thread belongs to another workspace", async () => {
    vi.mocked(db.emailThread.findFirst).mockResolvedValue(null as never);
    const res = await post(`/workspaces/${WS_ID}/provider-threads/${PROVIDER_THREAD_ID}/summary`);
    expect(res.status).toBe(404);
    expect(mockGenerateThreadSummary).not.toHaveBeenCalled();
  });

  it("decodes a URL-encoded id and normalizes the EWS base64 alphabet to Graph's", async () => {
    // OWA's data-convid is the EWS flavor: `+` and `/`. Graph's URL-safe form is
    // NOT standard base64url — it swaps `+`→`_` and `/`→`-`. The route must look
    // up the Graph form, which is what sync stores.
    const owaFlavor = "AAQkAD/g+abc=";
    const graphFlavor = "AAQkAD-g_abc=";
    vi.mocked(db.emailThread.findFirst)
      .mockResolvedValueOnce({ id: THREAD_ID } as never)
      .mockResolvedValueOnce(multiMessageThread() as never);
    const res = await post(
      `/workspaces/${WS_ID}/provider-threads/${encodeURIComponent(owaFlavor)}/summary`,
    );
    expect(res.status).toBe(201);
    expect(db.emailThread.findFirst).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { workspaceId: WS_ID, providerThreadId: graphFlavor },
      }),
    );
  });

  // ── Workspace kill-switch ───────────────────────────────────────────────────
  // Enforced on THIS route only: it is the one the mail-page content scripts
  // call, and the extension is the half we do not control.

  it("403s without generating when the workspace has injection switched off", async () => {
    vi.mocked(db.gmailSyncSettings.findUnique).mockResolvedValue({
      threadSummaryInjectionEnabled: false,
    } as never);
    const res = await post(`/workspaces/${WS_ID}/provider-threads/${PROVIDER_THREAD_ID}/summary`);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ injectionDisabled: true });
    // Refused before any thread lookup, so it costs neither a query nor a model call.
    expect(db.emailThread.findFirst).not.toHaveBeenCalled();
    expect(mockGenerateThreadSummary).not.toHaveBeenCalled();
  });

  it("treats a missing settings row as enabled (the column default)", async () => {
    vi.mocked(db.gmailSyncSettings.findUnique).mockResolvedValue(null as never);
    vi.mocked(db.emailThread.findFirst)
      .mockResolvedValueOnce({ id: THREAD_ID } as never)
      .mockResolvedValueOnce(multiMessageThread() as never);
    const res = await post(`/workspaces/${WS_ID}/provider-threads/${PROVIDER_THREAD_ID}/summary`);
    expect(res.status).toBe(201);
  });

  it("leaves the id-addressed route (web preview, side panel) ungated", async () => {
    vi.mocked(db.gmailSyncSettings.findUnique).mockResolvedValue({
      threadSummaryInjectionEnabled: false,
      includeSpam: false,
      includePromotions: false,
      blacklistedSenderEmails: ["noreply@spam.example"],
    } as never);
    const res = await post(`/workspaces/${WS_ID}/email-threads/${THREAD_ID}/summary`);
    expect(res.status).toBe(201);
    // Neither the kill switch nor the visibility gate applies to Aziru's own surfaces.
    expect(db.emailThread.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: THREAD_ID, workspaceId: WS_ID } }),
    );
  });

  // ── Visibility gate ─────────────────────────────────────────────────────────
  // A mail page can open any thread, including ones triage excludes. Sync persists
  // those with flags only, so the resolver finds them; the summary lookup must
  // filter them out, or the card would surface content Aziru itself hides.

  it("404s without generating for a thread the visibility settings hide", async () => {
    vi.mocked(db.gmailSyncSettings.findUnique).mockResolvedValue({
      threadSummaryInjectionEnabled: true,
      includeSpam: false,
      includePromotions: false,
      blacklistedSenderEmails: ["noreply@spam.example"],
    } as never);
    vi.mocked(db.emailThread.findFirst)
      .mockResolvedValueOnce({ id: THREAD_ID } as never)
      // The gated lookup misses: the thread is spam/promo/trash/blacklisted/automated.
      .mockResolvedValueOnce(null as never);
    const res = await post(`/workspaces/${WS_ID}/provider-threads/${PROVIDER_THREAD_ID}/summary`);
    expect(res.status).toBe(404);
    expect(db.emailThread.findFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          id: THREAD_ID,
          workspaceId: WS_ID,
          gmailIsTrash: false,
          gmailIsSpam: false,
          gmailIsPromotions: false,
          isAutomated: false,
          NOT: { messages: { some: { senderEmail: { in: ["noreply@spam.example"] } } } },
        },
      }),
    );
    expect(mockGenerateThreadSummary).not.toHaveBeenCalled();
    expect(db.threadSummary.upsert).not.toHaveBeenCalled();
    expect(mockRecordMeterUsage).not.toHaveBeenCalled();
  });

  it("honours the spam and promotions opt-ins in the gate", async () => {
    vi.mocked(db.gmailSyncSettings.findUnique).mockResolvedValue({
      threadSummaryInjectionEnabled: true,
      includeSpam: true,
      includePromotions: true,
      blacklistedSenderEmails: [],
    } as never);
    vi.mocked(db.emailThread.findFirst)
      .mockResolvedValueOnce({ id: THREAD_ID } as never)
      .mockResolvedValueOnce(multiMessageThread() as never);
    const res = await post(`/workspaces/${WS_ID}/provider-threads/${PROVIDER_THREAD_ID}/summary`);
    expect(res.status).toBe(201);
    expect(db.emailThread.findFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { id: THREAD_ID, workspaceId: WS_ID, gmailIsTrash: false, isAutomated: false },
      }),
    );
  });

  it("falls back to the default visibility when the settings row is missing", async () => {
    vi.mocked(db.gmailSyncSettings.findUnique).mockResolvedValue(null as never);
    vi.mocked(db.emailThread.findFirst)
      .mockResolvedValueOnce({ id: THREAD_ID } as never)
      .mockResolvedValueOnce(multiMessageThread() as never);
    const res = await post(`/workspaces/${WS_ID}/provider-threads/${PROVIDER_THREAD_ID}/summary`);
    expect(res.status).toBe(201);
    expect(db.emailThread.findFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          id: THREAD_ID,
          workspaceId: WS_ID,
          gmailIsTrash: false,
          gmailIsSpam: false,
          gmailIsPromotions: false,
          isAutomated: false,
        },
      }),
    );
  });

  it("passes a Graph-form id (and Gmail hex ids) through unchanged", async () => {
    const graphId = "AAQkAD-g_abc=";
    vi.mocked(db.emailThread.findFirst)
      .mockResolvedValueOnce({ id: THREAD_ID } as never)
      .mockResolvedValueOnce(multiMessageThread() as never);
    const res = await post(
      `/workspaces/${WS_ID}/provider-threads/${encodeURIComponent(graphId)}/summary`,
    );
    expect(res.status).toBe(201);
    expect(db.emailThread.findFirst).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { workspaceId: WS_ID, providerThreadId: graphId },
      }),
    );
  });
});

describe("summary format", () => {
  it("persists and returns a bulleted summary", async () => {
    mockGenerateThreadSummary.mockResolvedValue({
      format: "BULLETS",
      text: null,
      bullets: ["Kabbalat Shabbat at 19:30", "Bring documents", "Sacramento 1227"],
    });
    const res = await post(`/workspaces/${WS_ID}/email-threads/${THREAD_ID}/summary`);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      kind: "summary",
      format: "BULLETS",
      bullets: ["Kabbalat Shabbat at 19:30", "Bring documents", "Sacramento 1227"],
    });
    expect(db.threadSummary.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          format: "BULLETS",
          summary: null,
          bullets: ["Kabbalat Shabbat at 19:30", "Bring documents", "Sacramento 1227"],
        }),
      }),
    );
  });

  it("serves a cached bulleted summary without regenerating", async () => {
    vi.mocked(db.threadSummary.findUnique).mockResolvedValue({
      status: "READY",
      summary: null,
      bullets: ["one", "two"],
      format: "BULLETS",
      promptVersion: SUMMARY_PROMPT_VERSION,
      locale: "en",
      messageSetSignature: SIGNATURE,
      generatedAt: new Date(Date.UTC(2026, 6, 2)),
      updatedAt: new Date(Date.UTC(2026, 6, 2)),
    } as never);
    const res = await post(`/workspaces/${WS_ID}/email-threads/${THREAD_ID}/summary`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ format: "BULLETS", bullets: ["one", "two"] });
    expect(mockGenerateThreadSummary).not.toHaveBeenCalled();
  });

  // A BULLETS row with an empty list carries no content — treating it as a hit
  // would render an empty card forever.
  it("regenerates a BULLETS row whose list is empty", async () => {
    vi.mocked(db.threadSummary.findUnique).mockResolvedValue({
      status: "READY",
      summary: null,
      bullets: [],
      format: "BULLETS",
      promptVersion: SUMMARY_PROMPT_VERSION,
      locale: "en",
      messageSetSignature: SIGNATURE,
      generatedAt: new Date(Date.UTC(2026, 6, 2)),
      updatedAt: new Date(Date.UTC(2026, 6, 2)),
    } as never);
    const res = await post(`/workspaces/${WS_ID}/email-threads/${THREAD_ID}/summary`);
    expect(res.status).toBe(201);
    expect(mockGenerateThreadSummary).toHaveBeenCalledOnce();
  });

  // Changing how summaries are written must not leave every cached row serving
  // output produced under the old rules.
  it("regenerates when the prompt version changed", async () => {
    vi.mocked(db.threadSummary.findUnique).mockResolvedValue({
      status: "READY",
      summary: "Written under the old prompt.",
      bullets: [],
      format: "PROSE",
      promptVersion: "1",
      locale: "en",
      messageSetSignature: SIGNATURE,
      generatedAt: new Date(Date.UTC(2026, 6, 2)),
      updatedAt: new Date(Date.UTC(2026, 6, 2)),
    } as never);
    const res = await post(`/workspaces/${WS_ID}/email-threads/${THREAD_ID}/summary`);
    expect(res.status).toBe(201);
    expect(mockGenerateThreadSummary).toHaveBeenCalledOnce();
  });

  it("stamps the current prompt version on the placeholder", async () => {
    await post(`/workspaces/${WS_ID}/email-threads/${THREAD_ID}/summary`);
    expect(db.threadSummary.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ promptVersion: SUMMARY_PROMPT_VERSION }),
      }),
    );
  });
});
