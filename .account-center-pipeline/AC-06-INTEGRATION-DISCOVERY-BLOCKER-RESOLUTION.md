# AC-06 Integration Discovery Blocker Resolution — Superseded

> **Superseded 2026-07-25.** This discovery artifact assessed only upstream public OpenClaw CLI capability. It is not a current AC-06 blocker: the owned exact-account transaction at `3-Resources/codex-account-ops/scripts/codex-auth-delete.py` exists locally and is used by Dexter `/auth delete`. The active bounded implementation plan is `.account-center-pipeline/state.json` and `AC-06.md`; its fixture-only adapter integration must preserve Sentinel `/auth` formatting and weekly-only policy. This historical document must not be read as authorization for live deletion tests.

**Status:** bounded design/evidence artifact; credential deletion remains blocked.

**Decision:** Do not enable OpenClaw/Sentinel credential deletion until the provider supplies and documents the contract below.

## Scope and hard stop

This artifact is a discovery result, not an adapter implementation or an approval to mutate anything. No live credential delete, provider apply, provider probe/test, re-login, store edit, Sentinel mutation, or recovery exercise is permitted for AC-06. In particular, Account Center must not use undocumented OpenClaw internals, edit `auth-profiles.json`, `auth-state.json`, or SQLite, invoke a browser flow, or treat a command exit code or a status snapshot as deletion proof.

`/auth delete <target>` therefore remains `BLOCKED`/`UNPROVEN`. A dry-run may describe the block, but it must not attempt a provider transaction.

## Installed OpenClaw evidence

Evidence was inspected locally from the installed package, not inferred from a live mutation:

- `/home/Alej/.npm-global/lib/node_modules/openclaw/package.json` identifies installed OpenClaw as **`2026.7.1-2`** (lines 1–18).
- `/home/Alej/.npm-global/lib/node_modules/openclaw/docs/cli/models.md` documents the `models auth` command surface (lines 134–180). It documents `models auth login --force` as removing **existing profiles for the provider** before re-login (line 154): provider-wide removal during a re-login workflow, not an exact-profile delete transaction.
- The same document describes `models auth list` as listing saved profiles (line 152), but documents no public exact-profile credential-delete command or API; its listed commands contain no delete operation (lines 136–147).
- No documented provider-owned backup/rollback transaction, recovery operation, redacted deletion receipt, or fresh authoritative post-delete proof is present in that CLI reference. `models status --probe` is explicitly a live probe that can make real requests, consume tokens, and trigger rate limits (lines 42–49), so it is not permitted as AC-06 validation and would not establish deletion anyway.

**Conclusion:** `models auth login --force` is rejected as an integration substitute: it is provider-wide/destructive and couples removal to re-login. It cannot establish the identity, reversibility, receipt, or postcondition required for deleting one selected credential profile.

## Compatibility invariants

Until a conforming capability is available, and after it is integrated:

1. The human `/auth` and `/auth status` command format is byte-compatible with the established status contract. This work must not add a delete-policy banner, reorder lines, normalize whitespace, or otherwise alter the normal status rendering.
2. Detailed Sentinel output remains intact, including its existing account/route diagnostics, usage-window detail, warnings, and redaction behavior. A delete block is rendered only on the delete path/help contract, never by degrading or replacing Sentinel status.
3. The Hermes/Dexter eligibility policy remains **weekly-only**. Credential-delete work must not reinterpret it as a 5-hour/daily eligibility rule, alter weekly thresholds, alter account roles, or cause route selection.
4. Existing AC-06 process-private blocked-delete receipt helper and receipt filesystem repairs are out of scope. Account Center continues to report only its redacted local blocked-operation metadata; that metadata is not proof that a provider credential was deleted.

## Required provider capability contract

The provider must expose a supported, versioned, documented interface. Account Center is only a client of this interface; it must not receive credential material or provider backup locations.

### Exact target identity

Every operation must accept one opaque, provider-issued `CredentialTarget` identity. The **exact target tuple** is, in this order, `(providerId, profileId, agentScope, credentialGeneration)`; all four fields are one indivisible identity and comparison is exact field-for-field equality. It is not a partially specified selector.

```text
providerId             // canonical provider namespace, e.g. "openai"
profileId              // exact saved credential-profile identity, not an email/display name
agentScope             // exact configured OpenClaw agent identity/store scope
credentialGeneration   // provider-issued version/generation for compare-and-delete safety
```

