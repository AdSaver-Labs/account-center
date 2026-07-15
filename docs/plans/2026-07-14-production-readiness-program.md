# Account Center Production-Readiness Program

> **For Hermes:** Execute one bounded vertical slice at a time with strict TDD, independent review, and a full verification gate before committing. Never mark an `UNPROVEN`, blocked, unsupported, or inferred result as production-ready.

**Goal:** Deliver a production-ready, local-first, Mac-installable Account Center with protected human and agent control surfaces, truthful runtime proof, recovery, and release operations.

**Architecture:** Account Center remains a loopback-only, bearer-protected control plane. Its core owns machine-readable policy, confirmation, idempotency, receipts, audit, update planning, and proof/result unions. Runtime adapters may use only supported stable interfaces; browser UI is an operator surface over protected API contracts, never an authority or automation substitute.

**Non-negotiable release rule:** A feature is production-ready only after its exact runtime interface, failure/recovery behavior, secret-redaction properties, tests, and real platform smoke proof are verified. Any unmet prerequisite remains blocked.

---

## Program gates

### Gate P0 — Source and boundary proof

- [ ] Document supported runtime interfaces, ownership boundaries, and exact reasons for every blocked operation.
- [ ] Confirm no runtime mutation uses direct credential-store edits, browser scraping, private bundled APIs, arbitrary shell, arbitrary Git ref, or arbitrary URL input.
- [ ] Maintain capability discovery so agents stop on `blocked`, `unsupported`, `failed`, and `UNPROVEN`.

**Current status:** In progress. Guided-auth lifecycle records persist only redacted metadata, scrub legacy raw account targets on read, durably mark elapsed pending records as `expired` when read, and serialize concurrent local creation so the same active request has one durable redacted record; local cancellation is protected and available. Its bodyless cancellation endpoint rejects body-bearing requests before local state changes. Protected operation history is available as a bearer-protected redacted lifecycle/outcome view, excluding request, target, scope, and idempotency digests. Bearer-protected read-only model and runtime-scope catalogs expose only model IDs/policy-derived selectability and observed runtime default scopes/declared capabilities, never profile/account metadata. Capability discovery now supplies machine-readable state, prerequisites, and fixed method/path bindings for every available public local action, including those catalogs, redacted challenge inventory/detail/cancellation, and audit/operation-history reads; unavailable runtime mutations deliberately have no endpoint binding. The unavailable route, guided-auth start, and model runtime mutations each declare `explicit_runtime_scope`, preventing clients from inferring a default, named, or `all` scope. It also supplies machine-readable reasons for every currently unavailable runtime mutation: guided-auth start is `protected_start_contract_missing_review_idempotency_runtime_proof`, routes are `protected_route_contract_missing_scoped_review_idempotency_runtime_proof`, models are `protected_model_contract_missing_scoped_review_idempotency_runtime_proof`, and update apply is `macos_signed_artifact_package_supervisor_backup_restart_health_proof_missing`. Exact OpenClaw credential deletion is blocked because no stable native exact-profile deletion API exists.

### Gate P1 — Protected mutation control plane

- [ ] Define versioned request/result schemas for preview, confirmation, idempotency, apply, receipt, audit, and proof.
- [ ] Wire guided add/reauth lifecycle to protected API and CLI with secret-free persistence.
- [ ] Implement scoped routing and model-policy operations only where a stable runtime capability exists.
- [ ] Add request bounds, origin/CSRF protection, replay/idempotency behavior, exception containment, and integration tests.

### Gate P2 — Complete operator interface

- [ ] Implement the committed UI specification against P1 APIs.
- [ ] Add accessible loading, empty, unsupported, blocked, recovery, and verified-success states.
- [ ] Run desktop/narrow visual and keyboard smoke tests.

### Gate P3 — Package, supervisor, and self-update proof

- [ ] Select a supported macOS package format and `account-center-local` supervisor.
- [ ] Produce immutable signed artifacts plus manifest/signature/provenance chain.
- [ ] Prove clean installation, loopback startup, token protection, narrow self-restart, health proof, backup, rollback, and uninstall on macOS.
- [ ] Keep update apply blocked until all P3 evidence exists.

### Gate P4 — Production validation

- [ ] Full test/type/build/security/dependency/secret-scan gate passes.
- [ ] Live API/UI/runtime smoke proves safe paths and accurately blocked paths.
- [ ] Threat model, operations guide, recovery guide, API contract, install guide, and release notes are current.
- [ ] Independent final review finds no unresolved release-blocking issue.
- [ ] Version tag and signed production artifacts are pushed.

---

## Execution order

1. Finish P0 capability evidence and extend it into exact API schema tests.
2. Build P1 one endpoint/workflow at a time: test → red → minimal implementation → integration test → review → commit.
3. Implement P2 only after each backing P1 API is available; do not create placebo controls.
4. Choose and prove P3 on actual macOS hardware; no Linux-only test may substitute for this proof.
5. Run P4 repeatedly until every release-gate item is verified and documented.

## Immediate vertical slices

1. Add protected, versioned mutation-operation records: preview, confirmation binding, idempotency key, receipt, audit, and proof-state result union.
2. Wire guided-auth challenge start/list/cancel through the protected API with strict redaction and expiry tests.
3. Add a read-only scopes/models API and then safe preview-only route/model plan endpoints.
4. Select the supported macOS packaging/supervision model from authoritative evidence; add package build and clean-install smoke path.
5. Implement UI pages only for completed API contracts.

## Per-slice completion checklist

- [ ] Failing test was observed before production implementation.
- [ ] Implementation uses no secret-bearing output or logging.
- [ ] Result union distinguishes `applied`, `blocked`, `failed_no_change_verified`, `UNPROVEN`, and `recovery_required` where applicable.
- [ ] Unit and integration tests pass.
- [ ] `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check` pass.
- [ ] Changes are committed and pushed with a concise message.
- [ ] Release gate and agent-operations documentation are updated truthfully.
