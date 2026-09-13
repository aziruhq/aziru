import { Hono } from "hono";
import { z } from "zod";
import {
  db,
  resolveInboxQuota,
  recordMeterUsage,
  messageSetSignature,
  type InboxQuota,
  type Prisma,
} from "@aziru/db";
import { resolveProviderRef } from "../services/provider-thread.js";
import {
  buildThreadVisibilityWhere,
  DEFAULT_THREAD_VISIBILITY,
} from "../services/thread-visibility.js";
import {
  createAIProvider,
  generateThreadSummary,
  getSummaryAIProviderConfig,
  SUMMARY_PROMPT_VERSION,
  type SummaryFormat,
  type ThreadMessage,
} from "@aziru/ai";
import { getThreadSummaryLimit, getSummaryQuotaResetsAt } from "@aziru/shared";
import { matchLocale, LOCALE_ENGLISH_LANGUAGE_NAMES } from "@aziru/i18n";
import { config } from "@aziru/config";
import { createMailProvider } from "@aziru/mail";

// ─── Lazy thread summaries ─────────────────────────────────────────────────────
//
// A short AI TL;DR of a thread, generated the first time someone opens it and
// cached in ThreadSummary. Three surfaces call these routes: the web thread
// preview, the extension side panel, and the native Gmail/Outlook injection
// (which resolves by provider thread id instead of our own).
//
// The native injection route is additionally gated by the workspace's thread
// visibility (trash, spam, promotions, blacklist) plus isAutomated: a mail page
// can open any thread, including ones triage excludes, and those must never get
// a card. They answer 404, which the content script renders as nothing.
//
// Cost shape:
//   - Empty and automated threads never call the LLM: an automated/bulk thread
//     already reads as its own summary, and a thread sync stored with no messages
//     has nothing to summarize, so they return {kind:"snippet"} with no row and
//     no meter. Single-message threads ARE summarized (client requirement).
//   - A cache hit (signature + locale unchanged) is a plain read.
//   - Only a committed generation records a THREAD_SUMMARY meter unit. FAILED rows
//     never burn quota, so retrying a server-side failure is free.
//
// Privacy: this module logs ids, statuses, and lengths only. Summary text, message
// bodies, prompts, and raw model output are never logged.

const threadParams = z.object({
  workspaceId: z.string().min(1),
  threadId: z.string().min(1),
});

const providerThreadParams = z.object({
  workspaceId: z.string().min(1),
  providerThreadId: z.string().min(1),
  // See ProviderRefKind: absent means a conversation id, "message" is the OWA
  // deeplink read view, whose DOM can name no conversation.
  ref: z.enum(["thread", "message"]).default("thread"),
});

/**
 * How long a GENERATING row is treated as in-flight. Shorter than the draft
 * equivalent (5 min): a summary is a single small call, so a row older than this
 * is a crashed request, not a slow one, and the next open should retry rather
 * than poll forever.
 */
const SUMMARY_GENERATING_STALE_MS = 2 * 60 * 1_000;

type SummaryBody = {
  kind: "summary";
  format: SummaryFormat;
  summary: string;
  bullets: string[];
  locale: string;
  generatedAt: string | null;
};

type SummaryOutcome =
  | { status: 200; body: { kind: "snippet"; snippet: string } }
  | { status: 200; body: SummaryBody }
  | { status: 201; body: SummaryBody }
  | { status: 202; body: { generating: true } }
  | { status: 429; body: { error: string; used: number; limit: number; resetsAt: string } }
  | { status: 404; body: { error: string } }
  | { status: 500; body: { error: string } }
  | { status: 503; body: { error: string } };

function readyBody(row: {
  summary: string | null;
  bullets: string[];
  format: SummaryFormat;
  locale: string;
  generatedAt: Date | null;
}): SummaryBody {
  return {
    kind: "summary",
    format: row.format,
    summary: row.summary ?? "",
    bullets: row.bullets,
    locale: row.locale,
    generatedAt: row.generatedAt?.toISOString() ?? null,
  };
}

/** A cached row is servable only if it is READY and carries actual content. */
function hasContent(row: { summary: string | null; bullets: string[]; format: SummaryFormat }): boolean {
  return row.format === "BULLETS" ? row.bullets.length > 0 : !!row.summary;
}

