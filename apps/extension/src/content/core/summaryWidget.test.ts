import { describe, it, expect, afterEach, vi } from "vitest";
import { mountSummaryWidget, removeExistingWidgets } from "./summaryWidget";
import { STRINGS } from "./strings";

afterEach(() => {
  document.body.innerHTML = "";
});

function anchorInPage(): Element {
  document.body.innerHTML = `<div id="pane"><div id="msgs"></div></div>`;
  return document.getElementById("msgs")!;
}

function shadowText(host: HTMLElement): string {
  return host.shadowRoot?.textContent ?? "";
}

/** Any renderable state, for tests about mounting mechanics rather than content. */
const ANY_STATE = { kind: "summary", text: "hi" } as const;

describe("mountSummaryWidget", () => {
  it("mounts a shadow root immediately before the anchor", () => {
    const anchor = anchorInPage();
    const widget = mountSummaryWidget(anchor, ANY_STATE)!;
    expect(widget.host.shadowRoot).not.toBeNull();
    expect(widget.host.nextElementSibling).toBe(anchor);
    expect(document.getElementById("pane")!.firstElementChild).toBe(widget.host);
  });

  it("returns null when the anchor is detached from the document", () => {
    const orphan = document.createElement("div");
    expect(mountSummaryWidget(orphan, ANY_STATE)).toBeNull();
  });

  it("re-renders in place on update, without remounting", () => {
    const anchor = anchorInPage();
    const widget = mountSummaryWidget(anchor, { kind: "summary", text: "First." })!;
    const hostBefore = widget.host;
    widget.update({ kind: "summary", text: "Ana needs the kickoff date." });
    expect(widget.host).toBe(hostBefore);
    expect(shadowText(widget.host)).toContain("Ana needs the kickoff date.");
    expect(shadowText(widget.host)).not.toContain("First.");
  });

  it("renders summary text as text, never as markup", () => {
    const widget = mountSummaryWidget(anchorInPage(), {
      kind: "summary",
      text: "<img src=x onerror=alert(1)>",
    })!;
    expect(widget.host.shadowRoot!.querySelector("img")).toBeNull();
    expect(shadowText(widget.host)).toContain("<img src=x onerror=alert(1)>");
  });

  it("fires onRetry from the error state", () => {
    const onRetry = vi.fn();
    const widget = mountSummaryWidget(anchorInPage(), ANY_STATE)!;
    widget.update({ kind: "error", onRetry });
    const button = widget.host.shadowRoot!.querySelector("button")!;
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("shows the reset date in the quota state", () => {
    const widget = mountSummaryWidget(anchorInPage(), {
      kind: "quota",
      resetsAt: "2026-08-01T00:00:00.000Z",
    })!;
    expect(shadowText(widget.host)).toContain("Aug 1");
  });

  it("keeps exactly one style block across re-renders", () => {
    const widget = mountSummaryWidget(anchorInPage(), ANY_STATE)!;
    widget.update({ kind: "summary", text: "One." });
    widget.update({ kind: "summary", text: "Two." });
    expect(widget.host.shadowRoot!.querySelectorAll("style")).toHaveLength(1);
  });

  it("removes itself from the page on teardown", () => {
    const anchor = anchorInPage();
    const widget = mountSummaryWidget(anchor, ANY_STATE)!;
    widget.remove();
    expect(document.body.contains(widget.host)).toBe(false);
    expect(document.getElementById("pane")!.firstElementChild).toBe(anchor);
  });
});

describe("removeExistingWidgets", () => {
  it("clears widgets left over from a previous document state", () => {
    const anchor = anchorInPage();
    mountSummaryWidget(anchor, ANY_STATE);
    mountSummaryWidget(anchor, ANY_STATE);
    expect(document.querySelectorAll("[data-aziru-summary]")).toHaveLength(2);
    removeExistingWidgets();
    expect(document.querySelectorAll("[data-aziru-summary]")).toHaveLength(0);
  });
});

describe("host-theme adaptation", () => {
  // Gmail's dark theme is a GMAIL setting, not an OS one, so the card must read
  // the actual backdrop rather than trusting prefers-color-scheme.
  it("uses the dark palette on a dark backdrop", () => {
    document.body.innerHTML = `<div id="pane" style="background-color: rgb(24, 22, 19)"><div id="msgs"></div></div>`;
    const widget = mountSummaryWidget(document.getElementById("msgs")!, {
      kind: "summary",
      text: "hi",
    })!;
    expect(widget.host.shadowRoot!.querySelector(".card")!.classList.contains("dark")).toBe(true);
  });

  it("uses the light palette on a light backdrop", () => {
    document.body.innerHTML = `<div id="pane" style="background-color: rgb(255, 255, 255)"><div id="msgs"></div></div>`;
    const widget = mountSummaryWidget(document.getElementById("msgs")!, {
      kind: "summary",
      text: "hi",
    })!;
    expect(widget.host.shadowRoot!.querySelector(".card")!.classList.contains("dark")).toBe(false);
  });

  it("keeps the palette stable across re-renders", () => {
    document.body.innerHTML = `<div id="pane" style="background-color: rgb(24, 22, 19)"><div id="msgs"></div></div>`;
    const widget = mountSummaryWidget(document.getElementById("msgs")!, ANY_STATE)!;
    widget.update({ kind: "summary", text: "done" });
    expect(widget.host.shadowRoot!.querySelector(".card")!.classList.contains("dark")).toBe(true);
  });

  it("ignores transparent ancestors and keeps walking up", () => {
    document.body.innerHTML = `<div style="background-color: rgb(24,22,19)"><div style="background-color: rgba(0,0,0,0)"><div id="msgs"></div></div></div>`;
    const widget = mountSummaryWidget(document.getElementById("msgs")!, {
      kind: "summary",
      text: "hi",
    })!;
    expect(widget.host.shadowRoot!.querySelector(".card")!.classList.contains("dark")).toBe(true);
  });
});

describe("brand chrome", () => {
  it("renders the Aziru eyebrow and a terracotta accent rail", () => {
    const widget = mountSummaryWidget(anchorInPage(), { kind: "summary", text: "hi" })!;
    const shadow = widget.host.shadowRoot!;
    expect(shadow.querySelector(".eyebrow")!.textContent).toBe(STRINGS.eyebrow);
    // The rail is the brand's terracotta accent, declared in the stylesheet.
    expect(shadow.querySelector("style")!.textContent).toContain("#c2683f");
  });
});

describe("bullets rendering", () => {
  it("renders a list item per bullet, as text", () => {
    const widget = mountSummaryWidget(anchorInPage(), {
      kind: "bullets",
      bullets: ["Shabbat at 19:30", "Bring documents", "Sacramento 1227"],
    })!;
    const items = widget.host.shadowRoot!.querySelectorAll("li");
    expect(items).toHaveLength(3);
    expect(items[0]!.textContent).toBe("Shabbat at 19:30");
    expect(widget.host.shadowRoot!.querySelector(".eyebrow")!.textContent).toBe(STRINGS.eyebrow);
  });

  it("escapes markup inside a bullet", () => {
    const widget = mountSummaryWidget(anchorInPage(), {
      kind: "bullets",
      bullets: ["<img src=x onerror=alert(1)>", "safe"],
    })!;
    expect(widget.host.shadowRoot!.querySelector("img")).toBeNull();
    expect(widget.host.shadowRoot!.querySelector("li")!.textContent).toContain("<img");
  });

  it("switches cleanly from bullets back to prose", () => {
    const widget = mountSummaryWidget(anchorInPage(), { kind: "bullets", bullets: ["a", "b"] })!;
    widget.update({ kind: "summary", text: "Now prose." });
    expect(widget.host.shadowRoot!.querySelectorAll("li")).toHaveLength(0);
    expect(widget.host.shadowRoot!.textContent).toContain("Now prose.");
  });
});

describe("card structure and accessibility", () => {
  it("stacks the header (eyebrow row) above the content, not beside it", () => {
    const widget = mountSummaryWidget(anchorInPage(), { kind: "summary", text: "hi" })!;
    const card = widget.host.shadowRoot!.querySelector(".card")!;
    // No `row` modifier: the summary state is a block stack, matching the
    // in-app ThreadSummaryCard so all three surfaces read identically. The
    // first row is the header, which leads with the eyebrow (and hosts the
    // comment bubble at its right edge when one renders).
    expect(card.classList.contains("row")).toBe(false);
    const header = card.firstElementChild!;
    expect(header.classList.contains("header")).toBe(true);
    expect(header.firstElementChild!.classList.contains("eyebrow")).toBe(true);
  });

  it("keeps the transient states on one row", () => {
    for (const state of [
      { kind: "quota", resetsAt: "2026-08-01T00:00:00.000Z" } as const,
      { kind: "error", onRetry: () => {} } as const,
    ]) {
      const widget = mountSummaryWidget(anchorInPage(), state)!;
      expect(widget.host.shadowRoot!.querySelector(".card")!.classList.contains("row")).toBe(true);
    }
  });

  // A fill cannot separate the card from Gmail (1.14:1 at best), so the border
  // is load-bearing: it is the only thing clearing WCAG 1.4.11's 3.0 for a UI
  // boundary. A neutral hairline here would be an accessibility regression.
  it("draws a full accent border, not a neutral hairline", () => {
    const css = mountSummaryWidget(anchorInPage(), { kind: "summary", text: "hi" })!
      .host.shadowRoot!.querySelector("style")!.textContent!;
    expect(css).toContain("border: 1px solid var(--am-accent)");
    expect(css).toContain("border-left-width: 3px");
    expect(css).not.toContain("--am-line");
  });

  // Gmail indents its message list past an avatar gutter, OWA does not, so the
  // left inset is the provider's call and the card must default to flush-left.
  it("applies the provider's left gutter, and none by default", () => {
    const withGutter = mountSummaryWidget(
      anchorInPage(),
      { kind: "summary", text: "hi" },
      { gutterLeft: "12px" },
    )!;
    expect(withGutter.host.style.getPropertyValue("--am-gutter")).toBe("12px");

    const flush = mountSummaryWidget(anchorInPage(), { kind: "summary", text: "hi" })!;
    expect(flush.host.style.getPropertyValue("--am-gutter")).toBe("");
    expect(
      flush.host.shadowRoot!.querySelector("style")!.textContent!,
    ).toContain("var(--am-gutter, 0px)");
  });

  it("is exposed as a named, polite live note rather than mail content", () => {
    const card = mountSummaryWidget(anchorInPage(), { kind: "summary", text: "hi" })!
      .host.shadowRoot!.querySelector(".card")!;
    expect(card.getAttribute("role")).toBe("note");
    expect(card.getAttribute("aria-live")).toBe("polite");
    // Attribution for screen readers even though the visible eyebrow is generic.
    expect(card.getAttribute("aria-label")).toMatch(/aziru/i);
  });

  it("keeps the note semantics across every state", () => {
    const widget = mountSummaryWidget(anchorInPage(), ANY_STATE)!;
    widget.update({ kind: "bullets", bullets: ["a", "b"] });
    const card = widget.host.shadowRoot!.querySelector(".card")!;
    expect(card.getAttribute("role")).toBe("note");
    expect(card.getAttribute("aria-live")).toBe("polite");
  });
});

describe("comment bubble", () => {
  const OPEN = () => vi.fn();

  function bubbleOf(host: HTMLElement): HTMLButtonElement | null {
    return host.shadowRoot!.querySelector<HTMLButtonElement>(".comments");
  }

  it("renders in the header with the count when comments data and a callback exist", () => {
    const widget = mountSummaryWidget(
      anchorInPage(),
      { kind: "summary", text: "hi", comments: { total: 3, unread: 0 } },
      { onOpenComments: OPEN() },
    )!;
    const bubble = bubbleOf(widget.host)!;
    expect(bubble).not.toBeNull();
    expect(bubble.closest(".header")).not.toBeNull();
    expect(bubble.textContent).toContain("3");
    expect(bubble.getAttribute("aria-label")).toBe(STRINGS.commentsLabel(3, 0));
    expect(bubble.classList.contains("unread")).toBe(false);
  });

  it("omits the count at zero (the bubble is the start-a-discussion affordance)", () => {
    const widget = mountSummaryWidget(
      anchorInPage(),
      { kind: "bullets", bullets: ["a"], comments: { total: 0, unread: 0 } },
      { onOpenComments: OPEN() },
    )!;
    const bubble = bubbleOf(widget.host)!;
    expect(bubble.textContent).toBe("");
    expect(bubble.querySelector("svg")).not.toBeNull();
  });

  it("takes the unread accent variant when there is unread activity", () => {
    const widget = mountSummaryWidget(
      anchorInPage(),
      { kind: "summary", text: "hi", comments: { total: 4, unread: 2 } },
      { onOpenComments: OPEN() },
    )!;
    expect(bubbleOf(widget.host)!.classList.contains("unread")).toBe(true);
    expect(bubbleOf(widget.host)!.getAttribute("aria-label")).toContain("2 new");
  });

  it("never renders without the callback: a bubble with nowhere to go is a broken button", () => {
    const widget = mountSummaryWidget(anchorInPage(), {
      kind: "summary",
      text: "hi",
      comments: { total: 3, unread: 1 },
    })!;
    expect(bubbleOf(widget.host)).toBeNull();
  });

  it("never renders without comments data", () => {
    const widget = mountSummaryWidget(
      anchorInPage(),
      { kind: "summary", text: "hi" },
      { onOpenComments: OPEN() },
    )!;
    expect(bubbleOf(widget.host)).toBeNull();
  });

  it("fires the callback on click", () => {
    const onOpen = vi.fn();
    const widget = mountSummaryWidget(
      anchorInPage(),
      { kind: "summary", text: "hi", comments: { total: 1, unread: 0 } },
      { onOpenComments: onOpen },
    )!;
    bubbleOf(widget.host)!.click();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("renders the commentsOnly strip as one row with the comments eyebrow", () => {
    const widget = mountSummaryWidget(
      anchorInPage(),
      { kind: "commentsOnly", comments: { total: 2, unread: 1 } },
      { onOpenComments: OPEN() },
    )!;
    const card = widget.host.shadowRoot!.querySelector(".card")!;
    expect(card.classList.contains("row")).toBe(true);
    expect(card.getAttribute("aria-label")).toBe("Aziru team comments");
    expect(shadowText(widget.host)).toContain(STRINGS.commentsEyebrow);
    expect(bubbleOf(widget.host)!.textContent).toContain("2");
  });
});
