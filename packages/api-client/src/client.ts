import type { TaxonomyTransferFile } from "@aziru/shared";
import type { ApiTransport, TransportInit } from "./transport.js";
import type {
  Workspace,
  TaxonomyNode,
  CreateTaxonomyNodeInput,
  UpdateTaxonomyNodeInput,
  TaxonomyEdge,
  CreateTaxonomyEdgeInput,
  UpdateTaxonomyEdgeInput,
  GmailConnection,
  ConnectGmailInput,
  ConnectOutlookInput,
  DisconnectResult,
  SyncStatus,
  GmailSyncSettings,
  GmailSyncSettingsResponse,
  FolderCountsResult,
  EmailThreadListResult,
  EmailThreadDetail,
  PanelQueueResult,
  MailAccountsResult,
  TriageStatus,
  DoneMark,
  ThreadAssignment,
  NotificationListResult,
  UnreadCountResult,
  Draft,
  GenerateDraftResult,
  ThreadSummaryResult,
  ThreadSummaryFormat,
  ThreadCommentItem,
  ThreadCommentListResult,
  ThreadCommentsMeta,
  CreateThreadCommentClientInput,
  MockInboxEventInput,
  MockInboxResult,
  CandidateNodeInput,
  CandidateNodeResult,
  LLMNodeSelectionResult,
  GmailRecentThreadsResult,
  GmailSortResult,
  QueuedResult,
  OkResult,
  QuotaInfo,
  RegisterPushDeviceInput,
  RegisterPushDeviceResult,
  RegisterExtensionInput,
  RegisterExtensionResult,
  CreateBridgeCodeResult,
  CurrentUser,
  UpdateCurrentUserInput,
  TaxonomyGenerationStatusResult,
  TaxonomyTemplateRecommendationResult,
  TaxonomyImportPreviewResult,
  TaxonomyImportResult,
  TaxonomyMigrationMapping,
} from "./types.js";

/**
 * The workspace has turned off native thread-summary injection into Gmail/OWA.
 *
 * Its own error type rather than a generic failure because the two call for
 * opposite responses: a failure is worth retrying on the next thread open, a
 * refusal is not — the content script latches on this and stops asking.
 * Only the provider-id routes (providerThreadSummary, generateDraftByProviderThread)
 * can raise it; Aziru's own surfaces are not gated.
 */
export class InjectionDisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InjectionDisabledError";
  }
}

/**
 * Which kind of provider id the three provider-id routes are being given.
 *
 * "thread" is the default and the ordinary case: a mail page names the
 * conversation it is showing. "message" is for OWA's standalone deeplink read
 * view, an ITEM view that carries no conversation id anywhere in its DOM — its
 * only id is the message's, which the server resolves through
 * `providerMessageId`. Kept explicit end to end: both flavors are 68-char base64
 * for a consumer mailbox, so a wrong kind must fail rather than resolve as the
 * other.
 */
export type ProviderRefKind = "thread" | "message";

/** The query suffix for a non-default ref kind, or nothing at all. */
function providerRefQuery(refKind: ProviderRefKind | undefined): string {
  return refKind === "message" ? "?ref=message" : "";
}

/**
 * A non-ok API response, carrying the status and parsed body.
 *
 * Callers that only log the failure keep working: this is still an Error and
 * the message is unchanged. Callers that must branch on the outcome (403 means
 * "not allowed to edit the taxonomy", 409 means "a generation is already
 * running", 429 carries `reason`/`nextEligibleAt`) read `status` and `body`
 * instead of matching on the message text.
 */
export class ApiHttpError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown> | null;

  constructor(message: string, status: number, body: Record<string, unknown> | null) {
    super(message);
    this.name = "ApiHttpError";
    this.status = status;
    this.body = body;
  }
}

// A failed response may carry no body, or a body that is not JSON. Neither is
// worth failing over on top of the failure we are already reporting.
async function readErrorBody(res: Response): Promise<Record<string, unknown> | null> {
  const parsed = await res.json().catch(() => null);
  return parsed !== null && typeof parsed === "object"
    ? (parsed as Record<string, unknown>)
    : null;
}

