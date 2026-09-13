"use client";

import { useEffect, useRef, useState } from "react";
import { Trans } from "@lingui/react/macro";
import { useLingui } from "@lingui/react";
import { msg } from "@lingui/core/macro";
import { api } from "@/lib/api";
import type { Draft } from "@/lib/api";
import type { ThreadItem, MemberItem, ThreadSummaryCardState } from "@aziru/ui/emails";
import { MessageCard, SuggestedDraftCard, ThreadSummaryCard, ThreadCommentsSection, TriageBar, buildThreadUrl, openInProviderLabel } from "@aziru/ui/emails";
import { chronologicalMessages } from "@aziru/core/emails";
import { Tooltip, GmailIcon, OutlookIcon } from "@aziru/ui";
import { formatQuotaResetDate } from "@aziru/shared";

type DraftState = "idle" | "loading" | "ready" | "error";

type Props = {
  thread: ThreadItem;
  workspaceId: string;
  workspaceEmail: string | null;
  onClose: () => void;
  onDraftStarted: (threadId: string) => void;
  onDraftFailed: (threadId: string) => void;
  onDraftGenerated: (threadId: string) => void;
  onDraftSentToggled: (threadId: string, sent: boolean) => void;
  onMarkDone: (threadId: string) => void;
  onUnmarkDone: (threadId: string) => void;
  onCommentsSync: (threadId: string, commentCount: number) => void;
  onToggleImportant: (threadId: string) => void;
  members: MemberItem[];
  canAssign: boolean;
  onOpenAssign: (threadId: string, anchor: HTMLElement) => void;
  currentUserId: string;
};

