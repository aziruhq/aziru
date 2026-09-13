import { render, screen, cleanup, waitFor } from "@/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadItem } from "@aziru/ui/emails";
import type { EmailThreadDetail } from "@aziru/api-client";
import { ThreadPreview } from "./ThreadPreview";

vi.mock("@/lib/api", () => ({
  api: {
    emailThread: vi.fn(),
    threadBodies: vi.fn(),
    threadDrafts: vi.fn(),
    draftQuota: vi.fn(),
    threadSummary: vi.fn(),
    generateDraft: vi.fn(),
    toggleDraftSent: vi.fn(),
    listThreadComments: vi.fn().mockResolvedValue({ comments: [], lastReadAt: null }),
    threadCommentsMeta: vi.fn().mockResolvedValue({ total: 0, unread: 0 }),
    markThreadCommentsRead: vi.fn().mockResolvedValue({ ok: true, lastReadAt: "2026-07-11T10:00:00.000Z" }),
    createThreadComment: vi.fn(),
    deleteThreadComment: vi.fn(),
    inlineImageUrl: (ws: string, threadId: string, messageId: string, attachmentId: string) =>
      `/api/internal/workspaces/${ws}/email-threads/${threadId}/messages/${messageId}/inline-image?attachmentId=${attachmentId}`,
  },
}));

import { api } from "@/lib/api";

const WS = "ws-1";

// A thread with one message from Alice, sorted into "folder-1".
function threadV1(): ThreadItem {
  return {
    id: "t-1",
    subject: "Project kickoff",
    provider: "GMAIL",
    providerThreadId: "gmail-1",
    webLink: null,
    participants: "Alice Smith",
    latestAt: new Date("2026-07-11T10:00:00Z"),
    messageCount: 1,
    snippet: "Let's get started",
    unread: false,
    folderId: "folder-1",
    status: "sorted",
    confidence: 0.9,
    reasoning: null,
    alternativeFolder: null,
    messages: [
      {
        id: "m-1",
        fromName: "Alice Smith",
        fromEmail: "alice@example.com",
        time: new Date("2026-07-11T10:00:00Z"),
        snippet: "Let's get started",
        bodyText: null,
      },
    ],
    hasDraft: false,
    isDrafting: false,
    lastSenderEmail: "alice@example.com",
    doneMark: null,
    assignment: null,
    isImportant: false,
    isClassifying: false,
    attachmentCount: 0,
    commentCount: 0,
    unreadCommentCount: 0,
  };
}

// The same thread after a new message from Bob arrives via the live refresh:
// same id, higher messageCount, newer latestAt. This is the object the parent
// hands the preview through selectedThread on an SSE refresh.
function threadV2(): ThreadItem {
  const t = threadV1();
  return {
    ...t,
    participants: "Alice Smith, Bob Jones",
    latestAt: new Date("2026-07-11T11:00:00Z"),
    messageCount: 2,
    lastSenderEmail: "bob@example.com",
    messages: [
      ...t.messages,
      {
        id: "m-2",
        fromName: "Bob Jones",
        fromEmail: "bob@example.com",
        time: new Date("2026-07-11T11:00:00Z"),
        snippet: "One more thing",
        bodyText: null,
      },
    ],
  };
}

