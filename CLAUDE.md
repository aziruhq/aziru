# Project Context

When working on Aziru, prioritize readability, safety, and a focused feature set. Avoid clever abstractions and do not add out-of-scope features without explicit approval.

**Do not edit any code without the user's explicit consent.** Propose changes first and wait for approval before modifying files.

## About

Aziru is an open-source, self-hostable AI email triage assistant. It is Gmail-first, but not a full email client.

**Provider support (product decision):** Aziru implements Outlook support to mirror Gmail. Outlook must offer the same feature set as Gmail, with parity across triage, sorting, drafts (approval-only), and all downstream functionality. Mail-mutation policy: when the label-writeback feature flag is enabled, the write scope (gmail.modify / Mail.ReadWrite) is requested **upfront in bulk** at Google sign-in and inbox connect — writeback is **on by default** per workspace (users can switch it off), and upcoming in-provider features (thread summaries and draft replies surfaced inside the Gmail/Outlook UI) share that same grant, so authorization is gathered once rather than via per-feature incremental prompts. Aziru mirrors sorted folders into the mailbox as Gmail labels / Outlook categories under the `Aziru` namespace and keeps them in sync as threads are sorted. If the user declines the write permission (or the flag is off), the connection proceeds read-only and writeback is inert. Aziru still **never sends or deletes mail**, and applies no mailbox writes beyond that label/category writeback. New provider work should reuse the existing provider abstraction rather than forking Gmail-specific logic.

Aziru will also be offered as a hosted SaaS product. The codebase must support both deployment models equally. Design, architecture, storage layout, and API cost structure must never assume a single-tenant or fully self-managed environment. Specifically:

- Multi-tenancy must be a first-class concern: data isolation, per-user resource accounting, and tenant-scoped configuration should be built in, not retrofitted.
- AI and third-party API costs must be attributable per user so the hosted offering can track and control spend.
- Infrastructure choices (database, queues, storage) should have clear self-host-friendly defaults (e.g. Postgres, Redis, local file storage) while remaining swappable for managed cloud equivalents in production.
- Features that would be prohibitively expensive or operationally complex to run at scale in the hosted offering should be flagged before implementation.

Aziru sorts email threads, not individual messages. New messages in existing threads trigger re-sorting of the full thread.

A key use case is bulk triage of an existing inbox: users may want to sort and classify thousands of emails already accumulated, not just handle incoming ones. Features and jobs should be designed to handle both ongoing (real-time) and historical (backfill) triage at scale.

## Monorepo

- `apps/web/` - Next.js frontend
- `apps/api/` - TypeScript API server
- `apps/worker/` - background jobs
- `packages/db/` - Prisma schema, migrations, client
- `packages/shared/` - shared types and Zod schemas
- `packages/ai/` - AI providers, prompts, output validation
- `packages/config/` - shared env/config

## AI & Policy

- Treat LLM output as untrusted.
- Validate structured AI output with Zod.
- Reject unknown node IDs, invalid paths, and invalid final destinations.
- Policy code decides final actions, not prompts.
- Keep mock sorting available for deterministic testing.
- Support local Ollama for dev and frontier LLMs for production through provider abstraction.
- Tune and commit routing/AI constants for the production model configuration (frontier Gemini). Self-hosted deployments on other models set their own constants; do not tune shipped defaults against the offline CI model.
- **Thread summaries** are generated lazily on thread open, cached in `ThreadSummary`, and metered as `THREAD_SUMMARY`. Two invariants are non-obvious and load-bearing: automated threads and threads with no stored messages return the stored snippet with no LLM call, no row, and no meter (single-message threads ARE summarized, a client requirement); and the summary text is derived email content, so it is never logged (not even a preview on a parse failure, unlike the draft module). A FAILED row never records a meter unit, which is what makes retry free.

## Safety & Privacy

- Never auto-send email.
- Never send from Aziru GUI.
- Drafts require user approval.
- Store minimal email data.
- Never log full email bodies.
- Encrypt OAuth tokens and API keys at rest.
- Audit important actions.

## Workflow

- At the end of large tasks (multi-file changes, feature additions, refactors), provide a brief summary: what was changed, which files were affected, and any caveats or follow-up work.

## UX

- Minimize the number of clicks required to complete any action. Prefer inline controls, smart defaults, and progressive disclosure over multi-step flows.
- Both the marketing site and the web app must be fully responsive. All layouts, components, and interactions must work correctly on mobile, tablet, and desktop screen sizes.
- Every control with a single yes/no choice (settings, feature on/off) renders as a switch toggle — use the shared `Switch` from `@aziru/ui` (styles via `@aziru/ui/switch/styles`), never a bare checkbox. Checkboxes are reserved for multi-select lists and explicit consent confirmations.

## Cross-Platform Parity

**Mobile is shelved (product decision).** The mobile app (`apps/mobile/`) is on hold. Do not update it for every functionality or UI change. Web and site are the active surfaces; new features and UI updates ship there without a corresponding mobile change. Leave the existing mobile code in place, but do not treat mobile parity as a requirement for ongoing work. Revisit this decision before resuming mobile development.

- Provider parity still applies: when a feature exists for Gmail, it must also be implemented for Outlook (read-only), and vice versa. Never update one provider without updating the other.

## Localization

Aziru uses Lingui v5 for i18n across `apps/web`, `apps/site`, and `apps/mobile`. The source locale is English; all other languages are filled automatically by AI.

**Rules:**
- Never hardcode user-visible strings as plain text. Wrap every string in a Lingui macro.
- JSX content: `<Trans>My label</Trans>`
- Imperative strings (props, attributes, variables): `const { _ } = useLingui(); _( msg`My label`)`
- Dynamic values and plurals: use ICU MessageFormat inside the macro (`{name}`, `{count, plural, one {# item} other {# items}}`). Never concatenate strings.
- Write copy that is self-contained and unambiguous. Avoid idioms, wordplay, and split sentences across multiple macros.
- Settle on the final English text before wrapping. Changing a wrapped string creates a new catalog key and orphans the old translation.

**Pipeline (hook-owned — do not run manually):** the pre-commit hook runs `pnpm i18n:extract` → `pnpm i18n:translate` → `pnpm i18n:compile` automatically when string-touching files are staged. Just wrap strings in macros; the hook handles the rest at commit time. Only run `pnpm i18n:compile` by hand if you need compiled catalogs before committing (e.g. to verify new strings render).

## Standards

- TypeScript strict mode.
- Small files with explicit domain names.
- Idempotent, retry-safe background jobs.
- Test policy logic, AI output parsing, provider adapters, graph validity, and job behavior.
- Use centralized Aziru design tokens; do not hardcode brand hex values in components.
- Do not duplicate logic or styles. Before adding new code or styles, check whether the behavior or style already exists and reuse or extend it instead.

## Non-Goals

- IMAP support (Outlook is supported read-only; see Provider support above)
- Arbitrary workflow automation
- Kubernetes

## Testing

- Tests must never be adjusted to accommodate the algorithm. If a test is failing and the test itself is not flawed, fix the algorithm, NOT the test.
- When a process is started to run a test, kill it once the test is done. Do not leave test or dev processes running in the background.