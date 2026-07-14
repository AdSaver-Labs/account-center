export type ModelCapabilityStatus = "supported" | "unsupported_by_runtime" | "not_in_catalog" | "unknown";

export interface ModelCapability {
  id: string;
  label: string;
  selectable: boolean;
  reason?: string;
}

export type ModelSelectionResult =
  | { ok: true; status: "supported"; model: string }
  | { ok: false; status: Exclude<ModelCapabilityStatus, "supported">; model: string; reason?: string };

export function evaluateModelSelection(catalog: ModelCapability[], requestedModel: string): ModelSelectionResult {
  const model = requestedModel.trim();
  const capability = catalog.find((item) => item.id === model);
  if (!capability) return { ok: false, status: "not_in_catalog", model };
  if (!capability.selectable) return { ok: false, status: "unsupported_by_runtime", model, ...(capability.reason ? { reason: capability.reason } : {}) };
  return { ok: true, status: "supported", model };
}