// Minimal detail response for the emailThread refetch.
function detail(messageIds: string[], explanation: string): EmailThreadDetail {
  return {
    id: "t-1",
    subject: "Project kickoff",
    provider: "GMAIL",
    providerThreadId: "gmail-1",
    webLink: null,
    latestMessageAt: "2026-07-11T11:00:00Z",
    messageCount: messageIds.length,
    triageStatus: "SORTED",
    isClassifying: false,
    isQueued: false,
    createdAt: "2026-07-11T10:00:00Z",
    updatedAt: "2026-07-11T11:00:00Z",
    isImportant: false,
    hasDraft: false,
    isDrafting: false,
    messages: messageIds.map((id, idx) => ({
      id,
      senderEmail: idx === 0 ? "alice@example.com" : "bob@example.com",
      senderName: idx === 0 ? "Alice Smith" : "Bob Jones",
      subject: "Project kickoff",
      snippet: idx === 0 ? "Let's get started" : "One more thing",
      bodyText: idx === 0 ? "First body" : "Second body",
      receivedAt: idx === 0 ? "2026-07-11T10:00:00Z" : "2026-07-11T11:00:00Z",
      hasAttachments: false,
      attachments: [],
      toEmails: [],
    })),
    latestClassification: {
      id: "c-1",
      confidence: 0.9,
      explanation,
      priority: null,
      urgency: null,
      riskLevel: null,
      requiredAction: null,
      sensitivity: null,
      dueAt: null,
      suggestedNextStep: null,
      needsHumanReview: false,
      decisionSource: null,
      modelProvider: null,
      modelName: null,
      createdAt: "2026-07-11T10:00:00Z",
      finalNode: { id: "folder-1", name: "Work" },
    },
    filedNode: { id: "folder-1", name: "Work" },
    tags: [],
    doneMark: null,
    assignment: null,
  };
}

const noop = () => {};

function renderPreview(thread: ThreadItem) {
  return render(
    <ThreadPreview
      thread={thread}
      workspaceId={WS}
      workspaceEmail={null}
      onClose={noop}
      onDraftStarted={noop}
      onDraftFailed={noop}
      onDraftGenerated={noop}
      onDraftSentToggled={noop}
      onMarkDone={noop}
      onCommentsSync={noop}
      onUnmarkDone={noop}
      onToggleImportant={noop}
      members={[]}
      canAssign={false}
      onOpenAssign={noop}
      currentUserId="test-user-1"
    />,
  );
}