Validation constraints are mandatory: each field must be a non-empty provider-issued canonical opaque identifier (not whitespace, a display name, email, filename, filesystem path, or Account Center-derived value); `providerId` and `agentScope` must name one configured provider namespace and one configured agent store; `profileId` must resolve to exactly one saved profile in that scope; and `credentialGeneration` must equal that profile's current generation at prepare time. The provider resolves, authorizes, and validates the complete tuple atomically. Account Center may select a tuple only from a current authoritative provider status response; it must never derive identity from a display name, email, filesystem path, config heuristic, or auth-order position. A missing, stale, ambiguous, inherited, cross-agent, cross-provider, or provider-wide target must fail before prepare, without creating a transaction or changing a store.

### Transaction interface

Names are illustrative but the observable semantics are mandatory. Inputs and outputs must contain no credential, token, cookie, API key, refresh token, email, raw filesystem path, or backup contents.

```ts
type CredentialTarget = {
  providerId: string;
  profileId: string;
  agentScope: string;
  credentialGeneration: string;
};

type OpaqueReceiptHandle = string; // unguessable provider-issued reference; not a path or secret
// Provider-owned, unguessable, non-derivable authority minted only by prepare.
// It is neither a target nor an idempotency key and is invalid outside this transaction.
type OpaqueRecoveryCapability = string;

// The provider rejects empty/non-canonical values and treats these four fields
// as the exact tuple (providerId, profileId, agentScope, credentialGeneration).
// A target is valid only when it resolves to one current, direct saved profile.

// This is a locator only; it cannot be used to prepare or commit a deletion.
// The provider resolves it atomically and returns the complete canonical tuple.
type CredentialTargetDiscoveryRequest = {
  providerId: string;
  profileId: string;
  agentScope: string;
};

type AuthoritativeCredentialTargetDiscovery = {
  // The complete, provider-issued tuple; no partial target is returned.
  target: CredentialTarget;
  // Decimal, non-negative revision, numerically monotonic for this exact tuple.
  statusRevision: string;
  // Provider-clock bounds for use as a prepare precondition, RFC 3339 instants.
  observedAt: string;
  expiresAt: string;
};

type CredentialDeletionStatusSelector = {
  // All three fields are REQUIRED: transactionId and target are the paired-
  // consistency binding, and minimumStatusRevision is separately required.
  transactionId: string;
  target: CredentialTarget;
  // Decimal, non-negative authoritative revision; provider compares numerically.
  minimumStatusRevision: string;
};

type ProofFreshness = {
  authoritativeRead: true; // read directly from the provider, never a cache/export
  observedAt: string; // provider clock, RFC 3339 instant for this read
  satisfiesMinimumStatusRevision: true;
};

type AuthoritativeCredentialDeletionStatusBase = {
  // Echoes the selector's paired-consistency binding. transactionId and target
  // must exactly equal the prepared transaction and tuple, respectively.
  transactionId: string;
  target: CredentialTarget;
  // Decimal, non-negative provider revision, numerically monotonic for this exact tuple.
  // A later authoritative mutation/proof for the tuple has a strictly greater revision.
  statusRevision: string;
  proofFreshness: ProofFreshness;
  receiptHandle: OpaqueReceiptHandle;
};

type NonterminalCredentialDeletionStatus = AuthoritativeCredentialDeletionStatusBase & {
  // null is non-terminal/in-progress, not deletion proof.
  terminalState: null;
  terminalProofExpiresAt: null;
  // This commit baseline does not exist in a nonterminal proof and is forbidden.
  preCommitStatusRevision?: never;
};

type TerminalNonSuccessCredentialDeletionProof = AuthoritativeCredentialDeletionStatusBase & {
  // Immutable terminal non-success proof; no deletion commit baseline may be claimed.
  terminalState: "rolled_back" | "recovery_required";
  terminalProofExpiresAt: string;
  preCommitStatusRevision?: never;
};

type TerminalDeletedCredentialDeletionProof = AuthoritativeCredentialDeletionStatusBase & {
  // Immutable provider-journaled authoritative deletion proof, never a local receipt field.
  terminalState: "deleted";
  terminalProofExpiresAt: string;
  // Decimal, non-negative provider revision journaled atomically at start of this
  // transaction's commit, internally bound to its same transaction and exact tuple.
  // It is provider-derived, never Account Center supplied or locally retained.
  preCommitStatusRevision: string;
};

type AuthoritativeCredentialDeletionStatus =
  | NonterminalCredentialDeletionStatus
  | TerminalNonSuccessCredentialDeletionProof
  | TerminalDeletedCredentialDeletionProof;

type PrepareDeleteRequest = {
  // All three values are copied verbatim from one unexpired discovery response.
  target: CredentialTarget;
  idempotencyKey: string;
  expectedStatusRevision: string;
  discoverySnapshot: AuthoritativeCredentialTargetDiscovery;
};

type PreparedDelete = {
  // Opaque provider transaction reference. Account Center may retain it only as
  // redacted receipt metadata and must never persist the target or idempotency key.
  transactionId: string;
  // Provider-clock deadline for the still-uncommitted prepared state.
  expiresAt: string;
  receiptHandle: OpaqueReceiptHandle;
  recoveryCapability: OpaqueRecoveryCapability;
  rollbackAvailable: true;
};

interface ProviderCredentialDeletionV1 {
  discoverCredentialTarget(
    request: CredentialTargetDiscoveryRequest
  ): Promise<AuthoritativeCredentialTargetDiscovery>;
  prepareDelete(request: PrepareDeleteRequest): Promise<PreparedDelete>;
  commitDelete(transactionId: string, idempotencyKey: string): Promise<{
    transactionId: string;
    receiptHandle: OpaqueReceiptHandle;
    state: "committed" | "already_committed";
  }>;
  rollbackDelete(transactionId: string, idempotencyKey: string): Promise<{
    transactionId: string;
    receiptHandle: OpaqueReceiptHandle;
    state: "rolled_back" | "already_rolled_back";
  }>;
  // Provider resolves the transaction and exact tuple from the capability; this
  // is the only recovery/status route Account Center may use after persistence.
  recoverCredentialDeletionStatus(
    recoveryCapability: OpaqueRecoveryCapability
  ): Promise<AuthoritativeCredentialDeletionStatus>;
  getCredentialDeletionStatus(
    selector: CredentialDeletionStatusSelector
  ): Promise<AuthoritativeCredentialDeletionStatus>;
}
```

