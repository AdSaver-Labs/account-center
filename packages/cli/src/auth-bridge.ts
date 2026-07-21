const MANUAL_COMMAND = "/auth";

interface AuthToken {
  value: string;
  quoted: boolean;
  escaped: boolean;
}

export interface AuthCommandInspection {
  invocation: string[];
  mutationCapable: boolean;
  explicitlyDryRun: boolean;
}

export function parseAuthCommand(input: string | string[]): string[] {
  const tokens = Array.isArray(input) ? input : tokenizeAuthCommand(input);
  const [prefix, verb, ...rest] = tokens;
  if (!prefix || prefix === "help") return ["help"];
  if (prefix === "/oauth") throw new Error("Manual command is /auth, not /oauth.");
  if (prefix !== MANUAL_COMMAND) throw new Error("Manual command is /auth.");
  if (!verb) return ["status"];
  if (verb === "help") return ["help"];

  switch (verb) {
    case "status":
    case "list":
      return ["status", ...rest];
    case "guard":
      return ["guard", ...rest];
    case "ensure":
      return ["guard", "--ensure-route", ...rest];
    case "doctor":
      return ["doctor", ...rest];
    case "probes":
    case "probe":
      return ["providers", "probe", ...rest];
    case "accounts":
    case "list":
      return ["accounts", "list", ...rest];
    case "next":
      return ["routes", "next", ...rest];
    case "auto":
      return ["routes", "auto", ...withApplyByDefault(rest)];
    case "add":
      return ["reauth", "start", ...withModeAndApplyByDefault(rest, "add")];
    case "reauth":
      return ["reauth", "start", ...withModeAndApplyByDefault(rest, "reauth")];
    case "use":
      return ["routes", "use", ...withApplyByDefault(rest)];
    case "remove":
      // Route removal has a public preview-first lifecycle.  An explicit
      // --apply still needs the exact review token, idempotency key, and one
      // observed agent scope in the shared executor.
      return ["routes", "remove", ...withPreviewByDefault(rest)];
    case "delete":
      return ["accounts", "delete", ...withApplyByDefault(rest)];
    case "disable":
      return ["accounts", "disable", ...rest];
    case "enable":
      return ["accounts", "enable", ...rest];
    case "model":
    case "models":
      return mapModelCommand(rest);
    case "audit":
      return ["audit", "list", ...rest.filter((item) => item !== "list")];
    default:
      if (verb.includes("@") || verb.includes(":")) return ["routes", "use", verb, ...rest];
      throw new Error(`Unknown /auth command: ${verb}. Run /auth help.`);
  }
}

/**
 * Tokenize manual chat input exactly once before it is passed into the CLI.
 * Quoting is supported for operands; callers that grant elevated capability
 * must use inspectAuthCommand so quotes/escapes cannot authorize a flag.
 */
export function tokenizeAuthCommand(input: string): string[] {
  return tokenizeWithMetadata(input).map((token) => token.value);
}

/**
 * Resolve the manual command to the same argv the CLI will invoke, then
 * classify every mapped mutation path. This is the capability boundary used
 * by the MCP bridge before it forwards anything to ChatOps.
 */
export function inspectAuthCommand(input: string): AuthCommandInspection {
  const tokens = tokenizeWithMetadata(input);
  const invocation = parseAuthCommand(tokens.map((token) => token.value));
  const mutationCapable = isMutationInvocation(invocation);
  const explicitlyDryRun = tokens.some((token) =>
    token.value === "--dry-run" && !token.quoted && !token.escaped
  ) && invocation.includes("--dry-run") && !invocation.includes("--apply");
  return { invocation, mutationCapable, explicitlyDryRun };
}

