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
      'Run Account Center /auth commands for status, routing, account add/reauth/remove/use/delete, and recovery flows. Live mutations are allowed only through Account Center guardrails: exact targets, backups/receipts, and redacted output.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The /auth command to run, for example: /auth, /auth list, /auth auto, /auth delete nobody@example.invalid --dry-run.',
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
    .replace(/(access_token|refresh_token|id_token|api_key|agent_key)(["'\s:=]+)([^\s"']{4,})/gi, '$1$2[REDACTED]');
}

function normalizeCommand(raw) {
  const text = String(raw || '').trim();
  if (!text) return '/auth';
  if (text.startsWith('/auth')) return text;
  if (text.startsWith('auth ')) return `/${text}`;
  return `/auth ${text}`;
}

function isMutation(command) {
  return /^\/auth\s+(add|reauth|remove|delete|use|auto|ensure|disable|enable|model\s+(enable|disable)|models\s+(enable|disable))\b/i.test(command);
}

function isClearlyDryRun(command) {
  return /\s--dry-run\b/i.test(command);
}

function opaqueFailure() {
  return {
    isError: true,
    content: [{ type: 'text', text: OPAQUE_FAILURE_TEXT }],
  };
}

function runAuth(command) {
  const normalized = normalizeCommand(command);
  if (isMutation(normalized) && !isClearlyDryRun(normalized) && !ALLOW_MUTATIONS) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text:
            `Blocked potentially mutating Account Center command in Codex MCP: ${redact(normalized)}\n\n` +
            'For safety, this MCP bridge allows status/help and dry-runs by default. ' +
            'Ask Alej for an explicit target/approval and run through Telegram/Hermes/OpenClaw, or set ACCOUNT_CENTER_MCP_ALLOW_MUTATIONS=1 for a controlled test session.',
        },
      ],
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
    return opaqueFailure();
  }
  if (proc.error || proc.signal || proc.status !== 0) return opaqueFailure();
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

function handle(req) {
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
    if (name === 'account_center_status') respond(result(id, runAuth('/auth')));
    else if (name === 'account_center_help') respond(result(id, runAuth('/auth help')));
    else if (name === 'account_center_auth') respond(result(id, runAuth(args.command || '/auth')));
    else respond(error(id, -32602, `Unknown tool: ${name}`));
    return;
  }
  if (id !== undefined) respond(error(id, -32601, `Unknown method: ${method}`));
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const idx = buffer.indexOf(10);
    if (idx < 0) break;
    const line = buffer.slice(0, idx).toString('utf8').trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch (e) {
      respond(error(null, -32700, e instanceof Error ? e.message : String(e)));
    }
  }
});

process.stdin.on('end', () => process.exit(0));