`discoverCredentialTarget` is the required authoritative pre-prepare read, not a broad list, cache, export, status rendering, or transaction-status substitute. For one exact provider/profile/agent locator, the provider authorizes and resolves one direct saved profile atomically and returns **only** the complete canonical `CredentialTarget`, its numeric monotonic `statusRevision`, and the provider-clock freshness bounds above; it returns no credential material, tokens, cookies, emails, paths, backup references, credential metadata, or alternate targets. Ambiguous, inherited, cross-agent, cross-provider, absent, or non-canonical locators fail without a snapshot or mutation. The response is provider-authoritative only when it comes directly from the same provider namespace named by `target.providerId`; Account Center must not construct, merge, cache-substitute, or obtain this snapshot from Sentinel or another provider.

Before `prepareDelete`, Account Center must call `discoverCredentialTarget` and retain that one response as the pre-prepare snapshot. `PrepareDeleteRequest.target` must field-for-field equal `discoverySnapshot.target`, and `expectedStatusRevision` must exactly equal `discoverySnapshot.statusRevision`; the provider rejects every mismatch. It also rejects a snapshot unless it issued that exact tuple/revision, the request is handled by the same provider authority as `target.providerId`, and provider clock is within `observedAt`/`expiresAt` at prepare. `expiresAt` is a provider-enforced short freshness deadline, never caller-extended; an expired, replayed, stale, non-monotonic, cross-provider, or otherwise unverifiable discovery snapshot fails before a transaction, backup, or store change. The provider must compare `expectedStatusRevision` numerically with the then-current revision and reject any change. Thus a prepare can be authorized only by a fresh, same-provider discovery read and never by a pre-existing transaction status (which does not exist until after prepare).

`getCredentialDeletionStatus` has no transaction-only, target-only, default-target, or broad-list form. Its selector is valid only when **all three** required values are supplied. `transactionId` and `target` are the paired-consistency binding: `transactionId` must identify one transaction originally prepared for precisely the supplied full `CredentialTarget`; the supplied tuple must exactly equal that transaction's recorded tuple. Otherwise the provider rejects the request and returns no status proof. Separately, `minimumStatusRevision` is required and must be the numeric revision obtained before commit (or the most recently returned authoritative revision during recovery); a response is valid only if its numeric `statusRevision >= minimumStatusRevision`. Account Center must reject a response unless its `transactionId` and every `target` field exactly echo the selector.

Required semantics:

