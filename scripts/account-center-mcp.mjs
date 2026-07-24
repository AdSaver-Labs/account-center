#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';


const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CHATOPS = resolve(ROOT, 'scripts', 'chatops.mjs');
const ALLOW_MUTATIONS = process.env.ACCOUNT_CENTER_MCP_ALLOW_MUTATIONS === '1';
const DEFAULT_SOURCE = process.env.ACCOUNT_CENTER_SOURCE || 'openclaw';
const MAX_OUTPUT = 12000;
const OPAQUE_FAILURE_TEXT = 'Account Center request UNPROVEN.\n';
const DELETE_UNPROVEN_TEXT =
  'DRY RUN — no account was deleted and no live Sentinel/OpenClaw store was changed.\n' +
  'Action: account.delete\n' +
  'Target: redacted-target\n' +
  'Result: BLOCKED\n' +
  'Verification: UNPROVEN\n\n' +
  'Credential deletion is currently BLOCKED/UNPROVEN; no documented native transactional delete adapter is available.\n' +
  'Exact connected-target confirmation remains required before credential deletion.\n';
const INVALID_REQUEST_TEXT = 'Invalid Account Center MCP request.';
const MUTATION_BLOCKED_TEXT =
  'Blocked potentially mutating Account Center command in Codex MCP.\n\n' +
  'For safety, this MCP bridge allows status/help and dry-runs by default. ' +
  'Ask Alej for an explicit target/approval and run through Telegram/Hermes/OpenClaw, or set ACCOUNT_CENTER_MCP_ALLOW_MUTATIONS=1 for a controlled test session.';

if (!existsSync(CHATOPS)) {
  console.error(`Account Center chatops wrapper not found: ${CHATOPS}`);
  process.exit(1);
}

let nextId = 1;
const pending = new Map();
let buffer = Buffer.alloc(0);

const serverInfo = {
  name: 'account-center',
  version: '0.1.0',
};

const tools = [
  {
    name: 'account_center_auth',
    description:
      'Run Account Center /auth commands for status, routing, account add/reauth/remove/use/delete, and recovery flows. All paths use the canonical account contract. Credential delete fails closed unless a documented native transaction provides exact targeting, backup/rollback, redacted receipt, and fresh proof.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The /auth command to run, for example: /auth, /auth list, or /auth auto --dry-run.',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'account_center_status',
    description: 'Show Account Center Codex/OpenClaw account status, active route, and provider limits. Equivalent to /auth.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'account_center_help',
    description: 'Show Account Center /auth command help and safety notes.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
];

function redact(text) {
  return String(text || '')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[REDACTED_EMAIL]')
    .replace(/rt\.1\.[A-Za-z0-9._~+/=-]{12,}/g, '[REDACTED]')
    .replace(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{12,}/g, '[REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, '[REDACTED]')
    .replace(/(?:gh[pousr]_|xox[baprs]-)[A-Za-z0-9_-]{16,}/gi, '[REDACTED]')
    .replace(/\/(?:[A-Za-z0-9._-]+\/){1,}[A-Za-z0-9._-]+/g, '[REDACTED_PATH]')
    .replace(/(access_token|refresh_token|id_token|api_key|agent_key|authorization|oauth[_-]?code)(["'\s:=]+)([^\s"']{4,})/gi, '$1$2[REDACTED]')
    .replace(/\b(target|receipt[_-]?target|account|profile|identity|runtime[_-]?command|command|path)(["'\s:=]+)([^\s"',;]{3,})/gi, '$1$2[REDACTED]');
}

function normalizeCommand(raw) {
  const text = String(raw || '').trim();
  if (!text) return '/auth';
  if (text.startsWith('/auth')) return text;
  if (text.startsWith('auth ')) return `/${text}`;
  return `/auth ${text}`;
}

function opaqueFailure(deleteRequest = false) {
  return {
    isError: true,
    content: [{ type: 'text', text: deleteRequest ? DELETE_UNPROVEN_TEXT : OPAQUE_FAILURE_TEXT }],
  };
}

async function runAuth(command) {
  const normalized = normalizeCommand(command);
  const deleteRequest = /^\/auth\s+delete(?:\s|$)/i.test(normalized);
  let inspection;
  try {
    // The MCP transport must be able to initialize from a clean checkout,
    // before TypeScript output exists. The canonical parser is needed only
    // for an auth invocation, so defer this ignored build-artifact import.
    const { inspectAuthCommand } = await import('../packages/cli/dist/auth-bridge.js');
    inspection = inspectAuthCommand(normalized);
  } catch {
    return {
      isError: true,
      content: [{ type: 'text', text: MUTATION_BLOCKED_TEXT }],
    };
  }
  if (inspection.mutationCapable && !inspection.explicitlyDryRun && !ALLOW_MUTATIONS) {
    return {
      isError: true,
      content: [{ type: 'text', text: MUTATION_BLOCKED_TEXT }],
    };
  }
  let proc;
  try {
    proc = spawnSync(process.execPath, [CHATOPS, normalized], {
      cwd: ROOT,
      env: {
        ...process.env,
        ACCOUNT_CENTER_SOURCE: DEFAULT_SOURCE,
      },
      encoding: 'utf8',
      timeout: Number(process.env.ACCOUNT_CENTER_MCP_TIMEOUT || 45000),
      maxBuffer: 1024 * 1024,
    });
  } catch {
    return opaqueFailure(deleteRequest);
  }
  // account.delete is already a fixed, target-free public contract rendered by
  // the CLI. Passing it through unchanged keeps CLI/Hermes/MCP byte-for-byte
  // aligned instead of letting transport-specific generic redaction rewrite it.
  if (deleteRequest) {
    const text = proc.stdout === DELETE_UNPROVEN_TEXT ? proc.stdout : DELETE_UNPROVEN_TEXT;
    return { isError: Boolean(proc.error || proc.signal || proc.status !== 0), content: [{ type: 'text', text }] };
  }
  if (proc.error || proc.signal || proc.status !== 0) return opaqueFailure(false);
  const text = redact(proc.stdout || 'Account Center returned no output.').slice(0, MAX_OUTPUT);
  return {
    isError: false,
    content: [{ type: 'text', text }],
  };
}

function result(id, value) {
  return { jsonrpc: '2.0', id, result: value };
}

function error(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function respond(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handle(req) {
  const { id, method, params } = req;
  if (method === 'initialize') {
    respond(result(id, {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo,
    }));
    return;
  }
  if (method === 'notifications/initialized') return;
  if (method === 'tools/list') {
    respond(result(id, { tools }));
    return;
  }
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};
    if (name === 'account_center_status') respond(result(id, await runAuth('/auth')));
    else if (name === 'account_center_help') respond(result(id, await runAuth('/auth help')));
    else if (name === 'account_center_auth') respond(result(id, await runAuth(args.command || '/auth')));
    else respond(error(id, -32602, INVALID_REQUEST_TEXT));
    return;
  }
  if (id !== undefined) respond(error(id, -32601, INVALID_REQUEST_TEXT));
}

let inputQueue = Promise.resolve();

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  inputQueue = inputQueue.then(async () => {
    while (true) {
      const idx = buffer.indexOf(10);
      if (idx < 0) break;
      const line = buffer.slice(0, idx).toString('utf8').trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        await handle(JSON.parse(line));
      } catch {
        respond(error(null, -32700, INVALID_REQUEST_TEXT));
      }
    }
  });
});

process.stdin.on('end', () => {
  inputQueue.then(() => process.exit(0));
});
