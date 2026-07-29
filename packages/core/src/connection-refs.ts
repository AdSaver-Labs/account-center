import { createHash } from "node:crypto";

/**
 * Maps a private adapter connection identity to a deterministic public handle.
 * The identity and its scope never leave the adapter boundary.
 */
export function opaqueConnectionRef(runtime: "hermes" | "openclaw", connectionId: string): string {
  return `connection-${createHash("sha256").update(`${runtime}\0${connectionId}`, "utf8").digest("hex").slice(0, 24)}`;
}
