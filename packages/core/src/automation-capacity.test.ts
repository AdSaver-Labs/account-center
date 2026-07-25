import test from "node:test";
import assert from "node:assert/strict";
import { transitionAutomationCapacity } from "./automation-capacity.js";

test("capacity gate alerts once, stays silent while blocked, then alerts once on recovery", () => {
  const blocked = transitionAutomationCapacity("available", false);
  const unchanged = transitionAutomationCapacity(blocked.state, false);
  const recovered = transitionAutomationCapacity(unchanged.state, true);
  assert.deepEqual(blocked, { state: "unavailable", workers: "paused", notification: "capacity-unavailable" });
  assert.deepEqual(unchanged, { state: "unavailable", workers: "paused" });
  assert.deepEqual(recovered, { state: "available", workers: "running", notification: "capacity-recovered" });
});
