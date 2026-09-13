import { ext } from "../../platform/ext.js";
import { startScheduler, type Scheduler, type ThreadContext } from "./scheduler.js";
import {
  mountSummaryWidget,
  removeExistingWidgets,
  type MountOptions,
  type WidgetState,
  type SummaryWidget,
  type WidgetComments,
} from "./summaryWidget.js";
import {
  COMMENT_META_MESSAGE,
  THREAD_SUMMARY_MESSAGE,
  type CommentMetaRequest,
  type CommentMetaResponse,
  type ThreadSummaryPayload,
  type ThreadSummaryRequest,
  type ThreadSummaryResponse,
} from "./messaging.js";
import { debugLog } from "./debug.js";

/**
 * Everything a provider must supply. Both entrypoints are three lines around
 * this: all the Gmail/OWA DOM knowledge lives in the two callbacks.
 */
export interface ProviderAdapter {
  /** Read the open thread from the DOM, or null when not on a thread view. */
  detectThread: () => ThreadContext | null;
  /**
   * The element the card should be inserted before (typically the top of the
   * message list). Null when the pane has not rendered yet.
   */
  findInjectionAnchor: () => Element | null;
  /**
   * Left margin for the card so it lines up with the provider's own content
   * column (Gmail indents its message list past the avatar gutter; OWA does
   * not). Omit for flush-left.
   */
  gutterLeft?: string;
  /**
   * Open the injected panel with its Comments section focused. Omitted when the
   * provider has no panel to open; the comment bubble then never renders.
   */
  onOpenComments?: (context: ThreadContext) => void;
  /**
   * Whether the panel the bubble targets is currently mounted. Checked before
   * every render of the bubble, not just once: the workspace's kill switch can
   * tear the panel down mid-session, after which the bubble must disappear
   * rather than click into nothing.
   */
  isCommentsTargetLive?: () => boolean;
}

/** How often the comments badge re-checks while a thread stays open and the
 *  tab is visible. Comments are human-paced; this only covers teammate
 *  activity — the user's own actions in the panel refresh instantly via the
 *  commentsChanged nudge. */
const COMMENT_META_POLL_MS = 30_000;

/** What runContentScript hands back to the entrypoint. */
export interface ContentScriptController {
  /**
   * Re-fetch the open thread's comment counts now (the panel just reported a
   * change). No-op when no thread is being rendered.
   */
  refreshComments(): void;
}

/**
 * Wire a provider adapter into the page: watch for thread changes, ask the
 * background for a summary, and render it above the provider's message list.
 *
 * Fails silently by construction. Anything unexpected — no anchor, signed out,
 * thread not synced, API down, snippet-kind (Gmail already shows its own
 * snippet) — renders nothing rather than putting an Aziru error in someone's
 * mailbox.
 */