export function renderAuthHelp(): string {
  return `/auth commands
  /auth status [--source fixture|openclaw|generic-command] [--json]
  /auth guard [--provider openai] [--runtime openclaw] [--json]
  /auth ensure [--source openclaw|generic-command] [--apply]
  /auth probe [--provider openai|all] [--json]
  /auth accounts
  /auth next
  /auth auto [--dry-run]
  /auth use <profile> [--dry-run]
  /auth remove <profile> [--dry-run]
  /auth delete <email-or-profile> -- BLOCKED/UNPROVEN until a documented native transactional delete adapter exists
  /auth delete <email-or-profile> --dry-run -- preview only; no deletion (live delete remains blocked/UNPROVEN)
  /auth disable <profile> [--apply]
  /auth enable <profile> [--apply]
  /auth models
  /auth model disable <provider/model> [--apply]
  /auth model enable <provider/model> [--apply]
  /auth doctor [--source openclaw]
  /auth audit [--limit 20]

Manual /auth commands use recovery/operator defaults: /auth auto and /auth use <target> request live apply when valid; add --dry-run to preview. /auth remove <target> always starts with a routing-only preview, then requires an exact review confirmation, idempotency key, and one explicit agent scope for apply. Delete is credential deletion, but live delete is currently BLOCKED/UNPROVEN and fails closed without a store change. A documented native transactional delete adapter must provide an exact connected target match, owner-only runtime-local backup, native atomic rollback, durable redacted receipt, and fresh authoritative verification before live delete can be enabled. Remove never deletes credentials. Other mutation-shaped lower-level commands remain dry-run unless --apply is explicit and supported.
`;
}

function withApplyByDefault(rest: string[]): string[] {
  if (rest.includes("--apply") || rest.includes("--dry-run")) return rest;
  return [...rest, "--apply"];
}

function withPreviewByDefault(rest: string[]): string[] {
  return rest.includes("--apply") || rest.includes("--dry-run") ? rest : [...rest, "--dry-run"];
}

function withModeAndApplyByDefault(rest: string[], mode: "add" | "reauth"): string[] {
  const explicitModes: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value.startsWith("--mode=")) throw new Error("Guided-auth mode must use --mode add or --mode reauth.");
    if (value !== "--mode") continue;
    const explicitMode = rest[index + 1];
    if (!explicitMode || explicitMode.startsWith("-")) throw new Error("Guided-auth mode must use --mode add or --mode reauth.");
    explicitModes.push(explicitMode);
  }
  if (explicitModes.length > 1 || explicitModes[0] !== undefined && explicitModes[0] !== mode) throw new Error("Guided-auth mode must match the /auth command.");
  const withMode = explicitModes.length ? rest : [...rest, "--mode", mode];
  return withApplyByDefault(withMode);
}

function mapModelCommand(rest: string[]): string[] {
  const [subcommand, ...tail] = rest;
  if (!subcommand || subcommand === "list") return ["models", "list", ...tail];
  if (subcommand === "disable" || subcommand === "enable") return ["models", subcommand, ...tail];
  throw new Error(`Unknown /auth model command: ${subcommand}. Run /auth help.`);
}

function isMutationInvocation(invocation: string[]): boolean {
  const [command, subcommand] = invocation;
  return (command === "guard" && invocation.includes("--ensure-route")) ||
    (command === "routes" && ["auto", "use", "remove"].includes(subcommand ?? "")) ||
    (command === "accounts" && ["disable", "enable", "delete"].includes(subcommand ?? "")) ||
    (command === "models" && ["disable", "enable"].includes(subcommand ?? "")) ||
    (command === "reauth" && subcommand === "start");
}

function tokenizeWithMetadata(input: string): AuthToken[] {
  const tokens: AuthToken[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaping = false;
  let quoted = false;
  let escaped = false;

  const push = () => {
    if (!current) return;
    tokens.push({ value: current, quoted, escaped });
    current = "";
    quoted = false;
    escaped = false;
  };

  for (const char of input.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      escaped = true;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else {
        current += char;
        quoted = true;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      quoted = true;
      continue;
    }
    if (/\s/.test(char)) {
      push();
      continue;
    }
    current += char;
  }
  if (quote) throw new Error("Unterminated quote in /auth command.");
  if (escaping) {
    current += "\\";
    escaped = true;
  }
  push();
  return tokens;
}
