import test from "node:test";
import assert from "node:assert/strict";
import { assertAccountCenterStatus } from "./schemas.js";

const validStatus = {
  schemaVersion: "account-center.status.v1",
  generatedAt: "2026-01-01T00:00:00.000Z",
  noSecrets: true,
  source: "fixture",
  providers: [], runtimes: [], profiles: [], routes: [], policy: {}, leases: [], reauth: [], audit: [], warnings: []
};

test("status validation rejects an unrecognized runtime source", () => {
  assert.throws(() => assertAccountCenterStatus({ ...validStatus, source: "untrusted" }), /unsupported status source/);
});

test("status validation accepts the declared source values", () => {
  for (const source of ["fixture", "file-store", "openclaw", "generic-command"]) {
    assert.doesNotThrow(() => assertAccountCenterStatus({ ...validStatus, source }));
  }
});
