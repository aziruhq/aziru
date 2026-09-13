// English-only UI strings for the injected widget.
//
// NOT Lingui-wrapped, deliberately. The content scripts are standalone IIFE
// bundles injected into a third-party page; pulling in @lingui/core plus all
// sixteen compiled catalogs to translate four short labels would multiply the
// injected bundle for no proportionate gain. The summary text itself — the only
// substantial content in the widget — is already generated in the workspace
// locale by the server, so a non-English user still reads their own language.
//
// FOLLOW-UP: if the widget grows beyond these labels, move it to Lingui and load
// only the active locale's catalog at runtime.
export const STRINGS = {
  eyebrow: "Summary",
  error: "Could not summarize this thread.",
  retry: "Retry",
  quota: (resetsAt: string) => `No summaries remaining this month · resets ${resetsAt}`,
  /** Eyebrow of the comments-only strip (threads with discussion but no summary card). */
  commentsEyebrow: "Comments",
  /** Accessible name of the comment bubble; the visible control is icon + count. */
  commentsLabel: (total: number, unread: number) => {
    if (total === 0) return "Open team comments";
    const base = total === 1 ? "Open team comments (1 comment" : `Open team comments (${total} comments`;
    return unread > 0 ? `${base}, ${unread} new)` : `${base})`;
  },
} as const;

/**
 * Labels for the "Aziru Reply" button in the provider's own compose. Short by
 * necessity: they sit in a crowded native toolbar next to Send, so the detail
 * goes in the tooltip and the label stays scannable.
 */
export const REPLY_BUTTON_STRINGS = {
  idle: "Aziru Reply",
  /** Hover tooltip on the injected entry points (bottom-bar pill, header icon). */
  entryTooltip: "Reply with Aziru",
  generating: "Drafting…",
  readyToInsert: "Click Reply to insert",
  error: "Couldn't draft",
  signedOut: "Sign in to Aziru",
  quota: "No drafts left",
  tooltips: {
    idle: "Draft a reply to this thread with Aziru",
    generating: "Aziru is writing a reply…",
    inserted: "Draft inserted. Click again to re-insert it (replaces the inserted text).",
    readyToInsert: "Your draft is ready — it will be inserted when the reply opens.",
    error: "Something went wrong. Click to try again.",
    signedOut: "Open the Aziru panel to sign in",
    quota: (resetsAt: string) => `No drafts remaining this month · resets ${resetsAt}`,
  },
} as const;

/**
 * The OWA drawer's collapse tab. English-only for the same reason as the labels
 * above; everything the drawer actually shows is inside the panel iframe, which
 * is an extension document with the full catalog.
 */
export const PANEL_TAB_STRINGS = {
  open: "Open the Aziru panel",
  close: "Close the Aziru panel",
  title: "Aziru",
} as const;

/** Short, UTC-stable reset date ("Aug 1"), matching the in-app quota copy. */
export function formatResetDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });
}