export function ThreadPreview({
  thread,
  workspaceId,
  workspaceEmail,
  onClose,
  onDraftStarted,
  onDraftFailed,
  onDraftGenerated,
  onDraftSentToggled,
  onMarkDone,
  onUnmarkDone,
  onCommentsSync,
  onToggleImportant,
  members,
  canAssign,
  onOpenAssign,
  currentUserId,
}: Props) {
  const { _, i18n } = useLingui();
  const [bodyLoaded, setBodyLoaded] = useState(false);
  // ThreadItem.messages arrives newest-first (list contract); this pane renders
  // oldest-first with the newest card expanded, so normalize at every seed point.
  // MessageCard latches its expansion at mount, so seeding in the wrong order
  // cannot be repaired by the later detail fetch.
  const [messages, setMessages] = useState(() => chronologicalMessages(thread.messages));

  const [draftState, setDraftState] = useState<DraftState>(
    thread.isDrafting ? "loading" : thread.hasDraft ? "ready" : "idle"
  );
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftQuota, setDraftQuota] = useState<{ used: number; limit: number; resetsAt: string } | null>(null);
  // null = render no summary slot at all (before the first attempt resolves the
  // thread's shape, and whenever the thread has nothing worth showing).
  const [summaryState, setSummaryState] = useState<ThreadSummaryCardState | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const summaryPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Invalidates in-flight summary work. This pane is NOT keyed by thread id, so
  // switching threads re-runs the effect without remounting: without this, a slow
  // generation for the previous thread resolves later and renders ITS summary
  // under the current thread's header. Bumped on every thread change and on
  // unmount, so a late response can neither set state nor install a poll.
  const summaryTokenRef = useRef(0);
  type InlineImageDescriptor = { attachmentId: string; mimeType: string; filename: string | null };
  type BodiesResult = {
    bodies: Record<string, string | null>;
    inlineImages: Record<string, InlineImageDescriptor[]>;
  };
  const bodiesRef = useRef<BodiesResult | null>(null);

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
   * Get-or-generate the thread's TL;DR and map the four server outcomes onto the
   * card. Idempotent and cheap: a cached summary is a plain read, and the server
   * short-circuits single-message/automated threads to a snippet with no LLM call.
   */
  function loadSummary(threadId: string, opts: { force?: boolean } = {}) {
    clearSummaryPoll();
    const token = ++summaryTokenRef.current;
    setSummaryState({ kind: "loading" });
    api.threadSummary(workspaceId, threadId, opts).then((result) => {
      if (token !== summaryTokenRef.current) return;
      if ("generating" in result) {
        // Another request (another tab, or a reload mid-generation) is already
        // producing it; poll rather than paying for a second one.
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
    result: Exclude<Awaited<ReturnType<typeof api.threadSummary>>, { generating: true }>
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
          // Empty result means generation failed or was never started
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

  // Reload the pane not only when a different thread is opened but whenever the
  // open thread's content changes. A new message arriving in an already-open
  // thread comes through the live refresh as a fresh thread object with the same
  // id but a higher messageCount / newer latestAt, and a re-sort lands it in a
  // different folder. Keying the loader on this primitive signal (rather than
  // thread.id, which never changes here) reloads the message list when it
  // actually changes, while still not refetching on every parent render
  // the way keying on the thread object itself would.
  const threadSignal = `${thread.id}:${thread.messageCount}:${thread.latestAt.getTime()}:${thread.folderId ?? ""}`;

  useEffect(() => {
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

    // Map the API's inline-image descriptors for one message to renderable <img>
    // entries (same-origin proxy URLs). Undefined when there are none.
    const inlineImagesFor = (
      messageId: string,
      inlineImages: Record<string, InlineImageDescriptor[]>
    ): Array<{ url: string; filename: string | null }> | undefined => {
      const descriptors = inlineImages[messageId];
      if (!descriptors || descriptors.length === 0) return undefined;
      return descriptors.map((d) => ({
        url: api.inlineImageUrl(workspaceId, thread.id, messageId, d.attachmentId),
        filename: d.filename,
      }));
    };

    // Fire both calls simultaneously. emailThread resolves first (DB-only, fast)
    // and renders metadata. threadBodies resolves later (Gmail fetch) and fills
    // in body text. bodiesRef guards against the race where threadBodies wins.

    api.emailThread(workspaceId, thread.id).then((detail) => {
      const loaded = bodiesRef.current;
      setMessages(
        detail.messages.map((m) => {
          const imgs = loaded !== null ? inlineImagesFor(m.id, loaded.inlineImages) : undefined;
          return {
            id: m.id,
            fromName: m.senderName ?? m.senderEmail,
            fromEmail: m.senderEmail,
            time: new Date(m.receivedAt),
            snippet: m.snippet,
            bodyText:
              (loaded !== null && m.id in loaded.bodies ? loaded.bodies[m.id] : null) ?? m.bodyText,
            attachments: m.attachments,
            ...(imgs ? { inlineImages: imgs } : {}),
          };
        })
      );
    }).catch(() => {});

    api.threadBodies(workspaceId, thread.id).then(({ bodies, inlineImages }) => {
      const loaded: BodiesResult = { bodies, inlineImages: inlineImages ?? {} };
      bodiesRef.current = loaded;
      setMessages((prev) =>
        prev.map((m) => {
          if (!(m.id in bodies)) return m;
          const imgs = inlineImagesFor(m.id, loaded.inlineImages);
          return { ...m, bodyText: bodies[m.id] ?? null, ...(imgs ? { inlineImages: imgs } : {}) };
        })
      );
      setBodyLoaded(true);
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
        // !latest && !isDrafting → draftState already set to "idle" above
      }).catch(() => {});
    }

    return () => {
      clearPoll();
      clearSummaryPoll();
      // Also covers unmount (closing the preview), where no later loadSummary
      // runs to invalidate a response that is still on its way.
      summaryTokenRef.current++;
    };
  }, [threadSignal, workspaceId]);

  function handleGenerateDraft(opts: { force?: boolean } = {}) {
    const threadId = thread.id;
    setDraftState("loading");
    onDraftStarted(threadId);
    api.generateDraft(workspaceId, threadId, opts).then((result) => {
      if ("generating" in result) {
        // Server says generation is already in progress (e.g. duplicate click);
        // poll until the draft resolves.
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
        setDraftQuota((q) => q ? { ...q, used: q.used + 1 } : q);
      }
      onDraftGenerated(threadId);
    }).catch(() => {
      setDraftState("error");
      onDraftFailed(threadId);
    });
  }

  function handleRegenerateDraft() {
    handleGenerateDraft({ force: true });
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
  const canDraft = thread.status !== "unsorted" && !lastMsgIsOwn;
  const quotaExhausted = draftQuota !== null && draftQuota.used >= draftQuota.limit;
  const quotaResetDate = draftQuota ? formatQuotaResetDate(draftQuota.resetsAt) : null;
  const quotaRemaining = draftQuota ? draftQuota.limit - draftQuota.used : 0;

  // Shared between the enabled and quota-exhausted (tooltip-wrapped) branches so
  // the button markup lives in one place. When exhausted, pointerEvents:none lets
  // hover reach the wrapping span so the Tooltip can explain why it is disabled.
  const draftCtaButton = (
    <button
      type="button"
      className="em-draft-cta"
      onClick={() => handleGenerateDraft()}
      disabled={quotaExhausted}
      style={quotaExhausted ? { pointerEvents: "none" } : undefined}
    >
      <span className="em-draft-cta-glyph" aria-hidden>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path
            d="M2 9.5h8M2 7l5-5 1.5 1.5-5 5H2V7zM7 3l1.5-1.5 1.5 1.5-1.5 1.5L7 3z"
            stroke="currentColor"
            strokeWidth="1.1"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <Trans>Generate draft reply</Trans>
    </button>
  );

  return (
    <div className="em-preview-col">
      <div className="em-preview-toolbar">
        <button
          type="button"
          className="em-back-btn"
          onClick={onClose}
          aria-label={_(msg`Back to list`)}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
            <path d="M9 11L5 7l4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <Trans>Back</Trans>
        </button>
        <span className="em-preview-spacer" />
        <Tooltip content={openInProviderLabel(i18n, thread.provider)} placement="bottom">
          <a
            href={buildThreadUrl(thread, workspaceEmail)}
            target="_blank"
            rel="noopener noreferrer"
            className="em-preview-open"
            aria-label={openInProviderLabel(i18n, thread.provider)}
          >
            {thread.provider === "OUTLOOK" ? (
              <OutlookIcon variant="color" size={16} />
            ) : (
              <GmailIcon variant="color" size={16} />
            )}
            <span className="em-preview-open-label">
              {openInProviderLabel(i18n, thread.provider)}
            </span>
          </a>
        </Tooltip>
        <Tooltip
          content={thread.isImportant ? _(msg`Remove from important`) : _(msg`Mark as important`)}
          placement="bottom"
        >
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
        </Tooltip>
        <Tooltip content={_(msg`Close preview`)} placement="left">
          <button
            type="button"
            className="em-icon-btn"
            aria-label={_(msg`Close preview`)}
            onClick={onClose}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
              <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        </Tooltip>
      </div>

      <div className="em-preview-scroll">
        <h2 className="em-preview-subject">{thread.subject}</h2>

        <TriageBar
          isDone={isDone}
          doneMark={thread.doneMark}
          onMark={() => onMarkDone(thread.id)}
          onUnmark={() => onUnmarkDone(thread.id)}
          assignment={thread.assignment}
          canAssign={canAssign}
          {...(members.length > 0
            ? { onOpenAssign: (anchor: HTMLElement) => onOpenAssign(thread.id, anchor) }
            : {})}
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

        <div className="em-msg-list">
          {messages.map((msg, idx) => (
            <MessageCard
              key={msg.id}
              message={msg}
              defaultExpanded={idx === messages.length - 1}
              loading={!bodyLoaded}
            />
          ))}
        </div>

        {canDraft && draftState === "idle" && (
          <div className="em-draft-cta-wrap">
            {quotaExhausted ? (
              <Tooltip content={_(msg`No drafts remaining this month`)}>
                <span style={{ display: "inline-block", cursor: "not-allowed" }}>
                  {draftCtaButton}
                </span>
              </Tooltip>
            ) : (
              draftCtaButton
            )}
            {draftQuota !== null && (
              <p className={`em-draft-quota${quotaExhausted ? " em-draft-quota--exhausted" : ""}`}>
                {quotaExhausted
                  ? <Trans>No drafts remaining · resets {quotaResetDate}</Trans>
                  : <Trans>{quotaRemaining} of {draftQuota.limit} remaining · resets {quotaResetDate}</Trans>
                }
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
            <button
              type="button"
              className="em-btn ghost"
              onClick={() => handleGenerateDraft()}
            >
              <Trans>Retry</Trans>
            </button>
          </div>
        )}

        {canDraft && draftState === "ready" && draft && (
          <SuggestedDraftCard
            draft={draft}
            onToggleSent={handleToggleDraftSent}
            onRegenerate={handleRegenerateDraft}
            quota={draftQuota}
          />
        )}
      </div>
    </div>
  );
}
