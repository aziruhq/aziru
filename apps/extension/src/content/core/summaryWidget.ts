import { STRINGS, formatResetDate } from "./strings.js";
import { createLogoMark } from "./logoMark.js";

// Framework-free summary card injected into the mail page.
//
// Shadow DOM with an inlined <style> block: the page is Gmail's or OWA's, so
// none of the app's design tokens exist there and none of our class names are
// safe from theirs. A closed-off shadow root is the only way to guarantee the
// widget looks the same everywhere and cannot leak styles into the host page.
//
// The palette echoes em-summary-card without importing it, and follows the
// viewer's OS colour scheme.

/** The comments badge: the ONLY comment-derived data allowed into the page DOM
 *  (comment content stays in the extension-origin panel). */
export type WidgetComments = { total: number; unread: number };

export type WidgetState =
  | { kind: "summary"; text: string; comments?: WidgetComments }
  | { kind: "bullets"; bullets: string[]; comments?: WidgetComments }
  /** A thread with team discussion but no summary card (single-message threads
   *  render no summary): a one-line strip whose only content is the bubble. */
  | { kind: "commentsOnly"; comments: WidgetComments }
  | { kind: "error"; onRetry: () => void }
  | { kind: "quota"; resetsAt: string };

const HOST_ATTRIBUTE = "data-aziru-summary";

// Aziru brand tokens, inlined because the mail page has none of our CSS vars.
// Light values are packages/tokens colors.ts verbatim; dark values are the
// html[data-theme="dark"] oklch tokens converted to sRGB. Keep both in step with
// the token package — this is the one place the palette is duplicated, and it is
// duplicated because a third-party page cannot import it.
const LIGHT = {
  surface: "#faf9f6", // --bg
  text: "#4d4843", // --ink-2   8.6:1 on surface
  muted: "#706c66", // --ink-3  5.0:1 on surface
  accent: "#c2683f", // --accent
  accentInk: "#7b3a1d", // --accent-ink
  hover: "#f3f0ea", // --bg-sunk
};
const DARK = {
  // Lifted to oklch(27%): the app's rule is that surfaces rise above the canvas,
  // and Gmail's dark canvas is ~#1f1f1f — the previous #1e1d1a sank BELOW it, so
  // the card read as a hole rather than a raised annotation. Muted text is 4.50:1
  // here, exactly AA; do not darken the text or lighten this surface further.
  surface: "#282623",
  text: "#bab7b2", // 7.6:1 on surface
  muted: "#8f8c87", // 4.50:1 on surface
  accent: "#c65d36",
  accentInk: "#e6af9c",
  hover: "#35322f",
};

function paletteVars(p: typeof LIGHT): string {
  return `
    --am-surface: ${p.surface};
    --am-text: ${p.text};
    --am-muted: ${p.muted};
    --am-accent: ${p.accent};
    --am-accent-ink: ${p.accentInk};
    --am-hover: ${p.hover};`;
}

// Design intent: unmistakably Aziru while sitting quietly inside Gmail.
//
// The border does ALL the work of defining the card, because a fill cannot: the
// most separation any surface achieves against Gmail's own background is 1.14:1
// (measured), i.e. invisible. A neutral hairline was no better (1.06-1.21:1,
// failing WCAG 1.4.11's 3.0 minimum for UI boundaries). A terracotta border is
// the only value that clears 3.0 against Gmail light AND both Gmail darks
// (3.85-4.20:1), so it is simultaneously the accessible choice and the brand one.
// The heavier left edge keeps the blockquote/callout read - this is an
// annotation, not mail content, and in a mail client that distinction matters.
//
// Body text inherits the mail app's own font stack (page @font-face rules reach
// into shadow roots), so the summary reads as part of the client rather than
// pasted in; only the eyebrow uses our mono voice.
const STYLES = `
:host { all: initial; display: block; }
.card {
  ${paletteVars(LIGHT)}
  font-family: "Google Sans", Roboto, system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 13px;
  line-height: 1.55;
  /* Left inset is provider-supplied (see gutterLeft): Gmail's message list has
     an avatar column the card has to line up with, OWA's does not. */
  margin: 6px 0px 10px var(--am-gutter, 0px);
  padding: 9px 13px 10px 12px;
  border: 1px solid var(--am-accent);
  border-left-width: 3px;
  border-radius: 10px;
  background: var(--am-surface);
  color: var(--am-text);
}
.card.dark { ${paletteVars(DARK)} }
/* The transient states are a label plus one control - a row, not a stack. */
.card.row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.body { flex: 1 1 auto; min-width: 0; }
/* Stacked above the content, matching the in-app card so all three surfaces
   read identically. Costs ~13px, not a full line, and gives the text (and
   especially a bullet list) the full measure in a narrow reading pane. */
.eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-family: "Google Sans", Roboto, system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 9.5px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--am-accent-ink);
  margin-bottom: 4px;
  font-weight: 600;
}
.card.row .eyebrow { margin-bottom: 0; flex: 0 0 auto; }
/* The mark keeps the brand color even though the label text is muted, same
   split as the terracotta rail against the card's own neutral ink. */
.eyebrow [data-aziru-logo] { color: var(--am-accent-ink); }
.text { overflow-wrap: anywhere; }
/* Tighter than the in-app list: vertical space is the scarce resource here,
   since every line pushes the actual conversation further down the page. */
.bullets {
  margin: 0;
  padding-left: 15px;
  overflow-wrap: anywhere;
}
.bullets li { margin: 0; padding: 0; }
.bullets li + li { margin-top: 1px; }
.bullets li::marker { color: var(--am-muted); }
.muted { color: var(--am-muted); }
.retry {
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  border: 1px solid var(--am-accent);
  border-radius: 6px;
  background: transparent;
  color: var(--am-accent-ink);
  padding: 2px 9px;
  flex: 0 0 auto;
}
.retry:hover { background: var(--am-hover); }
/* all:initial on :host drops the UA focus ring; restore a visible one. */
.retry:focus-visible { outline: 2px solid var(--am-accent); outline-offset: 1px; }
/* Header row: the eyebrow left, the comment bubble pushed to the right edge. */
.header {
  display: flex;
  align-items: center;
  margin-bottom: 4px;
}
.header .eyebrow { margin-bottom: 0; }
.comments {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font: inherit;
  font-size: 11px;
  line-height: 1;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--am-muted);
  padding: 2px 6px;
  cursor: pointer;
  flex: 0 0 auto;
}
.comments:hover { background: var(--am-hover); color: var(--am-accent-ink); }
.comments:focus-visible { outline: 2px solid var(--am-accent); outline-offset: 1px; }
/* Unread activity is the one accent moment; a read bubble stays muted. */
.comments.unread { color: var(--am-accent-ink); font-weight: 600; }
`;