- **Discover then prepare:** discovery is the only authoritative source of the exact target/revision before a transaction exists. Prepare validates the fresh, same-provider discovery snapshot and its exact live target/revision, takes a provider-owned rollback-capable backup before any store change, reserves one transaction bound permanently to that exact tuple, and mints an unguessable provider-owned `recoveryCapability` with its opaque transaction/receipt handles. It changes neither routing nor credential availability. The capability is sufficient for provider-side recovery/status, but conveys no target, idempotency key, credential, or backup location.
- **Account Center retention boundary:** Account Center may use the exact target and original idempotency key in the in-memory request that prepares/commits the transaction, but must discard both when that request completes or is interrupted. Its durable receipt contains only operation class, outcome/proof state, timestamps/expiry, and redacted opaque `transactionId`, `receiptHandle`, and `recoveryCapability` correlation metadata. It must not persist raw target fields, a serialized target, a target digest, the raw idempotency key, or an idempotency digest. The provider alone journals the tuple/key binding.
- **Prepared expiry:** `PreparedDelete.expiresAt` is a provider-clock, immutable deadline for an uncommitted prepared transaction. Before it, commit is permitted only with the original transaction/key. At or after it, a commit that has not already atomically begun is rejected without a credential-store change and can never be revived by replaying a key or capability. Rollback remains accepted for the original transaction/key through and after this deadline; for an uncommitted expired prepare it releases the provider backup and finalizes `rolled_back` without deleting. `recoverCredentialDeletionStatus(recoveryCapability)` is accepted through and after this deadline and must atomically finalize an uncommitted expired prepare as `rolled_back`, or return terminal `recovery_required` if it cannot safely do so. A commit that atomically began before expiry has one provider-journaled outcome; recovery reports that outcome and never starts a second delete.
- **Commit:** is idempotent only for the supplied `transactionId` and its original idempotency key, affects only that transaction's prepared tuple, is atomic from the provider's perspective, and returns only a redacted/opaque handle. At the atomic start of commit, the provider must journal the then-current decimal non-negative `statusRevision` as `preCommitStatusRevision`, internally bind it to that same transaction and exact tuple, and retain it in its immutable terminal `deleted` proof. This baseline is provider-owned: Account Center must not supply, alter, infer, or persist it. It must never expand to all profiles for a provider or initiate login. A commit reply alone is not deletion success.
- **Rollback:** is idempotent only for the supplied transaction/key and restores only the provider-owned prepared backup for that transaction's exact tuple. It may finalize a non-terminal committed outcome as `rolled_back` under provider atomicity rules, but cannot alter an already terminal proof. It is available until finalization, including an uncommitted expiry, without requiring Account Center to retain the tuple/key after a restart.
- **Recovery/status capability:** after transport failure, timeout, restart, expiry, or uncertain outcome, Account Center calls only `recoverCredentialDeletionStatus(recoveryCapability)`. The provider authenticates the opaque capability, resolves its one journaled transaction and exact tuple internally, performs any safe recovery/finalization, and returns the complete `AuthoritativeCredentialDeletionStatus`. A terminal `deleted` capability response must carry its provider-journaled `preCommitStatusRevision`; Account Center verifies it is decimal/non-negative and that `statusRevision` is numerically strictly greater, without retaining raw target, idempotency key, or baseline across restart. Nonterminal and terminal non-success responses must not claim this deletion baseline. It must not accept a caller target or idempotency key, guess, bind to another tuple, or repeat a destructive write. This capability route is deliberately distinct from normal status.
- **Normal status proof remains strict:** `getCredentialDeletionStatus` remains the sole ordinary status API and has no capability-only, transaction-only, target-only, default-target, or broad-list form. It requires all three selector values: the paired transaction-and-complete-target consistency binding and the separately required minimum status revision described above. `AuthoritativeCredentialDeletionStatus` is the sole proof object for both this strict route and the provider-side recovery/status capability route. Each returned proof must carry the journaled exact transaction and full tuple and `proofFreshness.authoritativeRead === true`; Account Center validates all fields when it has an in-memory selector, while after restart the provider capability is the authority that returns the complete bound proof. Its `statusRevision` is numerically monotonic for that exact tuple, and the provider must not satisfy a proof from a cache, export, or pre-commit observation. Only an immutable terminal `deleted` proof carries `preCommitStatusRevision`; nonterminal and terminal non-success proofs must omit it. For a terminal `deleted` proof, both revisions must be decimal non-negative and its `statusRevision` must be numerically strictly greater than its same-transaction-and-tuple-bound `preCommitStatusRevision`; equality, reversal, malformed values, or a baseline not journaled atomically at commit start is `UNPROVEN`. `terminalState === "deleted"` means that exact tuple is authoritatively absent/deleted at `observedAt`; it must distinguish that result from a merely reordered, hidden, unreadable, inherited, replaced-generation, or provider-wide-cleared profile. `"rolled_back"` and `"recovery_required"` are terminal non-success outcomes; `null` is not terminal and is never success. An old cached Sentinel export, exit status, and generic provider health are not proof.
- **Terminal proof retention/expiry:** once a transaction reaches any terminal state, the provider records an immutable terminal proof and retains the recovery capability and proof for a documented provider-clock `terminalProofExpiresAt` that is no earlier than the prepared deadline and sufficient for the documented recovery window. Before that expiry, recovery/status returns the same transaction-and-exact-tuple-bound terminal proof idempotently and neither commit nor rollback may mutate it. At/after terminal-proof expiry, the provider may retire the capability and journal only after its retention policy; a recovery call must return an explicit `terminal_proof_expired` error, never a partial status or success. Account Center treats expiry or inability to retrieve the retained terminal proof as `UNPROVEN` and preserves only its redacted opaque metadata for escalation.

