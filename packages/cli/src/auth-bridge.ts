const MANUAL_COMMAND = "/auth";

export function parseAuthCommand(input: string | string[]): string[] {
  const tokens = Array.isArray(input) ? input : tokenize(input);
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
      return ["routes", "auto", ...rest];
    case "add":
    case "reauth":
      return ["reauth", "start", ...rest];
    case "use":
      return ["routes", "use", ...rest];
    case "remove":
      return ["routes", "remove", ...rest];
    case "delete":
      return ["accounts", "delete", ...rest];
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

export function renderAuthHelp(): string {
  return `/auth commands
  /auth status [--source fixture|openclaw|generic-command] [--json]
  /auth guard [--provider openai] [--runtime openclaw] [--json]
  /auth ensure [--source openclaw|generic-command] [--apply]
  /auth probe [--provider openai|all] [--json]
  /auth accounts
  /auth next
  /auth auto [--apply]
  /auth use <profile> [--apply]
  /auth remove <profile> [--apply]
  /auth delete <email-or-profile> [--apply] -- fully delete credentials from Sentinel/OpenClaw auth store after backup
  /auth disable <profile> [--apply]
  /auth enable <profile> [--apply]
  /auth models
  /auth model disable <provider/model> [--apply]
  /auth model enable <provider/model> [--apply]
  /auth doctor [--source openclaw]
  /auth audit [--limit 20]

Defaults are safe: fixture source unless --source openclaw is explicit, and mutation-shaped commands are dry-run unless --apply is explicit and supported.
`;
}

function mapModelCommand(rest: string[]): string[] {
  const [subcommand, ...tail] = rest;
  if (!subcommand || subcommand === "list") return ["models", "list", ...tail];
  if (subcommand === "disable" || subcommand === "enable") return ["models", subcommand, ...tail];
  throw new Error(`Unknown /auth model command: ${subcommand}. Run /auth help.`);
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaping = false;
  for (const char of input.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (quote) throw new Error("Unterminated quote in /auth command.");
  if (escaping) current += "\\";
  if (current) tokens.push(current);
  return tokens;
}