/**
 * Whether the widget sits on a dark backdrop.
 *
 * Walks up from the injection point for the first element painting an opaque
 * background and measures its luminance. prefers-color-scheme is only the
 * fallback: Gmail's dark theme is a GMAIL setting, so a user on OS-light with
 * Gmail-dark (or the reverse) would otherwise get a card that fights the page.
 */
function isDarkBackdrop(start: Element | null): boolean {
  try {
    let el: Element | null = start;
    while (el) {
      const parsed = parseColor(getComputedStyle(el).backgroundColor);
      if (parsed && parsed.a > 0.1) {
        // Rec. 709 luma is plenty for a light/dark decision.
        const luma = (0.2126 * parsed.r + 0.7152 * parsed.g + 0.0722 * parsed.b) / 255;
        return luma < 0.5;
      }
      el = el.parentElement;
    }
  } catch {
    // getComputedStyle can throw on detached nodes; fall through.
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

function parseColor(value: string): { r: number; g: number; b: number; a: number } | null {
  const m = value.match(/rgba?\(([^)]+)\)/);
  if (!m?.[1]) return null;
  const parts = m[1].split(",").map((p) => parseFloat(p.trim()));
  const [r, g, b] = parts;
  if (r === undefined || g === undefined || b === undefined) return null;
  return { r, g, b, a: parts[3] ?? 1 };
}

/**
 * A mounted widget. `update` re-renders in place (no flicker when a late
 * comment count decorates the card); `remove` tears the host element out of the page.
 */
export interface SummaryWidget {
  readonly host: HTMLElement;
  update(state: WidgetState): void;
  remove(): void;
}

export interface MountOptions {
  /**
   * Left margin for the card, e.g. "12px", so it aligns with the provider's own
   * content column rather than the raw edge of the pane. Defaults to none.
   */
  gutterLeft?: string;
  /**
   * Open the injected panel with its Comments section focused. A persistent
   * callback like gutterLeft, not per-state data: the bubble appears on every
   * content-bearing state. Without it no bubble ever renders — the states'
   * `comments` data is ignored, because a bubble with nowhere to go is a
   * broken button.
   */
  onOpenComments?: () => void;
}

/**
 * Create the widget and insert it before `anchor`. Returns null if the anchor is
 * detached (the SPA re-rendered between detection and injection), because
 * injecting into an orphan node silently does nothing.
 */
export function mountSummaryWidget(
  anchor: Element,
  state: WidgetState,
  options: MountOptions = {},
): SummaryWidget | null {
  if (!anchor.parentNode) return null;

  const host = document.createElement("div");
  host.setAttribute(HOST_ATTRIBUTE, "");
  // Custom properties are not touched by the `all: initial` on :host, so this
  // inherits into the shadow tree and the card picks it up.
  if (options.gutterLeft) host.style.setProperty("--am-gutter", options.gutterLeft);
  const root = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = STYLES;
  root.append(style);

  anchor.parentNode.insertBefore(host, anchor);

  // Measured after insertion: the backdrop is the anchor's own ancestry, which
  // only has computed styles once the host is in the document.
  const dark = isDarkBackdrop(anchor);

  const widget: SummaryWidget = {
    host,
    update(next) {
      render(root, next, dark, options);
    },
    remove() {
      host.remove();
    },
  };
  widget.update(state);
  return widget;
}

/** Remove any widget left over from a previous thread in this document. */
export function removeExistingWidgets(): void {
  for (const el of document.querySelectorAll(`[${HOST_ATTRIBUTE}]`)) el.remove();
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * The comment bubble: a speech-bubble glyph plus the count (omitted at zero,
 * where the bubble is the "start a discussion" affordance). Everything is
 * createElement/createElementNS + textContent — never innerHTML — and the only
 * comment-derived content is the two integers.
 */
function buildCommentsBubble(comments: WidgetComments, onOpen: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = comments.unread > 0 ? "comments unread" : "comments";
  button.setAttribute("aria-label", STRINGS.commentsLabel(comments.total, comments.unread));

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 14 14");
  svg.setAttribute("width", "12");
  svg.setAttribute("height", "12");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute(
    "d",
    "M3 2.5h8a1.5 1.5 0 011.5 1.5v4a1.5 1.5 0 01-1.5 1.5H7.2L4.5 11.8V9.5H3A1.5 1.5 0 011.5 8V4A1.5 1.5 0 013 2.5z",
  );
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.3");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  button.append(svg);

  if (comments.total > 0) {
    const count = document.createElement("span");
    count.textContent = String(comments.total);
    button.append(count);
  }

  button.addEventListener("click", onOpen);
  return button;
}

function render(
  root: ShadowRoot,
  state: WidgetState,
  dark = false,
  options: MountOptions = {},
): void {
  // Drop everything except the <style> node and rebuild — the card is four
  // elements at most, so diffing would cost more than it saves.
  for (const child of Array.from(root.children)) {
    if (child.tagName !== "STYLE") child.remove();
  }

  const card = document.createElement("div");
  const base = dark ? "card dark" : "card";
  // Announced as an aside rather than mail content, and named for Aziru even
  // though the visible eyebrow is just "Summary" — a screen-reader user gets the
  // attribution a sighted user reads from the terracotta chrome.
  card.setAttribute("role", "note");
  card.setAttribute("aria-label", "Aziru thread summary");
  // The card is re-rendered in place when a late comment count lands; polite live
  // region so the change is announced instead of silently swapping under focus.
  card.setAttribute("aria-live", "polite");

  if (state.kind === "error") {
    card.className = `${base} row`;
    const label = document.createElement("span");
    label.className = "muted body";
    label.textContent = STRINGS.error;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "retry";
    button.textContent = STRINGS.retry;
    button.addEventListener("click", state.onRetry);
    card.append(label, button);
    root.append(card);
    return;
  }

  if (state.kind === "quota") {
    card.className = `${base} row`;
    const label = document.createElement("span");
    label.className = "muted body";
    label.textContent = STRINGS.quota(formatResetDate(state.resetsAt));
    card.append(label);
    root.append(card);
    return;
  }

  if (state.kind === "commentsOnly") {
    // The whole card is one line: the comments eyebrow and the bubble. Only
    // mounted when the thread actually has discussion, so a thread without a
    // summary and without comments stays untouched.
    card.className = `${base} row`;
    card.setAttribute("aria-label", "Aziru team comments");
    const eyebrow = document.createElement("span");
    eyebrow.className = "eyebrow";
    eyebrow.append(createLogoMark(document, 11));
    const eyebrowLabel = document.createElement("span");
    eyebrowLabel.textContent = STRINGS.commentsEyebrow;
    eyebrow.append(eyebrowLabel);
    card.append(eyebrow);
    if (options.onOpenComments) {
      card.append(buildCommentsBubble(state.comments, options.onOpenComments));
    }
    root.append(card);
    return;
  }

  card.className = base;

  const eyebrow = document.createElement("span");
  eyebrow.className = "eyebrow";
  eyebrow.append(createLogoMark(document, 11));
  const eyebrowLabel = document.createElement("span");
  eyebrowLabel.textContent = STRINGS.eyebrow;
  eyebrow.append(eyebrowLabel);

  // Eyebrow left, bubble right. The header exists even without a bubble so the
  // summary/bullets layout is identical whether or not a panel is available.
  const header = document.createElement("div");
  header.className = "header";
  header.append(eyebrow);
  if (state.comments && options.onOpenComments) {
    header.append(buildCommentsBubble(state.comments, options.onOpenComments));
  }

  if (state.kind === "bullets") {
    const list = document.createElement("ul");
    list.className = "bullets body";
    for (const bullet of state.bullets) {
      const item = document.createElement("li");
      // textContent, never innerHTML — see below.
      item.textContent = bullet;
      list.append(item);
    }
    card.append(header, list);
    root.append(card);
    return;
  }

  const text = document.createElement("div");
  text.className = "text body";
  // textContent, never innerHTML: the summary is model output derived from
  // untrusted email content and is being injected into the user's mailbox.
  text.textContent = state.text;
  card.append(header, text);
  root.append(card);
}