Account Center may expose deletion success only when (1) its `commitDelete` reply echoes the original transaction, (2) it obtains a subsequent strict `getCredentialDeletionStatus` while its in-memory exact tuple is available, or `recoverCredentialDeletionStatus` from its persisted recovery capability after interruption, (3) the returned terminal proof carries the same journaled transaction and complete exact tuple, (4) `proofFreshness.authoritativeRead` and `satisfiesMinimumStatusRevision` are true, (5) its provider-journaled `preCommitStatusRevision` and `statusRevision` are decimal non-negative and the latter is numerically strictly greater than the former, and (6) `terminalState === "deleted"`. After restart, Account Center makes that comparison from the recovery response itself and must not persist raw target, idempotency, or baseline. Any missing/expired capability or terminal proof, absent/nonterminal/locally supplied baseline, malformed/non-monotonic/non-advancing revision, tuple or transaction mismatch, non-terminal/ambiguous result, `rolled_back`, `recovery_required`, transport uncertainty, or inability to obtain fresh proof is `UNPROVEN`; it stops automation and preserves the opaque handles for operator escalation. Recovery may clear `UNPROVEN` only by returning the same transaction-and-tuple-bound fresh terminal proof with terminal state `deleted` and the verified internal revision advance; it must otherwise remain `UNPROVEN`/`recovery_required` and must not start a new delete transaction automatically.

## Filesystem and receipt boundary

| Owner | May own | Must not expose or do |
|---|---|---|
| Provider/OpenClaw | Credential store, exact-profile mutation, provider-owned encrypted/private backup, transaction journal, restoration, authoritative proof data | Must not delegate credential backup/restore to Account Center or disclose backup paths/contents/credentials. |
| Account Center | Its existing process-private receipt directory and minimal redacted metadata: operation class, outcome/proof state, timestamps/expiry, and opaque transaction/receipt/recovery-capability handles | Must not copy credentials, backups, raw target identity (including serialized/digested target), raw/digested idempotency, filesystem paths, or provider store snapshots; must not represent its local receipt as provider deletion proof. |
| Sentinel | Read-only detailed status compatibility surface | Must not be edited, used as a transaction journal, or treated as authoritative fresh deletion proof. |

The provider receipt and recovery-capability handles are opaque and stable enough to reconcile a transaction. Account Center may store only redacted opaque correlation metadata derived from them in its process-private receipt. It must use the provider-owned recovery capability—not a locally retained target or idempotency key—for post-interruption recovery/status, and must not transform this metadata into a backup, a local recovery mechanism, or evidence stronger than the provider proof.

## Acceptance criteria for enablement

Enablement is eligible for review only when all items are demonstrated with non-production fixture/sandbox evidence supplied by the provider capability owner:

