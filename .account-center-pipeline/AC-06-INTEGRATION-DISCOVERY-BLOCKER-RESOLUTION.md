# AC-06 Integration Discovery Blocker Resolution

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
  // Both fields are REQUIRED as a paired-consistency selector, never optional.
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

type AuthoritativeCredentialDeletionStatus = {
  // Echoes the required selector. Both must exactly equal the prepared tuple/transaction.
  transactionId: string;
  target: CredentialTarget;
  // Decimal, non-negative provider revision, numerically monotonic for this exact tuple.
  // A later authoritative mutation/proof for the tuple has a strictly greater revision.
  statusRevision: string;
  // The only terminal-state discriminant. null means non-terminal/in-progress.
  terminalState: "deleted" | "rolled_back" | "recovery_required" | null;
  proofFreshness: ProofFreshness;
  receiptHandle: OpaqueReceiptHandle;
};

type PrepareDeleteRequest = {
  // All three values are copied verbatim from one unexpired discovery response.
  target: CredentialTarget;
  idempotencyKey: string;
  expectedStatusRevision: string;
  discoverySnapshot: AuthoritativeCredentialTargetDiscovery;
};

type PreparedDelete = {
  transactionId: string;
  target: CredentialTarget;
  expiresAt: string;
  receiptHandle: OpaqueReceiptHandle;
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
  recoverDelete(transactionId: string, idempotencyKey: string): Promise<{
    transactionId: string;
    receiptHandle: OpaqueReceiptHandle;
    state: "prepared" | "committed" | "rolled_back" | "recovery_required";
  }>;
  getCredentialDeletionStatus(
    selector: CredentialDeletionStatusSelector
  ): Promise<AuthoritativeCredentialDeletionStatus>;
}
```

`discoverCredentialTarget` is the required authoritative pre-prepare read, not a broad list, cache, export, status rendering, or transaction-status substitute. For one exact provider/profile/agent locator, the provider authorizes and resolves one direct saved profile atomically and returns **only** the complete canonical `CredentialTarget`, its numeric monotonic `statusRevision`, and the provider-clock freshness bounds above; it returns no credential material, tokens, cookies, emails, paths, backup references, credential metadata, or alternate targets. Ambiguous, inherited, cross-agent, cross-provider, absent, or non-canonical locators fail without a snapshot or mutation. The response is provider-authoritative only when it comes directly from the same provider namespace named by `target.providerId`; Account Center must not construct, merge, cache-substitute, or obtain this snapshot from Sentinel or another provider.

Before `prepareDelete`, Account Center must call `discoverCredentialTarget` and retain that one response as the pre-prepare snapshot. `PrepareDeleteRequest.target` must field-for-field equal `discoverySnapshot.target`, and `expectedStatusRevision` must exactly equal `discoverySnapshot.statusRevision`; the provider rejects every mismatch. It also rejects a snapshot unless it issued that exact tuple/revision, the request is handled by the same provider authority as `target.providerId`, and provider clock is within `observedAt`/`expiresAt` at prepare. `expiresAt` is a provider-enforced short freshness deadline, never caller-extended; an expired, replayed, stale, non-monotonic, cross-provider, or otherwise unverifiable discovery snapshot fails before a transaction, backup, or store change. The provider must compare `expectedStatusRevision` numerically with the then-current revision and reject any change. Thus a prepare can be authorized only by a fresh, same-provider discovery read and never by a pre-existing transaction status (which does not exist until after prepare).

`getCredentialDeletionStatus` has no transaction-only, target-only, default-target, or broad-list form. Its selector is valid only when **both** required values are supplied and they are pairwise consistent: `transactionId` must identify one transaction originally prepared for precisely the supplied full `CredentialTarget`; the supplied tuple must exactly equal that transaction's recorded tuple. Otherwise the provider rejects the request and returns no status proof. `minimumStatusRevision` is required and must be the numeric revision obtained before commit (or the most recently returned authoritative revision during recovery); a response is valid only if its numeric `statusRevision >= minimumStatusRevision`. Account Center must reject a response unless its `transactionId` and every `target` field exactly echo the selector.

Required semantics:

- **Discover then prepare:** discovery is the only authoritative source of the exact target/revision before a transaction exists. Prepare validates the fresh, same-provider discovery snapshot and its exact live target/revision, takes a provider-owned rollback-capable backup before any store change, reserves one transaction bound permanently to that exact tuple, and returns an opaque receipt handle. It changes neither routing nor credential availability.
- **Commit:** is idempotent only for the supplied `transactionId` and its original idempotency key, affects only that transaction's prepared tuple, is atomic from the provider's perspective, and returns only a redacted/opaque handle. It must never expand to all profiles for a provider or initiate login. A commit reply alone is not deletion success.
- **Rollback:** is idempotent only for the supplied transaction/key and restores only the provider-owned prepared backup for that transaction's exact tuple. It must be available until terminal proof is retained under provider policy.
- **Recover:** is required after transport failure, timeout, restart, or uncertain outcome and is called only with the original transaction/key. It reports a terminal state or `recovery_required`; it must not guess, bind to another tuple, or repeat a destructive write.
- **Status proof:** `AuthoritativeCredentialDeletionStatus` is the sole proof object. It must be returned from a direct provider read after commit/recovery, carry the exact selector's transaction and full tuple, and carry `proofFreshness.authoritativeRead === true`. Its `statusRevision` is numerically monotonic for that exact tuple, and the provider must not satisfy a `minimumStatusRevision` from a cache, export, or pre-commit observation. `terminalState === "deleted"` means that exact tuple is authoritatively absent/deleted at `observedAt`; it must distinguish that result from a merely reordered, hidden, unreadable, inherited, replaced-generation, or provider-wide-cleared profile. `"rolled_back"` and `"recovery_required"` are terminal non-success outcomes; `null` is not terminal and is never success. An old cached Sentinel export, exit status, and generic provider health are not proof.

Account Center may expose deletion success only when (1) its `commitDelete` reply echoes the original transaction, (2) it obtains a subsequent `getCredentialDeletionStatus` using that same transaction and complete exact tuple, (3) the returned proof echoes both exactly, (4) `proofFreshness.authoritativeRead` and `satisfiesMinimumStatusRevision` are true, (5) the numeric `statusRevision` is strictly greater than the pre-commit revision, and (6) `terminalState === "deleted"`. Any missing/expired receipt, stale/non-monotonic revision, tuple or transaction mismatch, non-terminal/ambiguous result, `rolled_back`, `recovery_required`, transport uncertainty, or inability to obtain fresh proof is `UNPROVEN`; it stops automation and preserves the opaque transaction/receipt handle for operator escalation. Recovery may clear `UNPROVEN` only by returning the same transaction-and-tuple-bound fresh proof with terminal state `deleted`; it must otherwise remain `UNPROVEN`/`recovery_required` and must not start a new delete transaction automatically.

## Filesystem and receipt boundary

| Owner | May own | Must not expose or do |
|---|---|---|
| Provider/OpenClaw | Credential store, exact-profile mutation, provider-owned encrypted/private backup, transaction journal, restoration, authoritative proof data | Must not delegate credential backup/restore to Account Center or disclose backup paths/contents/credentials. |
| Account Center | Its existing process-private receipt directory and minimal redacted metadata: operation class, outcome, timestamp, opaque transaction/receipt handle, and proof state | Must not copy credentials, backups, raw target identity, filesystem paths, or provider store snapshots; must not represent its local receipt as provider deletion proof. |
| Sentinel | Read-only detailed status compatibility surface | Must not be edited, used as a transaction journal, or treated as authoritative fresh deletion proof. |

The provider receipt handle is opaque and stable enough to reconcile a transaction. Account Center may store a redacted correlation reference derived from it only in its process-private receipt metadata. It must not transform that metadata into a backup, a recovery mechanism, or evidence stronger than the provider status proof.

## Acceptance criteria for enablement

Enablement is eligible for review only when all items are demonstrated with non-production fixture/sandbox evidence supplied by the provider capability owner:

1. A public, versioned OpenClaw/provider document specifies `discoverCredentialTarget` plus an exact-profile delete interface rather than `login --force`.
2. The discovery read returns only a complete exact provider-issued target tuple and numeric monotonic status revision, with provider-enforced freshness bounds and no credential material; it rejects ambiguous, wrong-agent, inherited, and provider-wide locators without mutation.
3. Prepare is demonstrably bound to one unexpired same-provider discovery snapshot: its tuple and expected revision are copied exactly, stale/replayed/cross-provider snapshots and revision changes fail before a transaction or store change.
4. Prepare creates a provider-owned rollback-capable backup before change and exposes neither backup content nor location.
5. Commit, rollback, and recover are idempotent, transaction-bound, and cannot affect another profile, provider, or agent.
6. The provider returns an opaque redacted receipt handle and Account Center can record only permitted process-private redacted metadata.
7. Fresh authoritative status proof is revisioned and proves the exact selected profile is deleted after commit; it distinguishes the stated false positives.
8. Failure, timeout, crash/restart, and uncertain-state cases converge through recover/status to a terminal state or explicit `recovery_required`, never a guessed success.
9. Compatibility tests prove byte-identical normal `/auth status` output, preserve detailed Sentinel output, and preserve Hermes/Dexter weekly-only policy.
10. An independent security/spec review confirms no direct store edit, undocumented internal, live credential, live Sentinel mutation, or live deletion test was used.

## Rejection evidence / fail-closed conditions

Reject the integration and keep delete `BLOCKED`/`UNPROVEN` if any of the following is the only available behavior or evidence:

- `models auth login --force`, re-login, auth-order manipulation, a browser/UI workflow, agent deletion, or provider-wide profile clearing is offered instead of exact-profile deletion.
- The target is an email, display label, filename, loose profile string, or default agent inference rather than the full provider-issued identity tuple.
- Backup/rollback is absent, caller-owned, path-based, non-atomic, undocumented, or cannot be recovered after an interrupted request.
- A receipt contains secret material or a raw provider filesystem path, is not opaque/redacted, or is only an Account Center local receipt.
- Proof is based on an exit code, stale status export, generic health, changed auth ordering, disappearance from one listing, cached snapshot, or a live probe without an authoritative exact-target status revision.
- Any validation needs a production credential, live delete/apply, re-login, Sentinel mutation, or modification of the existing AC-06 receipt helper.
- Normal `/auth status` bytes, detailed Sentinel output, or Hermes/Dexter weekly-only policy change as a side effect.

## Smallest external capability request

Request one narrow provider feature, not a general credential-store API:

> **OpenClaw Provider Credential Deletion Transaction v1:** for one exact provider-issued profile identity in one configured agent store, expose documented `discoverCredentialTarget`, `prepareDelete`, `commitDelete`, `rollbackDelete`, `recoverDelete`, and revisioned `getCredentialDeletionStatus`. Discovery must be a same-provider authoritative read that returns only the complete exact `CredentialTarget`, a numeric monotonic status revision, and provider-enforced short freshness bounds; prepare must bind verbatim to that unexpired snapshot/revision. The provider retains the rollback backup and transaction journal; every response is secret-free and returns only opaque transaction/receipt handles plus authoritative proof state. The capability must be fixture/sandbox testable without a production credential and must not reuse `models auth login --force`.

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
    'recoverDelete', 'discoverCredentialTarget', 'getCredentialDeletionStatus',
    'OpaqueReceiptHandle',
    'No live credential delete, provider apply, provider probe/test',
    '(providerId, profileId, agentScope, credentialGeneration)',
    'type CredentialTargetDiscoveryRequest = {',
    'type AuthoritativeCredentialTargetDiscovery = {',
    'discoverySnapshot: AuthoritativeCredentialTargetDiscovery;',
    'expectedStatusRevision must exactly equal `discoverySnapshot.statusRevision`',
    'same provider authority as `target.providerId`',
    'expiresAt is a provider-enforced short freshness deadline',
    'type CredentialDeletionStatusSelector = {',
    'Both fields are REQUIRED as a paired-consistency selector, never optional.',
    'type AuthoritativeCredentialDeletionStatus = {',
    'terminalState: "deleted" | "rolled_back" | "recovery_required" | null;',
    'proofFreshness: ProofFreshness;',
    'numerically monotonic for this exact tuple',
    'same transaction-and-tuple-bound fresh proof',
]
missing = [term for term in required if term not in text]
assert not missing, missing
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
print('AC-06 artifact static contract check: passed')
PY
```