beforeEach(() => {
  vi.mocked(api.threadBodies).mockResolvedValue({ bodies: {}, inlineImages: {} });
  vi.mocked(api.threadDrafts).mockResolvedValue({ drafts: [] });
  vi.mocked(api.draftQuota).mockResolvedValue({ used: 0, limit: 5, resetsAt: "2026-08-01T00:00:00Z" });
  vi.mocked(api.threadSummary).mockResolvedValue({
    kind: "summary",
    summary: {
      format: "PROSE",
      text: "Alice and Bob are agreeing a kickoff date.",
      bullets: [],
      locale: "en",
      generatedAt: null,
    },
    isNew: true,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ThreadPreview live update when an open thread gains a message", () => {
  it("reloads the message list when the same thread's content changes", async () => {
    vi.mocked(api.emailThread)
      .mockResolvedValueOnce(detail(["m-1"], "Filed under Work: kickoff planning."))
      .mockResolvedValueOnce(detail(["m-1", "m-2"], "Re-sorted: Bob's reply added context."));

    const { rerender } = renderPreview(threadV1());

    // Initial state: one message from the first detail fetch.
    expect(await screen.findByText("Alice Smith")).toBeInTheDocument();
    expect(screen.queryByText("Bob Jones")).not.toBeInTheDocument();
    await waitFor(() => expect(api.emailThread).toHaveBeenCalledTimes(1));

    // The parent hands over a fresh thread object: same id, new message.
    rerender(
      <ThreadPreview
        thread={threadV2()}
        workspaceId={WS}
        workspaceEmail={null}
        onClose={noop}
        onDraftStarted={noop}
        onDraftFailed={noop}
        onDraftGenerated={noop}
        onDraftSentToggled={noop}
        onMarkDone={noop}
        onCommentsSync={noop}
        onUnmarkDone={noop}
        onToggleImportant={noop}
        members={[]}
        canAssign={false}
        onOpenAssign={noop}
        currentUserId="test-user-1"
      />,
    );

    // The new message appears without a remount.
    expect(await screen.findByText("Bob Jones")).toBeInTheDocument();
    await waitFor(() => expect(api.emailThread).toHaveBeenCalledTimes(2));
  });

  it("does not refetch when an unrelated prop changes but the content signal is unchanged", async () => {
    vi.mocked(api.emailThread).mockResolvedValue(detail(["m-1"], "Filed under Work."));

    const { rerender } = renderPreview(threadV1());

    expect(await screen.findByText("Alice Smith")).toBeInTheDocument();
    await waitFor(() => expect(api.emailThread).toHaveBeenCalledTimes(1));

    // A re-render with a brand-new object whose id/messageCount/latestAt/folderId
    // are unchanged (only isImportant flipped) must NOT trigger a detail refetch —
    // this is what keying on the object identity would wrongly do, and what the
    // id-only key protected against.
    rerender(
      <ThreadPreview
        thread={{ ...threadV1(), isImportant: true }}
        workspaceId={WS}
        workspaceEmail={null}
        onClose={noop}
        onDraftStarted={noop}
        onDraftFailed={noop}
        onDraftGenerated={noop}
        onDraftSentToggled={noop}
        onMarkDone={noop}
        onCommentsSync={noop}
        onUnmarkDone={noop}
        onToggleImportant={noop}
        members={[]}
        canAssign={false}
        onOpenAssign={noop}
        currentUserId="test-user-1"
      />,
    );

    // Give any errant effect a chance to fire, then assert it did not.
    await Promise.resolve();
    expect(api.emailThread).toHaveBeenCalledTimes(1);
  });
});

describe("ThreadPreview inline images", () => {
  it("renders CID inline images returned by threadBodies as <img> in the open message", async () => {
    vi.mocked(api.emailThread).mockResolvedValue(detail(["m-1"], "Filed under Work."));
    vi.mocked(api.threadBodies).mockResolvedValue({
      bodies: { "m-1": "First body" },
      inlineImages: {
        "m-1": [{ attachmentId: "att-1", mimeType: "image/png", filename: "logo.png" }],
      },
    });

    renderPreview(threadV1());

    const img = (await screen.findByAltText("logo.png")) as HTMLImageElement;
    expect(img.getAttribute("src")).toContain(
      "/messages/m-1/inline-image?attachmentId=att-1",
    );
    expect(img.getAttribute("loading")).toBe("lazy");
  });

  it("hides an inline image whose fetch errors, leaving the message intact", async () => {
    vi.mocked(api.emailThread).mockResolvedValue(detail(["m-1"], "Filed under Work."));
    vi.mocked(api.threadBodies).mockResolvedValue({
      bodies: { "m-1": "First body" },
      inlineImages: {
        "m-1": [{ attachmentId: "att-1", mimeType: "image/png", filename: "logo.png" }],
      },
    });

    renderPreview(threadV1());

    const img = (await screen.findByAltText("logo.png")) as HTMLImageElement;
    img.dispatchEvent(new Event("error"));

    await waitFor(() => expect(screen.queryByAltText("logo.png")).not.toBeInTheDocument());
    // Body text still shows — a broken image never breaks the preview.
    expect(screen.getByText("First body")).toBeInTheDocument();
  });
});

describe("ThreadPreview thread summary", () => {
  it("shows the generated summary in the slot above the message list", async () => {
    vi.mocked(api.emailThread).mockResolvedValue(detail(["m-1", "m-2"], "Filed under Work."));

    renderPreview(threadV2());

    expect(
      await screen.findByText("Alice and Bob are agreeing a kickoff date."),
    ).toBeInTheDocument();
    expect(screen.getByText("Summary")).toBeInTheDocument();
    expect(api.threadSummary).toHaveBeenCalledWith(WS, "t-1", {});
  });

  it("requests a summary for a single-message thread and renders a server-chosen snippet", async () => {
    vi.mocked(api.emailThread).mockResolvedValue(detail(["m-1"], "Filed under Work."));
    // The server, not the client, decides when a snippet is enough.
    vi.mocked(api.threadSummary).mockResolvedValue({ kind: "snippet", snippet: "Let's get started" });

    renderPreview(threadV1());

    expect(await screen.findByText("Preview")).toBeInTheDocument();
    expect(screen.getByText("Let's get started")).toBeInTheDocument();
    expect(api.threadSummary).toHaveBeenCalledWith(WS, "t-1", {});
  });

  it("renders the quota line instead of a summary when the monthly cap is reached", async () => {
    vi.mocked(api.emailThread).mockResolvedValue(detail(["m-1", "m-2"], "Filed under Work."));
    vi.mocked(api.threadSummary).mockResolvedValue({
      quotaExceeded: true,
      used: 50,
      limit: 50,
      resetsAt: "2026-08-01T00:00:00.000Z",
    });

    renderPreview(threadV2());

    expect(await screen.findByText(/no summaries remaining/i)).toBeInTheDocument();
  });

  it("offers a retry when the summary request fails", async () => {
    vi.mocked(api.emailThread).mockResolvedValue(detail(["m-1", "m-2"], "Filed under Work."));
    vi.mocked(api.threadSummary).mockRejectedValue(new Error("boom"));

    renderPreview(threadV2());

    expect(await screen.findByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("re-requests the summary when a new message arrives in the open thread", async () => {
    vi.mocked(api.emailThread).mockResolvedValue(detail(["m-1", "m-2"], "Filed under Work."));

    const { rerender } = renderPreview(threadV1());
    // Single-message threads are summarized too: one request on open.
    await waitFor(() => expect(api.emailThread).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.threadSummary).toHaveBeenCalledTimes(1));

    rerender(
      <ThreadPreview
        thread={threadV2()}
        workspaceId={WS}
        workspaceEmail={null}
        onClose={noop}
        onDraftStarted={noop}
        onDraftFailed={noop}
        onDraftGenerated={noop}
        onDraftSentToggled={noop}
        onMarkDone={noop}
        onCommentsSync={noop}
        onUnmarkDone={noop}
        onToggleImportant={noop}
        members={[]}
        canAssign={false}
        onOpenAssign={noop}
        currentUserId="test-user-1"
      />,
    );

    // The server compares message-set signatures and regenerates; the client only
    // has to ask again.
    await waitFor(() => expect(api.threadSummary).toHaveBeenCalledTimes(2));
  });
});

describe("ThreadPreview summary request races", () => {
  // The pane is not keyed by thread id, so a thread switch re-runs the effect
  // WITHOUT remounting. An unguarded response therefore lands in the state of
  // whatever thread is on screen when it arrives — and a summary is derived
  // email content, so showing the wrong one attributes one thread's contents to
  // another. Generation is seconds and a cache hit is milliseconds, so the slow
  // response routinely arrives second.
  it("drops a slow response for a thread the user has already left", async () => {
    vi.mocked(api.emailThread).mockResolvedValue(detail(["m-1", "m-2"], "Filed under Work."));

    let resolveFirst: (value: Awaited<ReturnType<typeof api.threadSummary>>) => void = noop;
    const slowFirst = new Promise<Awaited<ReturnType<typeof api.threadSummary>>>((r) => {
      resolveFirst = r;
    });
    const summaryFor = (text: string) =>
      ({
        kind: "summary" as const,
        summary: { format: "PROSE" as const, text, bullets: [], locale: "en", generatedAt: null },
        isNew: true,
      });

    vi.mocked(api.threadSummary)
      .mockReturnValueOnce(slowFirst)
      .mockResolvedValueOnce(summaryFor("Second thread: invoice is overdue."));

    const second = { ...threadV2(), id: "t-2" };
    const { rerender } = renderPreview(threadV2());

    rerender(
      <ThreadPreview
        thread={second}
        workspaceId={WS}
        workspaceEmail={null}
        onClose={noop}
        onDraftStarted={noop}
        onDraftFailed={noop}
        onDraftGenerated={noop}
        onDraftSentToggled={noop}
        onMarkDone={noop}
        onCommentsSync={noop}
        onUnmarkDone={noop}
        onToggleImportant={noop}
        members={[]}
        canAssign={false}
        onOpenAssign={noop}
        currentUserId="test-user-1"
      />,
    );

    expect(await screen.findByText("Second thread: invoice is overdue.")).toBeInTheDocument();

    // The abandoned request finally lands.
    resolveFirst(summaryFor("First thread: kickoff date."));
    await waitFor(() => expect(api.threadSummary).toHaveBeenCalledTimes(2));

    expect(screen.queryByText("First thread: kickoff date.")).not.toBeInTheDocument();
    expect(screen.getByText("Second thread: invoice is overdue.")).toBeInTheDocument();
  });

  it("does not start a poll for a thread the user has already left", async () => {
    vi.mocked(api.emailThread).mockResolvedValue(detail(["m-1", "m-2"], "Filed under Work."));

    let resolveFirst: (value: Awaited<ReturnType<typeof api.threadSummary>>) => void = noop;
    const slowFirst = new Promise<Awaited<ReturnType<typeof api.threadSummary>>>((r) => {
      resolveFirst = r;
    });
    vi.mocked(api.threadSummary).mockReturnValueOnce(slowFirst);

    const { unmount } = renderPreview(threadV2());
    await waitFor(() => expect(api.threadSummary).toHaveBeenCalledTimes(1));
    unmount();

    // A "someone else is generating this" answer arriving after the pane closed
    // would otherwise install an interval that nothing is left to clear: it polls
    // the API forever and has no component to render into.
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    resolveFirst({ generating: true });
    await Promise.resolve();
    await Promise.resolve();

    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });
});

describe("ThreadPreview message expansion", () => {
  // The list endpoint delivers ThreadItem.messages NEWEST-FIRST (mapThreads
  // contract: messages[0] drives the snippet). MessageCard latches its expansion
  // at mount, so if the pane seeds state in that raw order it permanently expands
  // the OLDEST message — the later oldest-first detail fetch cannot repair it.
  it("expands the newest message even though the list hands messages newest-first", async () => {
    // Detail fetch never resolves: assert on the seed state alone.
    vi.mocked(api.emailThread).mockReturnValue(new Promise(() => {}));
    vi.mocked(api.threadBodies).mockReturnValue(new Promise(() => {}));

    const t = threadV2();
    // Simulate the real list contract: newest first.
    t.messages = [...t.messages].reverse();
    expect(t.messages[0]!.fromName).toBe("Bob Jones");

    renderPreview(t);

    const headers = screen.getAllByRole("button", { name: /alice smith|bob jones/i });
    const expandedStates = headers.map((h) => [
      h.textContent,
      h.getAttribute("aria-expanded"),
    ]);
    // Chronological render order: Alice (oldest, collapsed) then Bob (newest, expanded).
    expect(expandedStates[0]![0]).toContain("Alice Smith");
    expect(expandedStates[0]![1]).toBe("false");
    expect(expandedStates[1]![0]).toContain("Bob Jones");
    expect(expandedStates[1]![1]).toBe("true");
  });
});

describe("ThreadPreview bulleted summaries", () => {
  it("renders a bulleted summary as a list", async () => {
    vi.mocked(api.emailThread).mockResolvedValue(detail(["m-1", "m-2"], "Filed under Work."));
    vi.mocked(api.threadSummary).mockResolvedValue({
      kind: "summary",
      summary: {
        format: "BULLETS",
        text: "",
        bullets: ["Kickoff on Monday", "Bob owns the deck", "Budget signed off"],
        locale: "en",
        generatedAt: null,
      },
      isNew: true,
    });

    renderPreview(threadV2());

    expect(await screen.findByText("Kickoff on Monday")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });
});