1. A public, versioned OpenClaw/provider document specifies `discoverCredentialTarget` plus an exact-profile delete interface rather than `login --force`.
2. The discovery read returns only a complete exact provider-issued target tuple and numeric monotonic status revision, with provider-enforced freshness bounds and no credential material; it rejects ambiguous, wrong-agent, inherited, and provider-wide locators without mutation.
3. Prepare is demonstrably bound to one unexpired same-provider discovery snapshot: its tuple and expected revision are copied exactly, stale/replayed/cross-provider snapshots and revision changes fail before a transaction or store change.
4. Prepare creates a provider-owned rollback-capable backup before change and exposes neither backup content nor location.
5. Prepare mints an unguessable provider-owned opaque recovery capability; commit and rollback are idempotent and transaction/key-bound, while capability recovery/status is bound by the provider to exactly that one transaction/tuple and cannot affect another profile, provider, or agent.
6. Account Center durable receipts contain only permitted redacted opaque metadata and no raw/serialized/digested target or raw/digested idempotency; restart recovery works solely through the persisted recovery capability.
7. Normal `getCredentialDeletionStatus` remains strict (paired transaction plus full exact target selector), while `recoverCredentialDeletionStatus(recoveryCapability)` returns a complete authoritative proof that includes the provider-journaled transaction and exact tuple.
8. The provider demonstrates that, atomically at commit start, it journals a decimal non-negative `preCommitStatusRevision` internally bound to that same transaction and exact tuple; this provider-owned baseline is neither supplied by Account Center nor present in any local receipt.
9. The discriminated proof contract permits `preCommitStatusRevision` only on an immutable terminal `deleted` proof; nonterminal and terminal non-success proofs omit it. A terminal deleted proof has decimal non-negative revisions and a numerically strictly greater `statusRevision` than its journaled baseline.
10. Fixture/sandbox crash-restart evidence shows recovery capability returns that terminal deleted proof and Account Center verifies the internal numeric advance after restart without persisting raw target, idempotency, or baseline; missing/malformed/non-advancing proof remains `UNPROVEN`.
11. Fresh authoritative status proof is revisioned and proves the exact selected profile is deleted after commit; it distinguishes the stated false positives.
12. Prepared expiry is provider-clock enforced: post-expiry unstarted commit is rejected without mutation; rollback/recovery finalize the uncommitted prepare as `rolled_back` or explicit `recovery_required`; a pre-expiry begun commit has one recovered journaled outcome.
13. Terminal proofs are immutable, capability-retrievable through their documented retention deadline, and then fail explicitly as `terminal_proof_expired`, never guessed success.
14. Failure, timeout, crash/restart, and uncertain-state cases converge through provider capability recovery/status to a complete terminal proof or explicit `recovery_required`, never a guessed success.
15. Compatibility tests prove byte-identical normal `/auth status` output, preserve detailed Sentinel output, and preserve Hermes/Dexter weekly-only policy.
16. An independent security/spec review confirms no direct store edit, undocumented internal, live credential, live Sentinel mutation, or live deletion test was used.

## Rejection evidence / fail-closed conditions

Reject the integration and keep delete `BLOCKED`/`UNPROVEN` if any of the following is the only available behavior or evidence:

- `models auth login --force`, re-login, auth-order manipulation, a browser/UI workflow, agent deletion, or provider-wide profile clearing is offered instead of exact-profile deletion.
- The target is an email, display label, filename, loose profile string, or default agent inference rather than the full provider-issued identity tuple.
- Backup/rollback is absent, caller-owned, path-based, non-atomic, undocumented, or cannot be recovered after an interrupted request.
- A receipt contains secret material or a raw provider filesystem path, is not opaque/redacted, or is only an Account Center local receipt.
- Proof is based on an exit code, stale status export, generic health, changed auth ordering, disappearance from one listing, cached snapshot, or a live probe without an authoritative exact-target status revision.
- Recovery lacks a provider-journaled, same-transaction-and-exact-tuple-bound decimal non-negative `preCommitStatusRevision`, exposes it on a nonterminal/non-success proof, or accepts a deleted proof whose `statusRevision` does not numerically strictly advance beyond it.
- Any validation needs a production credential, live delete/apply, re-login, Sentinel mutation, or modification of the existing AC-06 receipt helper.
- Normal `/auth status` bytes, detailed Sentinel output, or Hermes/Dexter weekly-only policy change as a side effect.

## Smallest external capability request

Request one narrow provider feature, not a general credential-store API:

> **OpenClaw Provider Credential Deletion Transaction v1:** for one exact provider-issued profile identity in one configured agent store, expose documented `discoverCredentialTarget`, `prepareDelete`, `commitDelete`, `rollbackDelete`, strict paired-selector `getCredentialDeletionStatus`, and `recoverCredentialDeletionStatus(recoveryCapability)`. Discovery must be a same-provider authoritative read that returns only the complete exact `CredentialTarget`, a numeric monotonic status revision, and provider-enforced short freshness bounds; prepare must bind verbatim to that unexpired snapshot/revision and mint an unguessable provider-owned opaque recovery capability. At atomic commit start, the provider must journal a decimal non-negative `preCommitStatusRevision` internally bound to the same transaction/exact tuple; only an immutable terminal `deleted` proof carries it, and its `statusRevision` must numerically strictly exceed it. Recovery by capability must return this complete bound deleted proof so Account Center can verify the advance after restart without persisting raw target/idempotency/baseline; nonterminal/non-success proofs must not claim the baseline. The provider retains the tuple/key binding, rollback backup, transaction journal, and terminal proof; recovery/status by capability must return the complete transaction-and-exact-tuple-bound authoritative proof without accepting caller target/idempotency. Define provider-clock prepared-commit expiry, post-expiry rollback/recovery finalization, and immutable terminal-proof retention/explicit expiry. Account Center persists only redacted opaque handle metadata—never raw/serialized/digested target or raw/digested idempotency. The capability must be fixture/sandbox testable without a production credential and must not reuse `models auth login --force`.

