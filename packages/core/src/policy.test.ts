import test from "node:test";
import assert from "node:assert/strict";
import { loadFixtureStatus } from "./fixtures.js";
import { evaluateProfile, guardStatus, nextEligible } from "./policy.js";

test("nextEligible skips exhausted primary and protected backup", async () => {
  const status = await loadFixtureStatus();
  const next = nextEligible(status, "openai", "openclaw");
  assert.equal(next?.profile.id, "openai:helper-2");
});

test("nextEligible fails closed without an exact provider runtime route", async () => {
  const status = await loadFixtureStatus();
  assert.equal(nextEligible(status, "openai", "hermes"), undefined);
  assert.equal(nextEligible({ ...status, routes: [] }, "openai", "openclaw"), undefined);
});

test("guardStatus returns usable account details", async () => {
  const status = await loadFixtureStatus();
  assert.deepEqual(guardStatus(status, "openai", "openclaw"), {
    ok: true,
    reason: "usable_account_found",
    next: "openai:helper-2"
  });
});

test("backup account is blocked while normal account is available", async () => {
  const status = await loadFixtureStatus();
  const backup = status.profiles.find((profile) => profile.id === "openai:business-backup");
  assert.ok(backup);
  const result = evaluateProfile(status, backup, status.routes[0]);
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes("backup_protected"));
});