export function makeApiClient(transport: ApiTransport) {
  const base = transport.baseUrl;

  async function apiFetch<T>(path: string, opts?: { revalidate?: number }): Promise<T> {
    const init: TransportInit =
      opts?.revalidate !== undefined
        ? { next: { revalidate: opts.revalidate } }
        : { cache: "no-store" };
    const res = await transport.fetch(`${base}${path}`, init);
    if (!res.ok) {
      throw new ApiHttpError(
        `API ${path} returned ${res.status}`,
        res.status,
        await readErrorBody(res)
      );
    }
    return res.json() as Promise<T>;
  }

  async function apiMutate<T>(
    path: string,
    method: "POST" | "PATCH" | "DELETE",
    body?: unknown
  ): Promise<T> {
    const hasBody = body !== undefined;
    const res = await transport.fetch(`${base}${path}`, {
      method,
      headers: hasBody ? { "Content-Type": "application/json" } : {},
      body: hasBody ? JSON.stringify(body) : null,
      cache: "no-store",
    });
    if (!res.ok) {
      const body = await readErrorBody(res);
      const message =
        typeof body?.["error"] === "string"
          ? (body["error"] as string)
          : `API ${path} returned ${res.status}`;
      throw new ApiHttpError(message, res.status, body);
    }
    return res.json() as Promise<T>;
  }

  // Returns raw Response for endpoints that need custom status-code handling.
  async function apiRequest(path: string, init: TransportInit): Promise<Response> {
    return transport.fetch(`${base}${path}`, init);
  }

  // Shared by the two generate-draft entrypoints (our thread id vs the
  // provider's). Both map the same server outcomes onto GenerateDraftResult; the
  // provider-id route can additionally refuse with InjectionDisabledError.
  async function requestGenerateDraft(
    path: string,
    opts: { force?: boolean }
  ): Promise<GenerateDraftResult> {
    const res = await apiRequest(path, {
      method: "POST",
      cache: "no-store",
      headers: opts.force ? { "X-Force-Regenerate": "1" } : {},
    });
    if (res.status === 429) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return {
        quotaExceeded: true as const,
        used: typeof body["used"] === "number" ? body["used"] : 0,
        limit: typeof body["limit"] === "number" ? body["limit"] : 0,
        resetsAt: typeof body["resetsAt"] === "string" ? body["resetsAt"] : "",
      };
    }
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as {
        error?: string;
        injectionDisabled?: boolean;
      };
      // A refusal, not a failure: the button latches off instead of retrying.
      if (res.status === 403 && err.injectionDisabled) {
        throw new InjectionDisabledError(err.error ?? "Reply button injection is disabled");
      }
      throw new Error(err.error ?? `API returned ${res.status}`);
    }
    const data = (await res.json()) as { draft: Draft } | { generating: true };
    if ("draft" in data) {
      return { draft: data.draft, isNew: res.status === 201 };
    }
    return data;
  }

  // Shared by the two thread-summary entrypoints (our thread id vs the provider's).
  // Both map the same four server outcomes onto ThreadSummaryResult; the
  // provider-id route can additionally refuse with InjectionDisabledError.
  async function requestThreadSummary(
    path: string,
    opts: { force?: boolean }
  ): Promise<ThreadSummaryResult> {
    const res = await apiRequest(path, {
      method: "POST",
      cache: "no-store",
      headers: opts.force ? { "X-Force-Regenerate": "1" } : {},
    });
    if (res.status === 429) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return {
        quotaExceeded: true as const,
        used: typeof body["used"] === "number" ? body["used"] : 0,
        limit: typeof body["limit"] === "number" ? body["limit"] : 0,
        resetsAt: typeof body["resetsAt"] === "string" ? body["resetsAt"] : "",
      };
    }
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as {
        error?: string;
        injectionDisabled?: boolean;
      };
      // Distinguished from a generic failure so the caller can stop asking
      // instead of retrying a refusal on every thread open.
      if (res.status === 403 && err.injectionDisabled) {
        throw new InjectionDisabledError(err.error ?? "Thread summary injection is disabled");
      }
      throw new Error(err.error ?? `API returned ${res.status}`);
    }
    const data = (await res.json()) as
      | {
          kind: "summary";
          format?: ThreadSummaryFormat;
          summary: string;
          bullets?: string[];
          locale: string;
          generatedAt: string | null;
        }
      | { kind: "snippet"; snippet: string }
      | { generating: true };
    if ("kind" in data && data.kind === "summary") {
      return {
        kind: "summary",
        summary: {
          // Default to PROSE so a response from an older API (pre-bullets) still
          // renders rather than falling through to an empty card.
          format: data.format ?? "PROSE",
          text: data.summary,
          bullets: data.bullets ?? [],
          locale: data.locale,
          generatedAt: data.generatedAt,
        },
        isNew: res.status === 201,
      };
    }
    if ("kind" in data && data.kind === "snippet") {
      return { kind: "snippet", snippet: data.snippet };
    }
    return { generating: true };
  }

  return {
    // Authenticated identity for the current access token. Native clients read
    // emailVerified here to gate app access after sign-up.
    me: () => apiFetch<CurrentUser>("/auth/me"),

    // Re-send the email-verification link for the signed-in user. The API
    // throttles to one request per minute and returns 429 past that.
    resendVerification: () => apiMutate<OkResult>("/auth/resend-verification", "POST"),

    // Update the authenticated user's profile/preferences. Partial: only the
    // provided fields change (name empty string clears it).
    updateMe: (input: UpdateCurrentUserInput) =>
      apiMutate<CurrentUser>("/auth/me", "PATCH", input),

    // Permanently delete the authenticated user's account and all owned data.
    // Password is required for password-based accounts (step-up re-auth) and
    // omitted for federated accounts, which the server treats as "no password".
    deleteMe: (password?: string) =>
      apiMutate<OkResult>("/auth/me", "DELETE", password ? { password } : undefined),

    workspaces: () =>
      apiFetch<Workspace[]>("/workspaces"),

    // Create a free workspace for the authenticated user. Returns 409 if the
    // user already owns a free workspace (paid creation happens on the web).
    createWorkspace: (name: string) =>
      apiMutate<Workspace>("/workspaces", "POST", { name }),

    // Update a workspace's name and/or language (OWNER only). Returns the
    // updated workspace.
    updateWorkspace: (workspaceId: string, updates: { name?: string; locale?: string }) =>
      apiMutate<Workspace>(`/workspaces/${workspaceId}`, "PATCH", updates),

    // Wipe a workspace's Gmail connection, synced emails, and taxonomy back to
    // Inbox (OWNER only). Keeps the workspace and its members.
    resetWorkspace: (workspaceId: string) =>
      apiMutate<OkResult>(`/workspaces/${workspaceId}/reset`, "POST"),

    // Permanently delete a workspace and all its data (OWNER only). The API
    // rejects deleting the user's only owned workspace.
    deleteWorkspace: (workspaceId: string) =>
      apiMutate<OkResult>(`/workspaces/${workspaceId}`, "DELETE"),

    gmailConnection: (workspaceId: string) =>
      apiFetch<GmailConnection>(`/workspaces/${workspaceId}/gmail-connection`),

    // Connect (or reconnect) Gmail for the workspace. Accepts the serverAuthCode
    // from the mobile Google Sign-In. Owner-only. Returns the updated connection.
    connectGmail: (workspaceId: string, input: ConnectGmailInput) =>
      apiMutate<NonNullable<GmailConnection>>(
        `/workspaces/${workspaceId}/gmail-connection`,
        "POST",
        input,
      ),

    // Connect (or reconnect) Outlook for the workspace. The browser extension
    // supplies the Microsoft auth code + the chromiumapp.org redirect it was
    // minted for. Owner-only. Returns the updated connection.
    connectOutlook: (workspaceId: string, input: ConnectOutlookInput) =>
      apiMutate<NonNullable<GmailConnection>>(
        `/workspaces/${workspaceId}/outlook-connection`,
        "POST",
        input,
      ),

    disconnectGmail: (workspaceId: string, eraseData: boolean) =>
      apiMutate<DisconnectResult>(
        `/workspaces/${workspaceId}/gmail-connection${eraseData ? "?eraseData=true" : ""}`,
        "DELETE"
      ),

    syncStatus: (workspaceId: string) =>
      apiFetch<SyncStatus>(`/workspaces/${workspaceId}/sync-status`),

    gmailSyncSettings: (workspaceId: string) =>
      apiFetch<GmailSyncSettingsResponse>(`/workspaces/${workspaceId}/gmail-sync-settings`),

    updateGmailSyncSettings: (workspaceId: string, patch: Partial<GmailSyncSettings>) =>
      apiMutate<GmailSyncSettings>(
        `/workspaces/${workspaceId}/gmail-sync-settings`,
        "PATCH",
        patch
      ),

    addBlacklistedEmail: (workspaceId: string, email: string) =>
      apiMutate<GmailSyncSettings>(
        `/workspaces/${workspaceId}/gmail-sync-settings/blacklist`,
        "POST",
        { email }
      ),

    removeBlacklistedEmail: (workspaceId: string, email: string) =>
      apiMutate<GmailSyncSettings>(
        `/workspaces/${workspaceId}/gmail-sync-settings/blacklist/${encodeURIComponent(email)}`,
        "DELETE"
      ),

    taxonomyNodes: (workspaceId: string) =>
      apiFetch<TaxonomyNode[]>(`/workspaces/${workspaceId}/taxonomy-nodes`),

    createTaxonomyNode: (workspaceId: string, input: CreateTaxonomyNodeInput) =>
      apiMutate<TaxonomyNode>(
        `/workspaces/${workspaceId}/taxonomy-nodes`,
        "POST",
        input
      ),

    updateTaxonomyNode: (workspaceId: string, nodeId: string, input: UpdateTaxonomyNodeInput) =>
      apiMutate<TaxonomyNode>(
        `/workspaces/${workspaceId}/taxonomy-nodes/${nodeId}`,
        "PATCH",
        input
      ),

    deleteTaxonomyNode: (workspaceId: string, nodeId: string, moveToNodeId?: string) =>
      apiMutate<OkResult>(
        `/workspaces/${workspaceId}/taxonomy-nodes/${nodeId}`,
        "DELETE",
        moveToNodeId ? { moveToNodeId } : undefined
      ),

    taxonomyEdges: (workspaceId: string) =>
      apiFetch<TaxonomyEdge[]>(`/workspaces/${workspaceId}/taxonomy-edges`),

    createTaxonomyEdge: (workspaceId: string, input: CreateTaxonomyEdgeInput) =>
      apiMutate<TaxonomyEdge>(
        `/workspaces/${workspaceId}/taxonomy-edges`,
        "POST",
        input
      ),

    updateTaxonomyEdge: (workspaceId: string, edgeId: string, input: UpdateTaxonomyEdgeInput) =>
      apiMutate<TaxonomyEdge>(
        `/workspaces/${workspaceId}/taxonomy-edges/${edgeId}`,
        "PATCH",
        input
      ),

    deleteTaxonomyEdge: (workspaceId: string, edgeId: string) =>
      apiMutate<OkResult>(
        `/workspaces/${workspaceId}/taxonomy-edges/${edgeId}`,
        "DELETE"
      ),

    // Preview the folder migration for replacing the taxonomy with `file`:
    // returns which old folders auto-map to new ones and how many threads migrate
    // vs re-sort. Advisory — the apply route re-validates everything.
    previewTaxonomyImport: (workspaceId: string, file: TaxonomyTransferFile) =>
      apiMutate<TaxonomyImportPreviewResult>(
        `/workspaces/${workspaceId}/taxonomy-import/preview`,
        "POST",
        file
      ),

    // Atomically replaces the workspace's non-root taxonomy from a transfer file
    // (the root node is preserved server-side). With a `mapping` (old node id →
    // new folder ref, or "resort"), threads under mapped folders carry over
    // instantly; the rest are re-sorted with AI. Without one, every sorted thread
    // is re-sorted (legacy behavior).
    importTaxonomy: (
      workspaceId: string,
      file: TaxonomyTransferFile,
      mapping?: TaxonomyMigrationMapping
    ) =>
      apiMutate<TaxonomyImportResult>(
        `/workspaces/${workspaceId}/taxonomy-import`,
        "POST",
        mapping ? { file, mapping } : file
      ),

    // Auto-generate-taxonomy-from-inbox. `generateTaxonomy` enqueues a run
    // (202); `taxonomyGeneration` polls status + eligibility and returns the
    // READY proposal for preview. Apply the proposal via `importTaxonomy`.
    generateTaxonomy: (workspaceId: string) =>
      apiMutate<{ ok: true; status: string }>(
        `/workspaces/${workspaceId}/taxonomy-generate`,
        "POST"
      ),

    taxonomyGeneration: (workspaceId: string) =>
      apiFetch<TaxonomyGenerationStatusResult>(
        `/workspaces/${workspaceId}/taxonomy-generate`
      ),

    // Deterministic best-fit template for the picker's "Recommended" badge.
    // No LLM; safe to call on picker open. Null when there is too little signal.
    taxonomyTemplateRecommendation: (workspaceId: string) =>
      apiFetch<TaxonomyTemplateRecommendationResult>(
        `/workspaces/${workspaceId}/taxonomy-template-recommendation`
      ),

    folderCounts: (workspaceId: string) =>
      apiFetch<FolderCountsResult>(`/workspaces/${workspaceId}/folder-counts`),

    emailThreads: (
      workspaceId: string,
      filters?: { nodeId?: string; status?: string; cursor?: string; important?: boolean; assigned?: boolean; q?: string }
    ) => {
      const params = new URLSearchParams();
      if (filters?.nodeId) params.set("nodeId", filters.nodeId);
      if (filters?.status) params.set("status", filters.status);
      if (filters?.cursor) params.set("cursor", filters.cursor);
      if (filters?.important) params.set("important", "true");
      if (filters?.assigned) params.set("assigned", "true");
      if (filters?.q && filters.q.trim()) params.set("q", filters.q.trim());
      const qs = params.toString();
      return apiFetch<EmailThreadListResult>(
        `/workspaces/${workspaceId}/email-threads${qs ? `?${qs}` : ""}`
      );
    },

    emailThread: (workspaceId: string, threadId: string) =>
      apiFetch<EmailThreadDetail>(
        `/workspaces/${workspaceId}/email-threads/${threadId}`
      ),

    // The same thread detail, addressed by the provider's own thread id. Used by
    // the panel injected into Gmail/Outlook, which knows the mailbox's id but not
    // ours: resolve + fetch in one round trip, on the critical path of every
    // conversation the user opens.
    //
    // Null means the thread has never been synced into Aziru (the panel shows
    // "not synced yet" — not an error). A workspace that has turned the panel off
    // raises InjectionDisabledError, which the panel latches on instead of
    // retrying per thread.
    resolveProviderThread: async (
      workspaceId: string,
      providerThreadId: string,
      refKind: ProviderRefKind = "thread",
    ): Promise<EmailThreadDetail | null> => {
      const res = await apiRequest(
        `/workspaces/${workspaceId}/provider-threads/${encodeURIComponent(providerThreadId)}` +
          (refKind === "message" ? "?ref=message" : ""),
        { cache: "no-store" },
      );
      if (res.status === 404) return null;
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as {
          error?: string;
          injectionDisabled?: boolean;
        };
        if (res.status === 403 && err.injectionDisabled) {
          throw new InjectionDisabledError(err.error ?? "The in-mail panel is disabled");
        }
        throw new ApiHttpError(
          err.error ?? `API returned ${res.status}`,
          res.status,
          null,
        );
      }
      return res.json() as Promise<EmailThreadDetail>;
    },

    // The comments badge for the in-page bubble on the injected summary card,
    // addressed by the provider's own thread id (the only id the mail page
    // knows). Null means the thread was never synced (no bubble — not an
    // error); a workspace that turned the panel off raises
    // InjectionDisabledError, same as resolveProviderThread.
    providerThreadCommentsMeta: async (
      workspaceId: string,
      providerThreadId: string,
      refKind: ProviderRefKind = "thread",
    ): Promise<ThreadCommentsMeta | null> => {
      const res = await apiRequest(
        `/workspaces/${workspaceId}/provider-threads/${encodeURIComponent(providerThreadId)}/comments/meta` +
          (refKind === "message" ? "?ref=message" : ""),
        { cache: "no-store" },
      );
      if (res.status === 404) return null;
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as {
          error?: string;
          injectionDisabled?: boolean;
        };
        if (res.status === 403 && err.injectionDisabled) {
          throw new InjectionDisabledError(err.error ?? "The in-mail panel is disabled");
        }
        throw new ApiHttpError(
          err.error ?? `API returned ${res.status}`,
          res.status,
          null,
        );
      }
      return res.json() as Promise<ThreadCommentsMeta>;
    },

    // What the injected panel shows when no conversation is open: the threads
    // waiting on this user, plus the counts its sorting strip needs. One slim
    // call instead of three to `emailThreads`, which would fetch every message
    // of every thread to render two lines each.
    //
    // Raises InjectionDisabledError on a workspace that switched the panel off,
    // exactly like resolveProviderThread — this route is the only place the
    // no-conversation view would otherwise learn about the kill switch.
    panelQueue: async (workspaceId: string): Promise<PanelQueueResult> => {
      const res = await apiRequest(`/workspaces/${workspaceId}/panel-queue`, {
        cache: "no-store",
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as {
          error?: string;
          injectionDisabled?: boolean;
        };
        if (res.status === 403 && err.injectionDisabled) {
          throw new InjectionDisabledError(err.error ?? "The in-mail panel is disabled");
        }
        throw new ApiHttpError(err.error ?? `API returned ${res.status}`, res.status, null);
      }
      return res.json() as Promise<PanelQueueResult>;
    },

    // Every mailbox connected to a workspace this user belongs to. One call, so
    // an injected surface can map the open mailbox to its workspace without
    // fanning out over workspaces.
    mailAccounts: () => apiFetch<MailAccountsResult>("/me/mail-accounts"),

    threadBodies: (workspaceId: string, threadId: string) =>
      apiFetch<{
        bodies: Record<string, string | null>;
        // Optional so an older server (no field) is tolerated. Keyed by DB message id.
        inlineImages?: Record<
          string,
          Array<{ attachmentId: string; mimeType: string; filename: string | null }>
        >;
      }>(`/workspaces/${workspaceId}/email-threads/${threadId}/bodies`),

    // Same-origin URL for a CID inline image, for use directly as an <img src>.
    // On the browser transport `base` is the cookie-authed Next proxy, so no
    // token handling is needed; native transports use fetchInlineImage instead.
    inlineImageUrl: (
      workspaceId: string,
      threadId: string,
      messageId: string,
      attachmentId: string
    ): string =>
      `${base}/workspaces/${workspaceId}/email-threads/${threadId}/messages/` +
      `${messageId}/inline-image?attachmentId=${encodeURIComponent(attachmentId)}`,

    // Fetch a CID inline image as a Blob for clients that cannot authenticate a
    // plain <img src> (the extension's Bearer transport). Resolves null on any
    // failure so the caller silently hides the image.
    fetchInlineImage: async (
      workspaceId: string,
      threadId: string,
      messageId: string,
      attachmentId: string
    ): Promise<Blob | null> => {
      try {
        const res = await apiRequest(
          `/workspaces/${workspaceId}/email-threads/${threadId}/messages/` +
            `${messageId}/inline-image?attachmentId=${encodeURIComponent(attachmentId)}`,
          { cache: "no-store" }
        );
        if (!res.ok) return null;
        return await res.blob();
      } catch {
        return null;
      }
    },

    triageThread: (
      workspaceId: string,
      threadId: string,
      // retractReference — sent by the Undo toast when reverting a move, so the
      // server deletes the thread's sorting-reference row instead of treating
      // the revert as a fresh human folder choice.
      action: { action: "move"; nodeId: string; retractReference?: boolean }
    ) =>
      apiMutate<{ ok: boolean; triageStatus: TriageStatus }>(
        `/workspaces/${workspaceId}/email-threads/${threadId}/triage`,
        "PATCH",
        action
      ),

    markThreadDone: (workspaceId: string, threadId: string, userId: string) =>
      apiMutate<{ ok: boolean; doneMark: DoneMark }>(
        `/workspaces/${workspaceId}/email-threads/${threadId}/resolve`,
        "POST",
        { userId }
      ),

    unmarkThreadDone: (workspaceId: string, threadId: string, userId: string) =>
      apiMutate<{ ok: boolean; doneMark: null }>(
        `/workspaces/${workspaceId}/email-threads/${threadId}/resolve`,
        "DELETE",
        { userId }
      ),

    // Assign a thread to a workspace member (set/replace). The server validates
    // that assigneeUserId is a member and records the actor from auth context.
    assignThread: (workspaceId: string, threadId: string, assigneeUserId: string) =>
      apiMutate<{ ok: boolean; assignment: ThreadAssignment }>(
        `/workspaces/${workspaceId}/email-threads/${threadId}/assignee`,
        "POST",
        { assigneeUserId }
      ),

    unassignThread: (workspaceId: string, threadId: string) =>
      apiMutate<{ ok: boolean; assignment: null }>(
        `/workspaces/${workspaceId}/email-threads/${threadId}/assignee`,
        "DELETE"
      ),

    // Set or clear the user-marked "important" star on a thread. The star is a
    // shared, workspace-level flag (any member can toggle it).
    setThreadImportant: (workspaceId: string, threadId: string, isImportant: boolean) =>
      apiMutate<{ ok: boolean; isImportant: boolean }>(
        `/workspaces/${workspaceId}/email-threads/${threadId}/important`,
        "PATCH",
        { isImportant }
      ),

    // ── Notifications (user-scoped) ────────────────────────────────────────────
    // `undismissedOnly` powers the bell pop-up feed: it hides notifications the
    // user has already dealt with. The full notifications page omits it and gets
    // everything, dismissed rows included.
    notifications: (
      cursor?: string,
      limit?: number,
      opts?: { undismissedOnly?: boolean }
    ) => {
      const qs = new URLSearchParams();
      if (cursor) qs.set("cursor", cursor);
      if (limit !== undefined) qs.set("limit", String(limit));
      if (opts?.undismissedOnly) qs.set("undismissed", "1");
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      return apiFetch<NotificationListResult>(`/notifications${suffix}`);
    },

    notificationsUnreadCount: () =>
      apiFetch<UnreadCountResult>("/notifications/unread-count"),

    markAllNotificationsRead: () =>
      apiMutate<{ ok: boolean; updated: number }>("/notifications/read-all", "POST"),

    // Batch mark read/unread. Accepts one id or a selection; foreign ids are
    // ignored server-side. Used by the notifications manager (per-row + batch).
    updateNotifications: (ids: string[], read: boolean) =>
      apiMutate<{ ok: boolean; updated: number }>("/notifications/update", "POST", { ids, read }),

    // Batch dismiss: mark as dealt-with so they leave the bell pop-up feed
    // (they remain on the full notifications page). Accepts one id or a
    // selection; foreign ids are ignored server-side.
    dismissNotifications: (ids: string[]) =>
      apiMutate<{ ok: boolean; dismissed: number }>("/notifications/dismiss", "POST", { ids }),

    // Batch delete. Accepts one id or a selection; foreign ids are ignored.
    deleteNotifications: (ids: string[]) =>
      apiMutate<{ ok: boolean; deleted: number }>("/notifications/delete", "POST", { ids }),

    aiClassify: (workspaceId: string, threadId: string) =>
      apiMutate<QueuedResult>(
        `/workspaces/${workspaceId}/email-threads/${threadId}/ai-classify`,
        "POST"
      ),

    aiTriage: (workspaceId: string, threadId: string) =>
      apiMutate<QueuedResult>(
        `/workspaces/${workspaceId}/email-threads/${threadId}/ai-triage`,
        "POST"
      ),

    cancelClassify: (workspaceId: string, threadId: string) =>
      apiMutate<{ cancelled: boolean; jobRemoved: boolean }>(
        `/workspaces/${workspaceId}/email-threads/${threadId}/classify`,
        "DELETE"
      ),

    sweepInbox: (workspaceId: string) =>
      apiMutate<{ ok: boolean; workspaceId: string }>(
        `/workspaces/${workspaceId}/sweep-inbox`,
        "POST"
      ),

    pauseSorting: (workspaceId: string) =>
      apiMutate<{ sortingPaused: boolean }>(
        `/workspaces/${workspaceId}/sorting-queue/pause`,
        "POST"
      ),

    resumeSorting: (workspaceId: string) =>
      apiMutate<{ sortingPaused: boolean; requeued: number }>(
        `/workspaces/${workspaceId}/sorting-queue/resume`,
        "POST"
      ),

    routeUnrouted: (workspaceId: string) =>
      apiMutate<{ queued: number }>(
        `/workspaces/${workspaceId}/sorting-queue/route-unrouted`,
        "POST"
      ),

    rerouteUnclassified: (workspaceId: string) =>
      apiMutate<{ queued: number }>(
        `/workspaces/${workspaceId}/sorting-queue/reroute-unclassified`,
        "POST"
      ),

    // How many NEEDS_REVIEW threads are eligible for one-click re-sort (their
    // plan changed since they were sorted, or their last sort hit a transient
    // error). Not all review threads qualify.
    needsReviewResortEligible: (workspaceId: string) =>
      apiFetch<{ eligible: number }>(
        `/workspaces/${workspaceId}/sorting-queue/reroute-needs-review`
      ),

    // Re-sort the eligible NEEDS_REVIEW threads through the routing pipeline.
    rerouteNeedsReview: (workspaceId: string) =>
      apiMutate<{ queued: number }>(
        `/workspaces/${workspaceId}/sorting-queue/reroute-needs-review`,
        "POST"
      ),

    generateDraft: (
      workspaceId: string,
      threadId: string,
      opts: { force?: boolean } = {}
    ): Promise<GenerateDraftResult> =>
      requestGenerateDraft(
        `/workspaces/${workspaceId}/email-threads/${threadId}/generate-draft`,
        opts
      ),

    // Same generation, addressed by the provider's own thread id. Used by the
    // native Gmail/Outlook reply button, which knows the mailbox's thread id but
    // not ours. Throws InjectionDisabledError when the workspace has turned the
    // button off, and a plain error on 404 (thread never synced into Aziru).
    generateDraftByProviderThread: (
      workspaceId: string,
      providerThreadId: string,
      opts: { force?: boolean; refKind?: ProviderRefKind } = {}
    ): Promise<GenerateDraftResult> =>
      requestGenerateDraft(
        `/workspaces/${workspaceId}/provider-threads/${encodeURIComponent(providerThreadId)}/generate-draft` +
          providerRefQuery(opts.refKind),
        opts
      ),

    draftQuota: (workspaceId: string) =>
      apiFetch<QuotaInfo>(`/workspaces/${workspaceId}/draft-quota`),

    // Get-or-generate the thread's AI TL;DR. Cheap and idempotent: the server
    // serves a cached summary when the message set and locale are unchanged, and
    // returns {kind:"snippet"} for empty/automated threads without ever
    // calling a model. force=true bypasses the cache and counts against quota.
    threadSummary: (workspaceId: string, threadId: string, opts: { force?: boolean } = {}) =>
      requestThreadSummary(
        `/workspaces/${workspaceId}/email-threads/${threadId}/summary`,
        opts
      ),

    // Same, addressed by the provider's own thread id. Used by the native
    // Gmail/Outlook injection, which knows the mailbox's id but not ours. Throws
    // on 404 (the thread has not been synced into Aziru).
    providerThreadSummary: (
      workspaceId: string,
      providerThreadId: string,
      opts: { force?: boolean; refKind?: ProviderRefKind } = {}
    ) =>
      requestThreadSummary(
        `/workspaces/${workspaceId}/provider-threads/${encodeURIComponent(providerThreadId)}/summary` +
          providerRefQuery(opts.refKind),
        opts
      ),

    // ── Thread comments ────────────────────────────────────────────────────
    // Internal-id addressing only: every comments surface (web, extension side
    // panel, injected panel) already holds the resolved thread id.

    listThreadComments: (workspaceId: string, threadId: string) =>
      apiFetch<ThreadCommentListResult>(
        `/workspaces/${workspaceId}/email-threads/${threadId}/comments`
      ),

    threadCommentsMeta: (workspaceId: string, threadId: string) =>
      apiFetch<ThreadCommentsMeta>(
        `/workspaces/${workspaceId}/email-threads/${threadId}/comments/meta`
      ),

    createThreadComment: (
      workspaceId: string,
      threadId: string,
      input: CreateThreadCommentClientInput
    ) =>
      apiMutate<{ ok: boolean; comment: ThreadCommentItem }>(
        `/workspaces/${workspaceId}/email-threads/${threadId}/comments`,
        "POST",
        input
      ),

    deleteThreadComment: (workspaceId: string, threadId: string, commentId: string) =>
      apiMutate<OkResult>(
        `/workspaces/${workspaceId}/email-threads/${threadId}/comments/${commentId}`,
        "DELETE"
      ),

    markThreadCommentsRead: (workspaceId: string, threadId: string) =>
      apiMutate<{ ok: boolean; lastReadAt: string }>(
        `/workspaces/${workspaceId}/email-threads/${threadId}/comments/read`,
        "POST"
      ),

    threadSortQuota: (workspaceId: string) =>
      apiFetch<QuotaInfo>(`/workspaces/${workspaceId}/thread-sort-quota`),

    threadDrafts: (workspaceId: string, threadId: string) =>
      apiFetch<{ drafts: Draft[] }>(
        `/workspaces/${workspaceId}/email-threads/${threadId}/drafts`
      ),

    toggleDraftSent: (
      workspaceId: string,
      threadId: string,
      draftId: string,
      sent: boolean
    ) =>
      apiMutate<{ draft: Draft }>(
        `/workspaces/${workspaceId}/email-threads/${threadId}/drafts/${draftId}`,
        "PATCH",
        { status: sent ? "SENT" : "PROPOSED" }
      ),

    // ── Push devices ─────────────────────────────────────────────────────────

    registerPushDevice: (input: RegisterPushDeviceInput) =>
      apiMutate<RegisterPushDeviceResult>("/devices", "POST", input),

    // ── Browser extension ──────────────────────────────────────────────────────

    registerExtension: (input: RegisterExtensionInput) =>
      apiMutate<RegisterExtensionResult>("/extension/register", "POST", input),

    // ── Web sign-in bridge ─────────────────────────────────────────────────────

    createBridgeCode: () => apiMutate<CreateBridgeCodeResult>("/auth/bridge/code", "POST"),

    // ── Dev endpoints ──────────────────────────────────────────────────────────

    mockInboxEvent: (workspaceId: string, input: MockInboxEventInput) =>
      apiMutate<MockInboxResult>(
        `/dev/workspaces/${workspaceId}/mock-inbox-event`,
        "POST",
        input
      ),

    candidateNodes: (workspaceId: string, input: CandidateNodeInput) =>
      apiMutate<CandidateNodeResult>(
        `/dev/workspaces/${workspaceId}/candidate-paths`,
        "POST",
        input
      ),

    llmNodeSelection: (workspaceId: string, input: CandidateNodeInput) =>
      apiMutate<LLMNodeSelectionResult>(
        `/dev/workspaces/${workspaceId}/llm-path-selection`,
        "POST",
        input
      ),

    gmailRecentThreads: (workspaceId: string) =>
      apiFetch<GmailRecentThreadsResult>(
        `/dev/workspaces/${workspaceId}/gmail-recent-threads`
      ),

    sortGmailThread: (workspaceId: string, gmailThreadId: string) =>
      apiMutate<GmailSortResult>(
        `/dev/workspaces/${workspaceId}/gmail-sort-thread`,
        "POST",
        { gmailThreadId }
      ),
  };
}

export type ApiClient = ReturnType<typeof makeApiClient>;