Until this feature and the acceptance evidence exist, Account Center has no supported deletion integration path.

## Bounded validation for this artifact

This document was produced from static inspection only. Validation must be documentation/repository validation only; do not run OpenClaw auth login, `--force`, probe, delete, apply, Sentinel, or credential-store commands. The recorded validation commands for this change are:

```bash
git diff --check
git diff --name-only -- . ':!/.account-center-pipeline/AC-06-INTEGRATION-DISCOVERY-BLOCKER-RESOLUTION.md'
python3 - <<'PY'
from pathlib import Path
import re
p = Path('.account-center-pipeline/AC-06-INTEGRATION-DISCOVERY-BLOCKER-RESOLUTION.md')
text = p.read_text(encoding='utf-8')
required = [
    '2026.7.1-2', 'models auth login --force', 'byte-compatible',
    'weekly-only', 'prepareDelete', 'commitDelete', 'rollbackDelete',
    'recoverCredentialDeletionStatus', 'discoverCredentialTarget',
    'getCredentialDeletionStatus', 'OpaqueReceiptHandle',
    'OpaqueRecoveryCapability', 'recoveryCapability: OpaqueRecoveryCapability;',
    'No live credential delete, provider apply, provider probe/test',
    '(providerId, profileId, agentScope, credentialGeneration)',
    'type CredentialTargetDiscoveryRequest = {',
    'type AuthoritativeCredentialTargetDiscovery = {',
    'discoverySnapshot: AuthoritativeCredentialTargetDiscovery;',
    'expectedStatusRevision must exactly equal `discoverySnapshot.statusRevision`',
    'same provider authority as `target.providerId`',
    'expiresAt is a provider-enforced short freshness deadline',
    'type CredentialDeletionStatusSelector = {',
    'All three fields are REQUIRED: transactionId and target are the paired-',
    'consistency binding, and minimumStatusRevision is separately required.',
    'type AuthoritativeCredentialDeletionStatusBase = {',
    'type NonterminalCredentialDeletionStatus =',
    'type TerminalNonSuccessCredentialDeletionProof =',
    'type TerminalDeletedCredentialDeletionProof =',
    'preCommitStatusRevision: string;',
    'preCommitStatusRevision?: never;',
    'journal the then-current decimal non-negative `statusRevision` as `preCommitStatusRevision`',
    'internally bind it to that same transaction and exact tuple',
    'Only an immutable terminal `deleted` proof carries `preCommitStatusRevision`',
    'statusRevision` must be numerically strictly greater than its same-transaction-and-tuple-bound `preCommitStatusRevision`',
    'After restart, Account Center makes that comparison from the recovery response itself',
    'proofFreshness: ProofFreshness;',
    'numerically monotonic for this exact tuple',
    'same transaction-and-tuple-bound fresh proof',
    'Account Center retention boundary',
    'must not persist raw target fields',
    'raw/digested idempotency',
    'Prepared expiry', 'terminal_proof_expired',
    'Normal status proof remains strict',
]
missing = [term for term in required if term not in text]
assert not missing, missing
contract = text.split('## Required provider capability contract', 1)[1].split(
    '## Filesystem and receipt boundary', 1
)[0]
for field in ('transactionId: string;', 'target: CredentialTarget;',
              'statusRevision: string;', 'minimumStatusRevision: string;'):
    assert text.count(field) >= 2, f'missing required binding field: {field}'
assert re.search(
    r'discoverCredentialTarget\(\s*request: CredentialTargetDiscoveryRequest\s*\)'
    r': Promise<AuthoritativeCredentialTargetDiscovery>', text
), 'authoritative target discovery method is required'
prepare = re.search(r'type PrepareDeleteRequest = \{(?P<body>.*?)\n\};', text, re.S)
assert prepare, 'PrepareDeleteRequest is required'
body = prepare.group('body')
for field in ('target: CredentialTarget;', 'expectedStatusRevision: string;',
              'discoverySnapshot: AuthoritativeCredentialTargetDiscovery;'):
    assert field in body, f'prepare lacks discovery/revision binding: {field}'