/**
 * Get-or-generate, shared by the id-based and provider-id-based routes.
 *
 * `threadId` is our own EmailThread id; both routes resolve to one before calling
 * here, so authorization stays a single workspace-scoped lookup. `where` narrows
 * that lookup further (the injection route's visibility gate); a thread it
 * excludes is a 404, indistinguishable from one that does not exist.
 */
async function getOrGenerateSummary(
  workspaceId: string,
  threadId: string,
  force: boolean,
  where: Prisma.EmailThreadWhereInput = {},
): Promise<SummaryOutcome> {
  const thread = await db.emailThread.findFirst({
    where: { id: threadId, workspaceId, ...where },
    select: {
      id: true,
      subject: true,
      isAutomated: true,
      providerThreadId: true,
      messages: {
        orderBy: { receivedAt: "asc" },
        select: {
          // Split off before the AI layer — internal/provider ids never reach a prompt.
          providerMessageId: true,
          subject: true,
          senderEmail: true,
          senderName: true,
          bodyText: true,
          snippet: true,
          receivedAt: true,
        },
      },
    },
  });
  if (!thread) return { status: 404, body: { error: "Thread not found" } };

  // ── Snippet-only gate ───────────────────────────────────────────────────────
  // Checked before anything else: an automated/bulk thread already reads as its
  // own summary, and a thread with no stored messages (excluded at sync, flags
  // only) has nothing to summarize. No row, no LLM call, no meter. Single-message
  // threads deliberately fall through: a summary of one email is still wanted.
  if (thread.messages.length === 0 || thread.isAutomated) {
    const snippet = thread.messages[thread.messages.length - 1]?.snippet ?? "";
    return { status: 200, body: { kind: "snippet", snippet } };
  }

  const signature = messageSetSignature(thread.messages.map((m) => m.providerMessageId));

  const workspace = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: { locale: true },
  });
  if (!workspace) return { status: 404, body: { error: "Workspace not found" } };
  const locale = workspace.locale;

  const staleThreshold = new Date(Date.now() - SUMMARY_GENERATING_STALE_MS);

  // ── Quick check outside the lock ────────────────────────────────────────────
  // The overwhelmingly common case is re-opening a thread whose summary is already
  // cached; that path must not take a row lock.
  const existing = await db.threadSummary.findUnique({
    where: { emailThreadId: threadId },
    select: {
      status: true,
      summary: true,
      bullets: true,
      format: true,
      promptVersion: true,
      locale: true,
      messageSetSignature: true,
      generatedAt: true,
      updatedAt: true,
    },
  });
  if (
    !force &&
    existing?.status === "READY" &&
    existing.messageSetSignature === signature &&
    existing.locale === locale &&
    existing.promptVersion === SUMMARY_PROMPT_VERSION &&
    hasContent(existing)
  ) {
    return { status: 200, body: readyBody(existing) };
  }
  if (existing?.status === "GENERATING" && existing.updatedAt > staleThreshold) {
    return { status: 202, body: { generating: true } };
  }

  // Inbox-keyed summary meter (reset-immune, pooled by inbox, sized by the top plan
  // among workspaces sharing the inbox). Null for the mock/dev path with no
  // connection, where summaries are not metered. `used` here is informational —
  // the gate re-reads it transactionally under the workspace lock below.
  // provider/encryptedRefreshToken are for the live body fetch below;
  // emailAddress keys the meter.
  const connection = await db.emailConnection.findUnique({
    where: { workspaceId },
    select: { provider: true, emailAddress: true, encryptedRefreshToken: true },
  });
  const quota: InboxQuota | null = connection
    ? await resolveInboxQuota(connection.emailAddress, "THREAD_SUMMARY")
    : null;

  let provider;
  try {
    provider = createAIProvider(getSummaryAIProviderConfig());
  } catch (e) {
    return { status: 503, body: { error: `AI provider not configured: ${String(e)}` } };
  }

  // ── Atomic quota check + placeholder ────────────────────────────────────────
  // SELECT FOR UPDATE on the Workspace row serializes concurrent opens of any
  // thread in this workspace, so two requests cannot both pass the quota check
  // before either has claimed the GENERATING row.
  type TxResult =
    | { kind: "claimed" }
    | {
        kind: "cache_hit";
        row: {
          summary: string | null;
          bullets: string[];
          format: SummaryFormat;
          locale: string;
          generatedAt: Date | null;
        };
      }
    | { kind: "generating" }
    | { kind: "quota_exceeded"; used: number; limit: number };

  const txResult = await db.$transaction(async (tx): Promise<TxResult> => {
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`;

    const underLock = await tx.threadSummary.findUnique({
      where: { emailThreadId: threadId },
      select: {
        status: true,
        summary: true,
        bullets: true,
        format: true,
        promptVersion: true,
        locale: true,
        messageSetSignature: true,
        generatedAt: true,
        updatedAt: true,
      },
    });
    if (
      !force &&
      underLock?.status === "READY" &&
      underLock.messageSetSignature === signature &&
      underLock.locale === locale &&
      underLock.promptVersion === SUMMARY_PROMPT_VERSION &&
      hasContent(underLock)
    ) {
      return { kind: "cache_hit", row: underLock };
    }
    if (underLock?.status === "GENERATING" && underLock.updatedAt > staleThreshold) {
      return { kind: "generating" };
    }

    if (config.billing.enforceSummaryQuota && quota) {
      const limit = getThreadSummaryLimit(quota.plan);
      const meterRow = await tx.inboxUsageMeter.findUnique({
        where: {
          inboxKey_kind_windowStart: {
            inboxKey: quota.inboxKey,
            kind: "THREAD_SUMMARY",
            windowStart: quota.windowStart,
          },
        },
        select: { used: true },
      });
      const used = meterRow?.used ?? 0;
      if (used >= limit) return { kind: "quota_exceeded", used, limit };
    }

    // Claim the row. A stale summary's text is deliberately retained on the row
    // (the UI shows nothing until the new one lands, but a failed regeneration
    // leaves the previous text recoverable rather than destroyed).
    await tx.threadSummary.upsert({
      where: { emailThreadId: threadId },
      create: {
        workspaceId,
        emailThreadId: threadId,
        status: "GENERATING",
        locale,
        promptVersion: SUMMARY_PROMPT_VERSION,
        messageSetSignature: signature,
      },
      update: {
        status: "GENERATING",
        locale,
        promptVersion: SUMMARY_PROMPT_VERSION,
        messageSetSignature: signature,
        errorMessage: null,
      },
    });
    return { kind: "claimed" };
  });

  if (txResult.kind === "cache_hit") return { status: 200, body: readyBody(txResult.row) };
  if (txResult.kind === "generating") return { status: 202, body: { generating: true } };
  if (txResult.kind === "quota_exceeded") {
    return {
      status: 429,
      body: {
        error: "Monthly thread summary quota exceeded",
        used: txResult.used,
        limit: txResult.limit,
        resetsAt: getSummaryQuotaResetsAt(new Date()).toISOString(),
      },
    };
  }

  // Fetch full body texts live from the provider (one call for the whole
  // thread), exactly as drafts do. The DB deliberately stores bodyText: null
  // ("store minimal email data"), so the stored rows alone cannot feed a
  // summary. Fallback chain per message: live body → stored bodyText (mock/dev
  // inbox) → stored snippet — the snippet is a real 200-char preview, so even
  // with the provider unreachable the model sees content, not "(no body)".
  // Values may be null (a message the provider returned no excerpt for); the ??
  // chain below lets those fall through to the stored body / snippet.
  let bodyByMessageId = new Map<string, string | null>();
  if (connection?.encryptedRefreshToken) {
    try {
      const client = createMailProvider(connection);
      const snapshot = await client.getThreadSnapshot(thread.providerThreadId);
      bodyByMessageId = new Map(
        snapshot.messages.map((m) => [m.providerMessageId, m.bodyExcerpt]),
      );
    } catch {
      // Non-fatal: fall back to stored values.
    }
  }
  const aiMessages: ThreadMessage[] = thread.messages.map(
    ({ providerMessageId, snippet, ...m }) => ({
      ...m,
      bodyText: bodyByMessageId.get(providerMessageId) ?? m.bodyText ?? snippet,
    }),
  );
  const targetLanguage = LOCALE_ENGLISH_LANGUAGE_NAMES[matchLocale([locale])];

  let result;
  try {
    result = await generateThreadSummary(provider, aiMessages, {
      targetLanguage,
      subject: thread.subject,
    });
  } catch (e) {
    await markFailed(threadId, String(e));
    return { status: 500, body: { error: "Summary generation failed" } };
  }
  if (!result) {
    await markFailed(threadId, "LLM returned invalid output");
    return { status: 500, body: { error: "Summary generation failed" } };
  }

  const generatedAt = new Date();
  await db.threadSummary.update({
    where: { emailThreadId: threadId },
    data: {
      status: "READY",
      format: result.format,
      summary: result.text,
      bullets: result.bullets,
      model: provider.modelName,
      generatedAt,
      errorMessage: null,
    },
  });

  // Record the committed generation against the reset-immune inbox meter. FAILED
  // rows above never reach here, so a server-side failure never burns allowance.
  // Runs regardless of the enforce flag (self-host observability).
  if (quota) {
    await recordMeterUsage({
      inboxKey: quota.inboxKey,
      kind: "THREAD_SUMMARY",
      windowStart: quota.windowStart,
      delta: 1,
    });
  }

  console.log(
    `[thread-summary] Generated summary for thread ${threadId} ` +
      `(format=${result.format}, ${result.text?.length ?? result.bullets.length} ` +
      `${result.format === "BULLETS" ? "bullets" : "chars"})`,
  );
  return {
    status: 201,
    body: {
      kind: "summary",
      format: result.format,
      summary: result.text ?? "",
      bullets: result.bullets,
      locale,
      generatedAt: generatedAt.toISOString(),
    },
  };
}

/** Flip the claimed row to FAILED. `message` is an error string only, never content. */
async function markFailed(threadId: string, message: string): Promise<void> {
  await db.threadSummary
    .update({
      where: { emailThreadId: threadId },
      data: { status: "FAILED", errorMessage: message },
    })
    .catch(() => {});
}

const summary = new Hono();

// ─── POST /workspaces/:workspaceId/email-threads/:threadId/summary ─────────────
//
// Get-or-generate for the web preview and the extension side panel. Send
// X-Force-Regenerate: 1 to bypass the cache (counts against quota like any other
// generation).

summary.post("/workspaces/:workspaceId/email-threads/:threadId/summary", async (c) => {
  const parsed = threadParams.safeParse({
    workspaceId: c.req.param("workspaceId"),
    threadId: c.req.param("threadId"),
  });
  if (!parsed.success) return c.json({ error: "Invalid params" }, 400);

  const force = c.req.header("X-Force-Regenerate") === "1";
  const outcome = await getOrGenerateSummary(parsed.data.workspaceId, parsed.data.threadId, force);
  return c.json(outcome.body, outcome.status);
});

// ─── POST /workspaces/:workspaceId/provider-threads/:providerThreadId/summary ──
//
// Same thing, addressed by the provider's own thread id. Used by the native
// Gmail/Outlook content scripts, which know the mailbox's thread id but not ours.
// Resolves across every email account in the workspace via the
// (emailAccountId, providerThreadId) unique key. A thread we have not synced is a
// 404 and the content script renders nothing.

summary.post("/workspaces/:workspaceId/provider-threads/:providerThreadId/summary", async (c) => {
  const parsed = providerThreadParams.safeParse({
    workspaceId: c.req.param("workspaceId"),
    providerThreadId: c.req.param("providerThreadId"),
    ref: c.req.query("ref") ?? undefined,
  });
  if (!parsed.success) return c.json({ error: "Invalid params" }, 400);
  const { workspaceId, providerThreadId, ref } = parsed.data;

  // One read for both the kill switch and the visibility filters (the same
  // shape as panel-queue). A missing row means defaults, and injection defaults
  // to on; see provider-thread.ts for why the switch is enforced server-side.
  const settings = await db.gmailSyncSettings.findUnique({
    where: { workspaceId },
    select: {
      threadSummaryInjectionEnabled: true,
      includeSpam: true,
      includePromotions: true,
      blacklistedSenderEmails: true,
    },
  });
  if (settings && !settings.threadSummaryInjectionEnabled) {
    return c.json(
      {
        error: "Thread summary injection is disabled for this workspace",
        injectionDisabled: true,
      },
      403,
    );
  }

  const threadId = await resolveProviderRef(workspaceId, ref, providerThreadId);
  if (!threadId) return c.json({ error: "Thread not found" }, 404);

  // Threads triage excludes never get a card, even though sync persists them
  // (flags only) and the resolver above finds them.
  const force = c.req.header("X-Force-Regenerate") === "1";
  const outcome = await getOrGenerateSummary(workspaceId, threadId, force, {
    ...buildThreadVisibilityWhere(workspaceId, settings ?? DEFAULT_THREAD_VISIBILITY),
    isAutomated: false,
  });
  return c.json(outcome.body, outcome.status);
});

export { summary as threadSummaryRoute };
