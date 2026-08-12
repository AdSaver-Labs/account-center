# Account Center Release Gate

**Status:** In progress — *not ready for user installation yet.*

## Release definition

Account Center is ready for Alej to install and test only when every gate below is completed, independently verified, committed, and pushed. A partial UI, a passing unit suite, or a single runtime smoke is not release readiness.

## Product acceptance gates

### 1. Controlled account operations

- [x] Status, limits, connected-account inventory, and routing views expose only redacted metadata; protected HTTP, CLI, MCP, and Hermes automation projections use fixed allow-list DTOs with opaque account/connection references and weekly-only capacity.
- [x] `/auth add` and `/auth reauth` create distinct durable guided-auth challenges.
- [ ] Challenge lifecycle supports start, cancel, expire, complete, and verified failure without storing credentials.
- [x] Durable guided-auth challenge records exclude raw account targets; legacy records are redacted on read before reuse, elapsed pending records transition durably to `expired` when read, and protected inventory responses expose only redacted lifecycle metadata plus an optional expiry timestamp.
- [x] Existing durable guided-auth challenges can be cancelled only through the bearer-protected, same-origin `POST /api/auth-challenges/:id/cancel?runtime=<observed>&scope=<observed>` endpoint. Exactly one observed `runtime` and `scope` are mandatory; missing, partial, duplicate, malformed, or unpublished selectors fail closed before lifecycle-store access. Its versioned response and persisted state expose redacted metadata only.
- [x] Durable Account Center audit history is available through the bearer-protected `GET /api/audit` endpoint as bounded, newest-first, redacted records; request digests and unsafe context are not returned.
- [x] Durable protected-operation history is available through the bearer-protected `GET /api/mutation-operations` endpoint with redacted lifecycle/outcome evidence only; request, target, scope, and idempotency digests are not returned. Malformed persisted operation records are rejected as corrupt before they can reach that view.
- [ ] Reauth follows `stage → verify identity/health → optional route switch → receipt`; previous working auth remains usable until verified.
- [x] `/auth remove` changes routing only; it requires an observed exact agent scope, canonical connected target, preview/review/idempotency, native route-only apply, and fresh scoped verification with redacted durable evidence.
- [x] `/auth delete` requires an exact normalized connected identity, takes a runtime backup, returns a redacted receipt, and proves the outcome or labels it `UNPROVEN`.
- [x] Every mutation uses the shared command executor and produces audit/receipt output; scoped OpenClaw manual/automatic route actions require preview/review/idempotency, exact confirmation, redacted durable evidence, and fresh post-apply verification.

### 2. Scope and model policy

- [ ] Every account/model action uses explicit runtime and scope (`openclaw|hermes|codex`, plus agent/profile/session/default/all where supported).
- [x] Bearer-protected `GET /api/scopes` exposes a versioned, redacted catalog of each observed runtime's supported default scope and declared capabilities; named agent/profile/session and `all` scopes remain unavailable until authoritative runtime scope evidence exists.
- [ ] Active OpenClaw agent scope changes require a warning/confirmation flow.
- [x] Model catalog, requested policy, effective runtime model, fallback, eligibility, and verification state are distinct.
- [x] Unsupported, unentitled, read-only, unknown, and `UNPROVEN` states are rendered honestly, terminal where unavailable, and fixture-tested to fail closed on malformed or absent evidence.
- [ ] Codex chat/session mutation remains read-only unless a supported safe write surface is detected.

### 3. Secure local control plane

- [x] Server binds only to loopback by default and issues a per-launch token.
- [ ] API authentication, origin checks, no-store headers, input validation, CSRF/confirmation policy, and redacted error handling are tested.
- [ ] API routes cover status, accounts, routing, guided-auth lifecycle, model policy, receipts, and audit history through the shared executor.
- [x] No credential values, OAuth/device codes, account email addresses, tokens, or raw runtime configuration are returned or logged.

### 4. Codex-owned interface

- [ ] Codex owns the completed visual system and UI implementation.
- [ ] Responsive, keyboard-accessible views exist for dashboard/status, account/routing, guided add/reauth, model policy/fallback, receipts/audit, and destructive-operation confirmation.
- [ ] UI exposes loading, empty, error, success, unsupported, read-only, and `UNPROVEN` states.
- [ ] UI actions call the protected local API; it is not a status-only mock shell.
- [ ] A Settings / Update Center lets the operator check for, review, and explicitly apply verified Account Center updates without manually pulling from GitHub; it shows installed/available versions, release provenance and notes, creates a backup, restarts only the local Account Center process, health-checks the result, and reports verified/`UNPROVEN`/rollback state.
- [ ] Update Center never silently executes arbitrary repository code, accepts a branch name as a release, or updates Hermes/OpenClaw/Codex; those platforms remain separate controlled update surfaces.
- [x] Visual and accessibility QA pass at desktop and narrow viewport sizes: independent Chromium proof covers desktop, 760px, 430px, and 320px with no horizontal page overflow; token focus repair, keyboard tab navigation, truthful blocked/UNPROVEN states, guided-auth cancellation focus restoration, and axe scans with no serious or critical violations.

### 5. Installability and release verification

- [ ] One documented install/build/start path works on a clean supported Node 24 environment.
- [ ] A green GitHub Actions run for the current release candidate must verify `npm test`, `npm run typecheck`, `npm run build`, API/security integration tests, owned-delete transaction tests, and fixture-only browser/accessibility tests. Fixed historical test counts are not release evidence.
- [x] Dependency audit and the tracked release-source/fixture secret scan have no unresolved release blockers. The scan covers tracked application source, public API/browser fixture inputs, workflow/configuration, and documentation; it rejects recognized provider keys, private keys, and generic bearer values with path/line-only diagnostics. Generated local status, receipts, browser reports, traces, screenshots, videos, and dependency trees are intentionally excluded because they are ignored, are not CI-uploaded or release artifacts, and must not be used as release evidence. Among tracked files, only `.png`, `.jpg`, and `.zip` are excluded; every other UTF-8-readable file is scanned. Public projections are instead covered by tracked fixture and browser assertions.
- [x] A real fixture-only local launch smoke proved loopback binding, token protection, dashboard load, and the safe local guided-auth cancellation flow; no live runtime routing, credential, or model change was attempted or claimed.
- [ ] README, API/command contract, threat/safety model, rollback/backup behavior, and test instructions are current.
- [ ] Release commit and tag are pushed; final handoff gives exact Mac install/test steps and known limitations.

## Delivery sequence

1. Complete durable challenge lifecycle and guarded executor operations.
2. Complete runtime/model adapters and truthful verification results.
3. Complete API endpoints plus security/integration tests.
4. Have Codex implement the complete action UI against the finished API contract.
5. Run security, accessibility, UI, package, and live-runtime verification gates.
6. Fix every release blocker; repeat until green.
7. Commit/push a release candidate and provide the installable handoff.

## Explicit non-goals for the first local beta

- Account Center will not store raw credentials or OAuth payloads.
- It will not silently modify Codex chat/session account state where no supported mutation API exists.
- It will not merge Account Center with the separate Shared Brain project.
