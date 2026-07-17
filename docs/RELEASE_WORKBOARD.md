# Account Center Delivery Workboard

**Purpose:** complete every open item in `RELEASE_GATE.md` through a single-writer, independently reviewed delivery loop. This workboard is the durable source of sequencing; it does **not** change what counts as proof in the release gate.

## Operating rule

Only one checkpoint can be in `IMPLEMENTING`, `REVIEW`, or `QA` at a time. The shared `main` checkout remains clean. Implementation occurs in an isolated branch/worktree, then merges only after every required gate is green.

### Roles

| Role | Owner | May write source? | Responsibility |
|---|---|---:|---|
| Coordinator | Jack | No source writes while a checkpoint worker owns a worktree | chooses the next checkpoint, records state, integrates approved work |
| Interface designer | Native VPS Codex CLI/app | Only its isolated UI branch | owns visual system, first-run onboarding, interaction polish, and accessible UI implementation |
| Implementation worker | Jacques/OpenClaw or native Codex, selected per checkpoint | Only its isolated worktree | TDD implementation of one bounded checkpoint |
| Spec reviewer | fresh read-only reviewer | No | checks exact checkpoint acceptance criteria and prevents scope creep |
| DRY/performance reviewer | Fresh native Codex review, or a fresh read-only Jacques session when native Codex is quota-limited | No | checks duplication, avoidable complexity, performance regressions, dead code, and maintainability |
| QA | deterministic CI + fresh independent QA reviewer | No source writes | runs security, functional, browser, a11y, responsive, and regression proof |

A worker never approves its own code. A failed review or QA gate returns the same checkpoint to `IMPLEMENTING`; the next checkpoint cannot begin.

## State machine

```text
BACKLOG
  -> PLANNED          (5–10 concrete tasks and acceptance evidence written)
  -> IMPLEMENTING     (isolated worktree only; TDD)
  -> SPEC_REVIEW      (independent, read-only)
  -> QUALITY_REVIEW   (independent DRY/performance/security review)
  -> QA               (deterministic full suite + browser + security + independent QA)
  -> READY_TO_MERGE   (all gates pass)
  -> MERGED           (commit pushed, release gate updated narrowly)
```

A failure transitions to `REMEDIATION`, then returns to the failed phase. After two remediation loops, the coordinator records a blocker and stops rather than widening scope or weakening a test.

## Required proof for every checkpoint

1. Clean-tree and active-worker preflight.
2. Bounded implementation plan with a no-touch list.
3. Targeted red test(s), minimum implementation, focused green test(s).
4. Full `npm run qa` deterministic gate.
5. `npm run qa:security` for secrets/dependency checks.
6. Browser/a11y proof whenever an API, UI state, or interaction changes.
7. Independent spec reviewer verdict: **PASS**.
8. Independent quality reviewer verdict: **APPROVE**.
9. QA verdict: **PASS**, with fixtures/live-proof boundary stated.
10. Staged-file review, `git diff --check`, conventional commit, push, GitHub Actions green.

## Open checkpoints

The IDs below map to the **26 currently open** release-gate checkboxes, plus **UI-05** (the newly requested first-run onboarding). That makes 27 delivery checkpoints in the expanded program. A checkpoint can contain 5–10 micro-tasks, but it may not silently absorb another ID.

### A. Controlled account operations

| ID | Checkpoint | Acceptance emphasis |
|---|---|---|
| AC-01 | Redacted status, limits, accounts, and routing | prove every output path is opaque/redacted and no identity/secret reaches UI/logs |
| AC-02 | Durable distinct `/auth add` and `/auth reauth` start | explicit mode, scope, target handling, idempotency, redacted durable result |
| AC-03 | Complete challenge lifecycle | start, cancel, expire, complete, verified failure; no credentials persisted |
| AC-04 | Verified reauth transaction | stage → identity/health verify → optional route decision → durable receipt; preserve old working auth until verification |
| AC-05 | `/auth remove` semantics | route-only removal, no credential deletion, preview/confirm/receipt/verification |
| AC-06 | Exact account delete | normalized exact connected identity, runtime backup, durable redacted receipt, authoritative result or `UNPROVEN` |
| AC-07 | Shared mutation executor | every mutation uses the same preview/review/idempotency/audit/receipt/post-verification lifecycle |

### B. Scope and model policy