export function runContentScript(adapter: ProviderAdapter): ContentScriptController {
  let widget: SummaryWidget | null = null;
  let scheduler: Scheduler | null = null;
  // Guards against a slow response landing after the user moved on.
  let requestToken = 0;
  // The active request's comment-count refetch, kept for the badge poll and
  // for the panel's commentsChanged nudge. Null while no thread is rendered.
  let refetchCommentsMeta: (() => void) | null = null;
  let commentsPollTimer: ReturnType<typeof setInterval> | null = null;

  function clearCommentsPoll(): void {
    if (commentsPollTimer) {
      clearInterval(commentsPollTimer);
      commentsPollTimer = null;
    }
    refetchCommentsMeta = null;
  }

  function teardownWidget(): void {
    widget?.remove();
    widget = null;
    requestToken++;
    clearCommentsPoll();
  }

  /**
   * Returns false when the page was not ready (no visible account, or the message
   * list has not rendered yet) so the scheduler retries on the next mutation tick
   * instead of latching. Returns true once a widget is mounted and the request is
   * in flight.
   */
  function requestSummary(context: ThreadContext, force = false): boolean {
    if (!context.accountEmail) {
      debugLog("no visible account email yet — cannot safely pick a mailbox");
      return false;
    }
    const token = ++requestToken;

    if (!adapter.findInjectionAnchor()) {
      debugLog("no injection anchor yet (message list not rendered)");
      return false;
    }

    const mountOpts: MountOptions = {
      ...(adapter.gutterLeft ? { gutterLeft: adapter.gutterLeft } : {}),
      ...(adapter.onOpenComments
        ? { onOpenComments: () => adapter.onOpenComments?.(context) }
        : {}),
    };

    // Nothing is mounted until the server answers. Eligibility (automated,
    // excluded by the visibility gate, not synced) is only known server-side,
    // and a skeleton that then vanishes reads as a glitch on every thread that
    // gets no card. Gmail/OWA already show the thread underneath, so waiting
    // costs little on the threads that do get one.
    widget?.remove();
    widget = null;
    debugLog(
      `requesting summary — account=${context.accountEmail} thread=${context.providerThreadId}`,
    );

    // The two responses for THIS request. The summary decides the card's shape;
    // the comment count decorates it — or, on a snippet thread with discussion,
    // IS the card. Whichever lands second recomposes via apply().
    let outcome: ThreadSummaryPayload | null = null;
    let summaryResolved = false;
    let comments: WidgetComments | null = null;

    // The bubble targets the injected panel; a dead target (kill switch,
    // build without a panel) means no bubble, checked at every recompose.
    function currentComments(): WidgetComments | null {
      return comments && (adapter.isCommentsTargetLive?.() ?? false) ? comments : null;
    }

    // First real content mounts the card; later content re-renders it in place.
    function show(state: WidgetState): void {
      if (widget) {
        widget.update(state);
        return;
      }
      const liveAnchor = adapter.findInjectionAnchor();
      if (!liveAnchor) {
        debugLog("anchor gone before mount");
        return;
      }
      widget = mountSummaryWidget(liveAnchor, state, mountOpts);
    }

    function apply(): void {
      if (token !== requestToken || !summaryResolved) return;
      const c = currentComments();
      if (outcome === null || outcome.kind === "snippet") {
        // Gmail and OWA already show their own snippet; repeating it adds
        // noise. But a thread with team discussion still gets the one-line
        // comments strip — removed (not torn down: the token stays valid so a
        // count that arrives later can still mount the strip) otherwise.
        if (c && c.total > 0) {
          show({ kind: "commentsOnly", comments: c });
        } else if (widget) {
          widget.remove();
          widget = null;
        }
        return;
      }
      if (outcome.kind === "quota") {
        show({ kind: "quota", resetsAt: outcome.resetsAt });
        return;
      }
      if (outcome.kind === "bullets") {
        show({ kind: "bullets", bullets: outcome.bullets, ...(c ? { comments: c } : {}) });
        return;
      }
      show({ kind: "summary", text: outcome.text, ...(c ? { comments: c } : {}) });
    }

    const message: ThreadSummaryRequest = {
      type: THREAD_SUMMARY_MESSAGE,
      accountEmail: context.accountEmail,
      providerThreadId: context.providerThreadId,
      ...(force ? { force: true } : {}),
    };

    void ext.runtime
      .sendMessage(message)
      .then((response: ThreadSummaryResponse | undefined) => {
        if (token !== requestToken) return;
        if (!response?.ok) {
          debugLog(`background declined: ${response?.reason ?? "no response"}`);
          // A decline covers the count too (same auth, same workspace), so the
          // token bump that kills the pending meta response is correct here.
          teardownWidget();
          // A settled "no" for the whole workspace, not a miss on this thread:
          // stop watching rather than spending a roundtrip per thread open.
          if (response?.reason === "injectionDisabled") stop();
          return;
        }
        debugLog(`background returned kind=${response.result.kind}`);
        outcome = response.result;
        summaryResolved = true;
        apply();
      })
      .catch((e) => {
        if (token !== requestToken) return;
        debugLog("sendMessage failed:", e);
        show({
          kind: "error",
          onRetry: () => {
            requestSummary(context, true);
          },
        });
      });

    // The count rides in parallel and never blocks the summary. Any failure
    // renders no bubble — the summary-reason convention: nothing, not an error.
    // While the thread stays open the count stays fresh two ways: a background
    // poll (teammate activity) and the panel's commentsChanged nudge routed in
    // through refetchCommentsMeta (the user's own posts, instantly).
    clearCommentsPoll();
    if (adapter.onOpenComments) {
      const metaMessage: CommentMetaRequest = {
        type: COMMENT_META_MESSAGE,
        accountEmail: context.accountEmail,
        providerThreadId: context.providerThreadId,
      };
      const sendMeta = () => {
        void ext.runtime
          .sendMessage(metaMessage)
          .then((response: CommentMetaResponse | undefined) => {
            if (token !== requestToken) return;
            if (!response?.ok) return;
            comments = response.meta;
            apply();
          })
          .catch(() => {});
      };
      sendMeta();
      refetchCommentsMeta = sendMeta;
      commentsPollTimer = setInterval(() => {
        if (token !== requestToken) {
          clearCommentsPoll();
          return;
        }
        // A background tab pays nothing; the next visible poll catches up.
        if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
        sendMeta();
      }, COMMENT_META_POLL_MS);
    }

    // Mounted and in flight: the scheduler can stop retrying this thread.
    return true;
  }

  /** Tear down the watcher and anything on screen. Re-entered only by a reload. */
  function stop(): void {
    scheduler?.stop();
    scheduler = null;
    teardownWidget();
    removeExistingWidgets();
  }

  const controller: ContentScriptController = {
    refreshComments() {
      refetchCommentsMeta?.();
    },
  };

  function start(): void {
    if (scheduler) return;
    scheduler = startScheduler({
      detect: adapter.detectThread,
      onThread: (context) => requestSummary(context),
      // (returns false while the SPA is still painting, so the scheduler retries)
      onLeave: teardownWidget,
    });
  }

  // A reload can leave a widget from the previous document behind in a bfcached
  // page; start from a clean slate.
  removeExistingWidgets();

  // Whether the card renders at all is a workspace setting (web app, on by
  // default), enforced server-side on the provider-thread summary route — the
  // extension is the half we do not control, so an old build must still stop
  // injecting. The scheduler always starts; the first thread open in a disabled
  // workspace comes back "injectionDisabled" and stops it. Re-enabling therefore
  // takes effect on the next page load, which is the right trade for not paying
  // a roundtrip per thread open forever.
  start();

  return controller;
}
