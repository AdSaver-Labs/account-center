import test from "node:test";
import assert from "node:assert/strict";
import { evaluateModelSelection } from "./model-selection.js";

const catalog = [
  { id: "openai/gpt-5.6-terra", label: "GPT-5.6 Terra", selectable: true },
  { id: "openai/gpt-5.6-sol", label: "GPT-5.6 Sol", selectable: false, reason: "unsupported_by_runtime" }
];

test("model selection allows a cataloged selectable model", () => {
  const result = evaluateModelSelection(catalog, "openai/gpt-5.6-terra");
  assert.deepEqual(result, { ok: true, status: "supported", model: "openai/gpt-5.6-terra" });
});

test("model selection refuses models the runtime reports unsupported", () => {
  const result = evaluateModelSelection(catalog, "openai/gpt-5.6-sol");
  assert.equal(result.ok, false);
  assert.equal(result.status, "unsupported_by_runtime");
});

test("model selection reports models absent from the catalog", () => {
  const result = evaluateModelSelection(catalog, "openai/not-real");
  assert.equal(result.ok, false);
  assert.equal(result.status, "not_in_catalog");
});