| ID | Checkpoint | Acceptance emphasis |
|---|---|---|
| SC-01 | Explicit runtime/scope everywhere | `hermes`, `openclaw`, `codex` plus only authoritative supported scopes |
| SC-02 | Active OpenClaw scope warning | explicit active-agent warning, preview and confirmation gate |
| SC-03 | Model policy truth model | catalog, requested/effective model, fallback, eligibility, and verification remain distinct |
| SC-04 | Honest state taxonomy | unsupported, unentitled, read-only, unknown, and `UNPROVEN` consistently rendered and tested |
| SC-05 | Codex mutation boundary | retain read-only behavior unless a stable safe native mutation surface is proven |

### C. Secure local control plane

| ID | Checkpoint | Acceptance emphasis |
|---|---|---|
| CP-01 | Loopback and per-launch token proof | default loopback bind, unique launch token, no token logging, lifecycle cleanup |
| CP-02 | API security contract | authentication, origin/CSRF, no-store, validation, confirmation, and redacted errors with adversarial tests |
| CP-03 | Full protected route coverage | status, inventory, routing, lifecycle, model, receipt, and audit routes all reach shared executor contracts |
| CP-04 | No-secret assurance | automated secret/PII regression scan across API, logs, artifacts, fixtures, and browser reports |

### D. Native-Codex-owned interface and onboarding

| ID | Checkpoint | Acceptance emphasis |
|---|---|---|
| UI-01 | Native Codex visual-system ownership | native VPS Codex app owns the polished UI branch and documented visual decisions |
| UI-02 | Complete accessible action UI | responsive/keyboard views for status, routing, guided add/reauth, models, receipts/audit, destructive confirmation |
| UI-03 | State-complete UI | loading, empty, error, success, unsupported, read-only, and `UNPROVEN` behavior is visual and browser-tested |
| UI-04 | Protected API-connected actions | no fake shell: all exposed actions call protected local contracts and show truthful results |
| UI-05 | First-run onboarding | skippable welcome flow: what Account Center is, what it can/cannot do, privacy/local-token model, optional connect-existing-accounts discovery, unsupported/live-mutation boundaries, and completion/help return path |
| UI-06 | Guarded Update Center | show verified release provenance/notes, explicit apply plan, backup, narrow restart, health proof, rollback/`UNPROVEN` state |
| UI-07 | Update safety boundary | reject branches/arbitrary code and never update Hermes/OpenClaw/Codex through Account Center |

### E. Installability and release

| ID | Checkpoint | Acceptance emphasis |
|---|---|---|
| RL-01 | Clean Node 24 install/start | documented clean-environment install, launch, token, health, and stop proof |
| RL-02 | Dependency and secret security | audited dependency baseline, secret scan, remediation or explicitly accepted blocker record |
| RL-03 | Current operator documentation | README, API/CLI contract, threat model, backup/rollback, test and troubleshooting instructions |
| RL-04 | Candidate release handoff | signed/tagged candidate, GitHub evidence, exact Mac install/test steps, known limitations |

## First-run onboarding definition (UI-05)

The onboarding must be skippable and resumable from Help/Settings. It must not scrape a browser, import credentials, or imply a live connection that the runtime cannot authoritatively prove.

1. **Welcome:** local-control-plane purpose and selected environment.
2. **How it works:** loopback server, per-launch token, redacted display, receipts, and safe confirmations.
3. **What it can do now:** enumerate only capability-backed actions; show unavailable actions as unavailable.
4. **Connect existing accounts:** optional runtime discovery through documented safe adapters; `Skip for now` is always equal in prominence and no secrets are requested/stored by the UI.
5. **Safety boundaries:** cannot silently modify routes/models/credentials; explain review, receipt, and `UNPROVEN` states.
6. **Finish:** dashboard entry plus a persistent way to replay onboarding.

## Checkpoint execution template

Every checkpoint begins with a compact plan in `.account-center-pipeline/<id>.md` (local, ignored):

```md
# <ID> — <name>
State: PLANNED
Worktree: /tmp/account-center-<id>
No-touch: <files/runtimes/accounts>

## Micro-tasks
1. ...
2. ...

## Acceptance evidence
- ...

## Review results
- Spec: pending
- Quality: pending
- QA: pending
```

The coordinator creates this plan, then the implementation worker executes only its listed micro-tasks. The coordinator records reviewer verdicts and the merge SHA before selecting the next ID.
