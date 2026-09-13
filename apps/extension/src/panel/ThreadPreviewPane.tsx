import { useEffect, useRef, useState } from "react";
import { Trans } from "@lingui/react/macro";
import { useLingui } from "@lingui/react";
import { msg } from "@lingui/core/macro";
import type { ApiClient, Draft } from "@aziru/api-client";
import type { MemberItem, ThreadItem, ThreadSummaryCardState } from "@aziru/ui/emails";
import { MessageCard, SuggestedDraftCard, ThreadSummaryCard, ThreadCommentsSection, TriageBar } from "@aziru/ui/emails";
import { chronologicalMessages } from "@aziru/core/emails";
import { GmailIcon, OutlookIcon } from "@aziru/ui";
import { formatQuotaResetDate, TAXONOMY_MIN_NON_ROOT_NODES } from "@aziru/shared";
import { openThreadInMail } from "../gmail/openInGmail";
import type { OutlookAccountType } from "@aziru/core/emails";

type DraftState = "idle" | "loading" | "ready" | "error";

type Props = {
  api: ApiClient;
  thread: ThreadItem;
  workspaceId: string;
  workspaceEmail: string | null;
  gmailAddress: string | null;
  /** Outlook only: personal vs work/school, which picks the Outlook web host. */
  outlookAccountType: OutlookAccountType | null;
  routableNodeCount: number;
  onClose: () => void;
  onDraftStarted: (threadId: string) => void;
  onDraftFailed: (threadId: string) => void;
  onDraftGenerated: (threadId: string) => void;
  onDraftSentToggled: (threadId: string, sent: boolean) => void;
  onMarkDone: (threadId: string) => void;
  onUnmarkDone: (threadId: string) => void;
  onCommentsSync: (threadId: string, commentCount: number) => void;
  onToggleImportant: (threadId: string) => void;
  canAssign: boolean;
  onOpenAssign: (threadId: string, anchor: HTMLElement) => void;
  /** Open the in-panel plan setup dialog (owned by EmailsPanel). */
  onOpenPlanSetup: () => void;
  members: MemberItem[];
  currentUserId: string | null;
};

