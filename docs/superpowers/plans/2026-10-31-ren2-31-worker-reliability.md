# REN2-31 Worker Reliability Implementation Plan

**Spec:** [REN2-31 Worker Reliability Design](../specs/2026-10-31-ren2-31-worker-reliability-design.md)  
**Linear:** [REN2-31](https://linear.app/renivet/issue/REN2-31/w1-c3-implement-worker-reliability-integration-tests-runbooks-and)

## Plan

1. **Baseline and guardrails** — confirm current CI/test behavior, origin/main base, disposable Postgres setup, and no changes to the user's existing `.env.example` edit.
2. **TDD crash/concurrency evidence** — extend disposable integration tests first for actual child-process exit before/after transaction commit, fresh-worker recovery, concurrent duplicate processing, terminal attempt state and recovered effect uniqueness; verify each added assertion fails for the intended missing behavior.
3. **Observability** — add typed batch metric reporting, safe stable per-job trace correlation, attempt/state/reason fields, and safe dead-letter inspection; add unit/integration assertions for the telemetry contract and secret redaction.
4. **Runbook and traceability** — add an operator recovery runbook and map T-JOB-01..08 / T-OPS-01..03, scope boundaries and disposable-only commands in `tests/README.md`.
5. **CI evidence** — make the worker suite run before and after disposable database recovery and upload TAP outputs as a short-lived artifact.
6. **Verification and handoff** — full local typecheck/lint/build/unit suite, focused disposable PostgreSQL integration and CI run; inspect clean diff and create one REN2-31 PR. Do not merge.

## Completion checklist

- [x] Baseline recorded; implementation uses the REN2-31 scope without activating production work.
- [x] Crash/restart, duplicate/concurrent, retry, poison, observability and recovery behavior pass locally.
- [x] Runbook procedure is exercised on disposable test data without duplicate effects.
- [x] CI maps T-JOB/T-OPS evidence and preserves a seven-day TAP artifact.
- [ ] Full local validation and PR CI pass; no merge or issue status change without owner direction.
