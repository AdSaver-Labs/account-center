# Security

## Prime directive

Account Center must never leak raw OAuth tokens, refresh tokens, API keys, browser cookies, session blobs, or provider secrets into chat, logs, docs, status exports, GitHub issues, or telemetry.

## Threat model

Risks:

- accidental token printing in chat/status output;
- copying credentials between incompatible runtimes;
- destructive account deletion when user intended remove-from-routing;
- malicious prompt/file content requesting exfiltration;
- hosted dashboard exposing local accounts;
- provider namespace confusion routing to the wrong account;
- backup/last-resort account used silently.

## Required controls

- Secret redaction at logging boundary.
- No raw secret fields in core DB unless encrypted and explicitly designed.
- Adapter-owned secret access.
- Dry-run default for mutating CLI/API calls.
- Confirmation required for backup-only accounts.
- Audit event for every mutation.
- Backups before editing runtime auth order/config.
- Separate status handles from credentials.

## Chat safety

Chat responses may include:

- provider/profile labels;
- usage percentages;
- OAuth device URL/code when intentionally starting reauth;
- event receipt IDs.

Chat responses must not include:

- OAuth access/refresh tokens;
- API keys;
- full browser session/cookie blobs;
- raw sqlite auth rows;
- unredacted provider auth JSON.

## Open-source safety

This repo should include only generic code, sample configs, and redacted examples. Private VPS scripts can inform design but must be generalized before publication.