// Port of apps/web ThreadPreview, with the internal-secret api client swapped
// for the injected session client, the hardcoded Gmail anchor replaced by the
// openInGmail helper (correct account + tab reuse), and a Sort-now control for
// threads that have not been triaged yet.
export function ThreadPreviewPane({
  api,
  thread,
  workspaceId,
  workspaceEmail,
  gmailAddress,
  outlookAccountType,
  routableNodeCount,
  onClose,
  onDraftStarted,
  onDraftFailed,
  onDraftGenerated,
  onDraftSentToggled,
  onMarkDone,
  onUnmarkDone,
  onCommentsSync,
  onToggleImportant,
  canAssign,
  onOpenAssign,
  onOpenPlanSetup,
  members,
  currentUserId,
}: Props) {
  const { _ } = useLingui();
  const [bodyLoaded, setBodyLoaded] = useState(false);
  // ThreadItem.messages is newest-first (list contract); this pane renders
  // oldest-first with the newest card expanded, so normalize at every seed point.
  const [messages, setMessages] = useState(() => chronologicalMessages(thread.messages));

  const [draftState, setDraftState] = useState<DraftState>(
    thread.isDrafting ? "loading" : thread.hasDraft ? "ready" : "idle",
  );
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftQuota, setDraftQuota] = useState<{ used: number; limit: number; resetsAt: string } | null>(null);
  // null = render no summary slot at all.
  const [summaryState, setSummaryState] = useState<ThreadSummaryCardState | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const summaryPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Invalidates in-flight summary work. This pane is NOT keyed by thread id, so
  // switching threads re-runs the effect without remounting: without this, a slow
  // generation for the previous thread resolves later and renders ITS summary
  // under the current thread's header. Bumped on every thread change and on
  // unmount, so a late response can neither set state nor install a poll.
  // (A ref rather than the effect's `cancelled` flag because loadSummary is also
  // re-entered from the error card's retry, outside any effect run.)
  const summaryTokenRef = useRef(0);
  const bodiesRef = useRef<Record<string, string | null> | null>(null);
  // Resolved blob: URLs for CID inline images, keyed by DB message id. The
  // extension's Bearer transport cannot authenticate a plain <img src>, so the
  // bytes are fetched and turned into object URLs. Held in a ref (like bodiesRef)
  // so a late emailThread rebuild re-attaches them instead of dropping them.
  const inlineImagesRef = useRef<Record<string, Array<{ url: string; filename: string | null }>>>({});
  // Every object URL created for this thread, revoked on thread change/unmount.
  const objectUrlsRef = useRef<string[]>([]);

  function revokeObjectUrls() {
    for (const url of objectUrlsRef.current) URL.revokeObjectURL(url);
    objectUrlsRef.current = [];
    inlineImagesRef.current = {};
  }

  function clearPoll() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  function clearSummaryPoll() {
    if (summaryPollRef.current) {
      clearInterval(summaryPollRef.current);
      summaryPollRef.current = null;
    }
  }

  /**
   * Get-or-generate the thread's TL;DR. Same four outcomes as the web preview;
   * the panel just runs them through its bearer-transport client.
   */
  function loadSummary(threadId: string, opts: { force?: boolean } = {}) {
    clearSummaryPoll();
    const token = ++summaryTokenRef.current;
    setSummaryState({ kind: "loading" });
    api.threadSummary(workspaceId, threadId, opts).then((result) => {
      if (token !== summaryTokenRef.current) return;
      if ("generating" in result) {
        summaryPollRef.current = setInterval(() => {
          api.threadSummary(workspaceId, threadId).then((polled) => {
            if (token !== summaryTokenRef.current) return;
            if ("generating" in polled) return;
            clearSummaryPoll();
            setSummaryState(summaryStateFor(polled));
          }).catch(() => {
            if (token !== summaryTokenRef.current) return;
            clearSummaryPoll();
            setSummaryState({ kind: "error", onRetry: () => loadSummary(threadId) });
          });
        }, 2_000);
        return;
      }
      setSummaryState(summaryStateFor(result));
    }).catch(() => {
      if (token !== summaryTokenRef.current) return;
      // Retrying is free: a FAILED row never records a meter unit.
      setSummaryState({ kind: "error", onRetry: () => loadSummary(threadId) });
    });
  }

  function summaryStateFor(
    result: Exclude<Awaited<ReturnType<typeof api.threadSummary>>, { generating: true }>,
  ): ThreadSummaryCardState {
    if ("quotaExceeded" in result) {
      return {
        kind: "quota",
        quota: { used: result.used, limit: result.limit, resetsAt: result.resetsAt },
      };
    }
    if (result.kind === "snippet") return { kind: "snippet", text: result.snippet };
    if (result.summary.format === "BULLETS") {
      return { kind: "bullets", bullets: result.summary.bullets };
    }
    return { kind: "summary", text: result.summary.text };
  }

  function startPoll(threadId: string) {
    pollRef.current = setInterval(() => {
      api.threadDrafts(workspaceId, threadId).then(({ drafts: polled }) => {
        const d = polled[0];
        if (d?.status === "GENERATING") return; // still in progress
        clearPoll();
        if (d?.status === "PROPOSED") {
          setDraft(d);
          setDraftState("ready");
          onDraftGenerated(threadId);
        } else {
          setDraftState("error");
          onDraftFailed(threadId);
        }
      }).catch(() => {
        clearPoll();
        setDraftState("error");
        onDraftFailed(threadId);
      });
    }, 2_000);
  }

  useEffect(() => {
    let cancelled = false;
    setBodyLoaded(false);
    bodiesRef.current = null;
    setMessages(chronologicalMessages(thread.messages));
    setDraftState(thread.isDrafting ? "loading" : thread.hasDraft ? "ready" : "idle");
    setDraft(null);
    clearPoll();
    clearSummaryPoll();
    // Retire any summary still in flight for the thread we just left.
    summaryTokenRef.current++;

    // The summary runs in parallel with the message load and never blocks it.
    // Every thread is summarized, single-message ones included; the server
    // decides when a snippet is enough (automated or empty threads).
    loadSummary(thread.id);

    // Fetch each CID inline image as a blob and turn it into an object URL (the
    // Bearer transport can't authenticate a plain <img src>). Merges the urls in
    // as they resolve; inlineImagesRef lets a late emailThread rebuild keep them.
    async function loadInlineImages(
      descriptorsByMsg: Record<
        string,
        Array<{ attachmentId: string; mimeType: string; filename: string | null }>
      >,
    ) {
      for (const [messageId, descriptors] of Object.entries(descriptorsByMsg)) {
        const resolved: Array<{ url: string; filename: string | null }> = [];
        for (const d of descriptors) {
          const blob = await api.fetchInlineImage(workspaceId, thread.id, messageId, d.attachmentId);
          if (cancelled) return;
          if (!blob) continue;
          const url = URL.createObjectURL(blob);
          objectUrlsRef.current.push(url);
          resolved.push({ url, filename: d.filename });
        }
        if (cancelled) return;
        if (resolved.length > 0) {
          inlineImagesRef.current[messageId] = resolved;
          setMessages((prev) =>
            prev.map((m) => (m.id === messageId ? { ...m, inlineImages: resolved } : m)),
          );
        }
      }
    }

    // Fire both calls at once. emailThread resolves first (DB-only) and renders
    // metadata; threadBodies resolves later (Gmail fetch) and fills body text.
    // bodiesRef guards the race where threadBodies wins.
    api.emailThread(workspaceId, thread.id).then((detail) => {
      const bodies = bodiesRef.current;
      setMessages(
        detail.messages.map((m) => {
          const imgs = inlineImagesRef.current[m.id];
          return {
            id: m.id,
            fromName: m.senderName ?? m.senderEmail,
            fromEmail: m.senderEmail,
            time: new Date(m.receivedAt),
            snippet: m.snippet,
            bodyText: (bodies !== null && m.id in bodies ? bodies[m.id] : null) ?? m.bodyText,
            attachments: m.attachments,
            ...(imgs ? { inlineImages: imgs } : {}),
          };
        }),
      );
    }).catch(() => {});

    api.threadBodies(workspaceId, thread.id).then(({ bodies, inlineImages }) => {
      bodiesRef.current = bodies;
      setMessages((prev) => prev.map((m) => (m.id in bodies ? { ...m, bodyText: bodies[m.id] ?? null } : m)));
      setBodyLoaded(true);
      void loadInlineImages(inlineImages ?? {});
    }).catch(() => {
      setBodyLoaded(true);
    });

    if (thread.status !== "unsorted") {
      api.draftQuota(workspaceId).then(setDraftQuota).catch(() => {});

      api.threadDrafts(workspaceId, thread.id).then(({ drafts }) => {
        const latest = drafts[0];
        if (latest?.status === "GENERATING" || (!latest && thread.isDrafting)) {
          setDraftState("loading");
          startPoll(thread.id);
        } else if (latest?.status === "PROPOSED" || latest?.status === "SENT") {
          setDraft(latest);
          setDraftState("ready");
        }
      }).catch(() => {});
    }

    return () => {
      cancelled = true;
      clearPoll();
      clearSummaryPoll();
      // Also covers unmount (closing the preview), where no later loadSummary
      // runs to invalidate a response that is still on its way.
      summaryTokenRef.current++;
      revokeObjectUrls();
    };
  }, [thread.id, workspaceId]);

  function handleGenerateDraft(opts: { force?: boolean } = {}) {
    const threadId = thread.id;
    setDraftState("loading");
    onDraftStarted(threadId);
    api.generateDraft(workspaceId, threadId, opts).then((result) => {
      if ("generating" in result) {
        startPoll(threadId);
        return;
      }
      if ("quotaExceeded" in result) {
        setDraftState(opts.force ? "ready" : "idle");
        setDraftQuota({ used: result.used, limit: result.limit, resetsAt: result.resetsAt });
        onDraftFailed(threadId);
        return;
      }
      setDraft(result.draft);
      setDraftState("ready");
      if (result.isNew) {
        setDraftQuota((q) => (q ? { ...q, used: q.used + 1 } : q));
      }
      onDraftGenerated(threadId);
    }).catch(() => {
      setDraftState("error");
      onDraftFailed(threadId);
    });
  }

  function handleToggleDraftSent() {
    if (!draft) return;
    const newSent = draft.status !== "SENT";
    const optimistic: Draft = { ...draft, status: newSent ? "SENT" : "PROPOSED" };
    setDraft(optimistic);
    onDraftSentToggled(thread.id, newSent);
    api.toggleDraftSent(workspaceId, thread.id, draft.id, newSent)
      .then(({ draft: updated }) => setDraft(updated))
      .catch(() => {
        setDraft(draft);
        onDraftSentToggled(thread.id, !newSent);
      });
  }

  const isDone = !!thread.doneMark;
  const lastMsg = messages[messages.length - 1];
  const lastMsgIsOwn =
    !!workspaceEmail &&
    !!lastMsg?.fromEmail &&
    lastMsg.fromEmail.toLowerCase() === workspaceEmail.toLowerCase();
  const isUnsorted = thread.status === "unsorted" || thread.status === "unrouted";
  const canDraft = thread.status !== "unsorted" && !lastMsgIsOwn;
  const quotaExhausted = draftQuota !== null && draftQuota.used >= draftQuota.limit;
  const quotaResetDate = draftQuota ? formatQuotaResetDate(draftQuota.resetsAt) : null;
  const quotaRemaining = draftQuota ? draftQuota.limit - draftQuota.used : 0;

  return (
    <div className="em-preview-col">
      <div className="em-preview-toolbar">
        <button type="button" className="em-back-btn" onClick={onClose} aria-label={_(msg`Back to list`)}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
            <path d="M9 11L5 7l4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <Trans>Back</Trans>
        </button>
        <span className="em-preview-spacer" />
        <button
          type="button"
          className={`em-icon-btn em-star-btn${thread.isImportant ? " is-important" : ""}`}
          aria-label={thread.isImportant ? _(msg`Remove from important`) : _(msg`Mark as important`)}
          aria-pressed={thread.isImportant}
          onClick={() => onToggleImportant(thread.id)}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
            <path
              d="M7 1.75l1.545 3.13 3.455.502-2.5 2.437.59 3.44L7 9.63l-3.09 1.625.59-3.44-2.5-2.437 3.455-.502z"
              fill={thread.isImportant ? "currentColor" : "none"}
              stroke="currentColor"
              strokeWidth={thread.isImportant ? 0 : 1.3}
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      {gmailAddress && (
        <div className="ax-open-gmail-row">
          <button
            type="button"
            className="ax-btn ax-btn-secondary ax-open-gmail"
            onClick={() => void openThreadInMail(gmailAddress, thread, outlookAccountType)}
          >
            {thread.provider === "OUTLOOK" ? (
              <OutlookIcon variant="color" size={16} />
            ) : (
              <GmailIcon variant="color" size={16} />
            )}
            {thread.provider === "OUTLOOK" ? (
              <Trans>Open in Outlook</Trans>
            ) : (
              <Trans>Open in Gmail</Trans>
            )}
          </button>
        </div>
      )}

      <div className="em-preview-scroll">
        <h2 className="em-preview-subject">{thread.subject}</h2>

        <TriageBar
          isDone={isDone}
          doneMark={thread.doneMark}
          onMark={() => onMarkDone(thread.id)}
          onUnmark={() => onUnmarkDone(thread.id)}
          assignment={thread.assignment}
          canAssign={canAssign}
          onOpenAssign={(anchor) => onOpenAssign(thread.id, anchor)}
        />

        {summaryState && <ThreadSummaryCard state={summaryState} />}

        <ThreadCommentsSection
          api={api}
          workspaceId={workspaceId}
          threadId={thread.id}
          currentUserId={currentUserId}
          members={members}
          onCommentsSync={onCommentsSync}
        />

        {isUnsorted && (
          routableNodeCount < TAXONOMY_MIN_NON_ROOT_NODES ? (
            // Taxonomy too weak to route into (same threshold the web app uses to
            // gate "Route now"), so triage would no-op. Build the sorting plan
            // here in the panel rather than sending the user to the web app.
            <div className="ax-sort-now-wrap">
              <p><Trans>This thread hasn't been sorted yet. Set up your folders so Aziru knows where to file it.</Trans></p>
              <button
                type="button"
                className="ax-btn ax-btn-secondary ax-sort-now"
                onClick={onOpenPlanSetup}
              >
                <Trans>Set up folders</Trans>
              </button>
            </div>
          ) : (
            <div className="ax-sort-now-wrap">
              <p><Trans>This thread hasn't been sorted yet.</Trans></p>
            </div>
          )
        )}

        <div className="em-msg-list">
          {messages.map((m, idx) => (
            <MessageCard
              key={m.id}
              message={m}
              defaultExpanded={idx === messages.length - 1}
              loading={!bodyLoaded}
            />
          ))}
        </div>

        {canDraft && draftState === "idle" && (
          <div className="em-draft-cta-wrap">
            <button
              type="button"
              className="em-draft-cta"
              onClick={() => handleGenerateDraft()}
              disabled={quotaExhausted}
            >
              <Trans>Generate draft reply</Trans>
            </button>
            {draftQuota !== null && (
              <p className={`em-draft-quota${quotaExhausted ? " em-draft-quota--exhausted" : ""}`}>
                {quotaExhausted
                  ? <Trans>No drafts remaining · resets {quotaResetDate}</Trans>
                  : <Trans>{quotaRemaining} of {draftQuota.limit} remaining · resets {quotaResetDate}</Trans>}
              </p>
            )}
          </div>
        )}

        {draftState === "loading" && (
          <div className="em-draft-skeleton">
            <span className="em-draft-skeleton-pulse" />
            <Trans>Writing draft reply…</Trans>
          </div>
        )}

        {draftState === "error" && (
          <div className="em-draft-error">
            <span><Trans>Draft generation failed. Try again.</Trans></span>
            <button type="button" className="em-btn ghost" onClick={() => handleGenerateDraft()}>
              <Trans>Retry</Trans>
            </button>
          </div>
        )}

        {canDraft && draftState === "ready" && draft && (
          <SuggestedDraftCard
            draft={draft}
            onToggleSent={handleToggleDraftSent}
            onRegenerate={() => handleGenerateDraft({ force: true })}
            quota={draftQuota}
          />
        )}
      </div>
    </div>
  );
}
