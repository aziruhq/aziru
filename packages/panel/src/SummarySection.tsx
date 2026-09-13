"use client";

import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "@aziru/api-client";
import { ThreadSummaryCard, type ThreadSummaryCardState } from "@aziru/ui/emails";
import type { EmailThreadDetail } from "./types.js";

// The thread's TL;DR, generated on open and cached server-side.
//
// The same four outcomes the web preview handles, run through this host's
// client. Single-message threads short-circuit locally rather than asking: the
// snippet is already here, and the server would only hand back the same string
// after a round trip.

const POLL_INTERVAL_MS = 2_000;

export function SummarySection({
  api,
  workspaceId,
  thread,
}: {
  api: ApiClient;
  workspaceId: string;
  thread: EmailThreadDetail;
}) {
  const [state, setState] = useState<ThreadSummaryCardState | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Invalidates in-flight work. The section is not remounted per thread in every
  // host, so without this a slow generation for the thread the user just left
  // resolves later and renders ITS summary under the current thread.
  const tokenRef = useRef(0);

  function clearPoll() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  function load(threadId: string, opts: { force?: boolean } = {}) {
    clearPoll();
    const token = ++tokenRef.current;
    setState({ kind: "loading" });
    api
      .threadSummary(workspaceId, threadId, opts)
      .then((result) => {
        if (token !== tokenRef.current) return;
        if ("generating" in result) {
          // Someone else is already paying for this one; wait it out rather than
          // starting a second generation.
          pollRef.current = setInterval(() => {
            api
              .threadSummary(workspaceId, threadId)
              .then((polled) => {
                if (token !== tokenRef.current) return;
                if ("generating" in polled) return;
                clearPoll();
                setState(toCardState(polled));
              })
              .catch(() => {
                if (token !== tokenRef.current) return;
                clearPoll();
                setState({ kind: "error", onRetry: () => load(threadId) });
              });
          }, POLL_INTERVAL_MS);
          return;
        }
        setState(toCardState(result));
      })
      .catch(() => {
        if (token !== tokenRef.current) return;
        // Retrying is free: a FAILED row never records a meter unit.
        setState({ kind: "error", onRetry: () => load(threadId) });
      });
  }

  useEffect(() => {
    clearPoll();
    tokenRef.current++;
    // Every thread is summarized, single-message ones included; the server
    // decides when a snippet is enough (automated or empty threads).
    load(thread.id);
    return () => {
      clearPoll();
      tokenRef.current++;
    };
  }, [thread.id, workspaceId]);

  if (!state) return null;
  return <ThreadSummaryCard state={state} />;
}

function toCardState(
  result: Exclude<Awaited<ReturnType<ApiClient["threadSummary"]>>, { generating: true }>,
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