assert 'Before `prepareDelete`, Account Center must call `discoverCredentialTarget`' in text
assert 'PrepareDeleteRequest.target` must field-for-field equal `discoverySnapshot.target`' in text
assert not re.search(r'transactionId\?\s*:', text), 'optional status transactionId is forbidden'
assert not re.search(r'target\?\s*:', text), 'optional status target is forbidden'
assert re.search(
    r'getCredentialDeletionStatus\(\s*selector: CredentialDeletionStatusSelector', text
), 'status method must require the paired selector'
assert re.search(
    r'recoverCredentialDeletionStatus\(\s*recoveryCapability: OpaqueRecoveryCapability\s*\)'
    r': Promise<AuthoritativeCredentialDeletionStatus>', text
), 'recovery must accept only provider-owned opaque capability and return complete proof'
assert not re.search(r'recoverDelete\s*\(', text), 'legacy recovery with transaction/key is forbidden'
normal_status = re.search(
    r'getCredentialDeletionStatus\(\s*selector: CredentialDeletionStatusSelector\s*\)'
    r': Promise<AuthoritativeCredentialDeletionStatus>', text
)
assert normal_status, 'normal status must remain strict paired-selector status'
status_union = re.search(
    r'type AuthoritativeCredentialDeletionStatus\s*=(?P<definition>.*?);', contract, re.S
)
assert status_union, 'AuthoritativeCredentialDeletionStatus union is required'
union_definition = status_union.group('definition')
expected_status_arms = (
    'NonterminalCredentialDeletionStatus',
    'TerminalNonSuccessCredentialDeletionProof',
    'TerminalDeletedCredentialDeletionProof',
)
assert re.fullmatch(
    r'\s*\|\s*NonterminalCredentialDeletionStatus\s*'
    r'\|\s*TerminalNonSuccessCredentialDeletionProof\s*'
    r'\|\s*TerminalDeletedCredentialDeletionProof\s*',
    union_definition,
), 'status must be explicitly and exactly the three authoritative status arms'
assert tuple(re.findall(r'\|\s*([A-Za-z][A-Za-z0-9_]*)', union_definition)) == expected_status_arms, \
    'status union must include each authoritative status arm exactly once'

proof_bodies = {}
for typename in expected_status_arms:
    proof = re.search(rf'type {typename}\s*=\s*.*?\{{(?P<body>.*?)\n\}};', contract, re.S)
    assert proof, f'{typename} type declaration is required'
    proof_bodies[typename] = proof.group('body')

nonterminal_body = proof_bodies['NonterminalCredentialDeletionStatus']
non_success_body = proof_bodies['TerminalNonSuccessCredentialDeletionProof']
deleted_body = proof_bodies['TerminalDeletedCredentialDeletionProof']
for body, expected_state, expected_expiry, typename in (
    (nonterminal_body, 'null', 'null', 'NonterminalCredentialDeletionStatus'),
    (non_success_body, '"rolled_back" | "recovery_required"', 'string',
     'TerminalNonSuccessCredentialDeletionProof'),
    (deleted_body, '"deleted"', 'string',
     'TerminalDeletedCredentialDeletionProof'),
):
    states = re.findall(r'\bterminalState\s*:\s*([^;\n]+);', body)
    expiries = re.findall(r'\bterminalProofExpiresAt\s*:\s*([^;\n]+);', body)
    assert states == [expected_state], f'{typename} must declare only terminalState: {expected_state}'
    assert expiries == [expected_expiry], \
        f'{typename} must declare terminalProofExpiresAt: {expected_expiry}'

baseline_declarations = re.findall(
    r'\bpreCommitStatusRevision\s*(\?)?\s*:\s*([^;\n]+);', contract
)
assert baseline_declarations == [
    ('?', 'never'), ('?', 'never'), ('', 'string'),
], 'only nonterminal/non-success may forbid the baseline; only deleted may require it'
assert not re.search(r'\bpreCommitStatusRevision\s*\?', deleted_body), \
    'deleted proof baseline must be required, never optional'
assert not re.search(r'\bpreCommitStatusRevision\s*:', nonterminal_body), \
    'nonterminal proof must prohibit rather than require a deletion baseline'
assert not re.search(r'\bpreCommitStatusRevision\s*:', non_success_body), \
    'terminal non-success proof must prohibit rather than require a deletion baseline'
assert 'Account Center must not supply, alter, infer, or persist it.' in contract
assert 'Nonterminal and terminal non-success responses must not claim this deletion baseline.' in contract
assert 'malformed/non-monotonic/non-advancing revision' in contract
assert 'PreparedDelete = {\n  // Opaque provider transaction reference' in text
prepared = re.search(r'type PreparedDelete = \{(?P<body>.*?)\n\};', text, re.S)
assert prepared and 'target: CredentialTarget;' not in prepared.group('body'), \
    'prepare response must not make Account Center retain raw target'
assert 'idempotencyKey:' not in prepared.group('body'), \
    'prepare response must not make Account Center retain idempotency'
print('AC-06 R3 artifact static contract check: passed')
PY
```
