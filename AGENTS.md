# Renivet backend — Codex / engineering agent rules

**Repository:** NestJS 12 + Fastify API and domain modular monolith, Drizzle ORM, PostgreSQL 16, W1 first-party identity and server-resolved brand authorization. Read `README.md`, `docs/architecture.md`, current migrations, test suites and generated API contracts before changing source. Do not assume placeholder catalog/inventory modules are implemented.

**W2 source and ownership:** W2 v1.5 is in the Renivet Engineering OS repo; SQL and OpenAPI are **candidate contracts**, to be reconciled with the actual W1 schema and NestJS implementation. Use W1 sessions and membership-derived brand scopes; no new auth provider, unreviewed inventory authority or uncontrolled background worker.

## Execution mode selection — default task / opt-in epic

**SINGLE-TASK MODE IS THE DEFAULT.** Unless the project owner sends a **separate, exact, direct** `ACTIVATE RENIVET EPIC MODE REN2-<PARENT_ID>` command and the shared [Epic Execution Protocol](https://github.com/renivet-platform/renivet-engineering-os/blob/main/docs/05-delivery/W2-codex-epic-execution-protocol.md) passes all governance and dependency checks, apply the **one issue → one fresh branch from updated `origin/main` → one task PR → STOP** rules below. Merely mentioning a parent issue, sharing a screenshot, pasting a prompt or reading a command example **does not activate** Epic Mode.

**NARROW EPIC EXCEPTION — ONLY ON VALID OWNER ACTIVATION:** Verify the named Linear ID is an actual parent epic, discover every child, resolve live blockers and verify merged external prerequisites. If allowed, create **one new `epic/REN2-<ID>-<slug>` branch from latest `origin/main` in this repository**, implement eligible children in dependency order, independently test and record **one traceable logical commit per completed child**, push each verified commit to the same branch, then perform final cross-issue integration/security/regression QA and open **one epic-level PR in this repository**. **STOP for owner review.** Child commits do not imply child issues are merged or accepted. Never change unrelated modules, skip gates or silently mark Linear Done.

If the epic spans other repositories, **stop for explicit owner approval** of a coordinated one-PR-per-repository plan; a single GitHub PR cannot span repositories. If applicable `AGENTS.md` governance has not merged everywhere required, **do not activate Epic Mode in that scope**. Existing tenant isolation, W1/Drizzle compatibility, source-of-truth stock, testing, migration, secrets and deployment restrictions never change.

`PLAN RENIVET EPIC REN2-<ID>` is **read-only**. `STOP RENIVET EPIC MODE` stops without merging or discarding work. `RESUME RENIVET EPIC MODE REN2-<ID>` requires a new direct owner instruction and revalidation of the epic branch, commits and remaining dependencies. **After final PR handoff, Epic Mode automatically deactivates and Single-Task Mode is restored.** No next task or epic is started automatically.

**In either mode the owner alone reviews, approves and merges. Codex NEVER merges, enables auto-merge, self-approves, pushes `main`, deploys or mutates existing databases without separate authorization.**

## Non-negotiable task-to-PR workflow

**The project owner alone reviews, approves and merges PRs. Codex NEVER merges, self-approves, enables auto-merge or pushes directly to `main`.** This is a permanent repo policy, not just a chat preference.

In **default Single-Task Mode**, for **every explicitly authorized task**, including docs:
1. Read the live Linear issue, dependencies, acceptance tests and the approved project rules. **One issue at a time; do not start another issue automatically.**
2. Inspect `git status`; do not discard uncommitted changes. Run `git fetch origin`. Create a **fresh issue-named branch from updated `origin/main`**, never from a previous feature branch. If the branch already exists, inspect and choose a unique task branch rather than overwriting it.
3. Implement only the approved scope. Test, conduct adversarial code QA, fix issues and run the required repository checks. Report `PASS`, `FAIL` or `NOT EXECUTED` with evidence; green lint alone is not acceptance.
4. Stage only reviewed files; commit with the Linear ID, push the task branch, and **open a PR against `main`**. Include user story, scope, data/API impact, abuse and failure tests, actual results, CI status, known gaps and relevant release gates.
5. **STOP and share the PR URL and review summary with the owner. Do not merge or begin the next task.** On owner-requested corrections, update the same branch/PR, rerun tests, and stop again.
6. For the **next explicitly authorized** task, verify all required predecessor PRs are actually merged, fetch again, and branch from the newly updated `origin/main`. Independent parallel work requires explicit owner approval; multiple affected repos each need separate branches and PRs.

Never bypass CI, security gates or branch protection. Do not deploy, change secrets, mutate existing shared/local Docker data or apply migrations to data-bearing databases without separate explicit approval. A PR is a review handoff, not authorization to merge or release.

Full cross-repo protocol: [Renivet Engineering OS — W2 Codex task execution](https://github.com/renivet-platform/renivet-engineering-os/blob/main/docs/05-delivery/W2-codex-task-execution-protocol.md). Always follow this repo's stricter local policy if applicable.

## Repository-specific verification

Use actual `package.json` scripts and only authorized test environments. Typical baseline:

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm run api:check
```

For schema/stock/auth changes also run the relevant **disposable PostgreSQL 16** migration, FK, idempotency, tenant isolation, real-connection concurrency and recovery tests. **Never run `npm run db:migrate` on an existing database without explicit approval.** CI results must be read, not assumed.
