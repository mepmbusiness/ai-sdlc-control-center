// Adapters for the local AI CLIs. Every flag used here was checked against the
// installed CLI's --help (claude 2.1.x, codex-cli 0.159.x). No API keys: each
// CLI runs on the user's own subscription login.

import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type { Cli } from './engine.ts';

const run = promisify(execFile);

export const BINARIES: Record<Cli, string> = {
  claude: process.env.AISDLC_CLAUDE_BIN || 'claude',
  codex: process.env.AISDLC_CODEX_BIN || 'codex',
};

// Variables that would switch a CLI from the subscription to paid API billing,
// or make Claude Code refuse to start as a nested session.
const STRIPPED_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CLAUDECODE',
  // Set when the Control Center itself runs under `node --test`; inherited, it
  // makes the product's own `node --test` report as a subtest and exit 0.
  'NODE_TEST_CONTEXT',
];

export function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of STRIPPED_ENV) delete env[key];
  return env;
}

export function strippedKeysPresent(): string[] {
  return STRIPPED_ENV.filter((k) => !['CLAUDECODE', 'NODE_TEST_CONTEXT'].includes(k) && process.env[k]);
}

// ---------- availability and login ----------

export interface CliStatus {
  cli: Cli;
  installed: boolean;
  version: string | null;
  loggedIn: boolean;
  subscription: boolean;
  detail: string;
}

let cache: { at: number; value: Record<Cli, CliStatus> } | null = null;
const CACHE_MS = Number(process.env.AISDLC_CLI_CACHE_MS ?? 60_000);

async function probe(cli: Cli): Promise<CliStatus> {
  const bin = BINARIES[cli];
  const status: CliStatus = { cli, installed: false, version: null, loggedIn: false, subscription: false, detail: '' };
  try {
    const { stdout } = await run(bin, ['--version'], { env: childEnv(), timeout: 15000 });
    status.installed = true;
    status.version = stdout.trim().split('\n')[0];
  } catch {
    status.detail = `"${bin}" was not found on PATH.`;
    return status;
  }
  try {
    if (cli === 'claude') {
      const { stdout } = await run(bin, ['auth', 'status'], { env: childEnv(), timeout: 15000 });
      const auth = JSON.parse(stdout);
      status.loggedIn = auth.loggedIn === true;
      status.subscription = auth.authMethod === 'claude.ai';
      status.detail = status.loggedIn ? `Signed in (${auth.authMethod})` : 'Not signed in. Run `claude` and log in.';
    } else {
      // `codex login status` prints to stderr on some versions; read both.
      const { stdout, stderr } = await run(bin, ['login', 'status'], { env: childEnv(), timeout: 15000 });
      const text = `${stdout}${stderr}`.trim();
      status.loggedIn = /logged in/i.test(text) && !/not logged in/i.test(text);
      status.subscription = /chatgpt/i.test(text);
      status.detail = text || 'Unknown login state.';
    }
  } catch (e) {
    status.detail = `Could not read login state: ${(e as Error).message.split('\n')[0]}`;
  }
  return status;
}

export async function cliStatus(force = false): Promise<Record<Cli, CliStatus>> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const [claude, codex] = await Promise.all([probe('claude'), probe('codex')]);
  cache = { at: Date.now(), value: { claude, codex } };
  return cache.value;
}

// ---------- invocation ----------

export interface Invocation {
  cli: Cli;
  cwd: string;
  prompt: string;
  schema: object;
  schemaPath: string; // absolute path; codex reads the schema from a file
  lastMessagePath: string; // absolute path; codex writes its final answer here
  tools?: string[]; // claude: built-in tools made available (read-only set)
  allowedTools?: string[]; // claude: tools pre-approved in dontAsk mode
  sandbox?: 'read-only' | 'workspace-write'; // codex: write access for the engineer only
}

// Claude Code walks up from its working directory loading CLAUDE.md files.
// A workspace under the user's home would pick up ~/.claude/CLAUDE.md as an
// ancestor "project" memory and leak personal instructions into the agent, so
// every ancestor memory file is excluded explicitly.
export function ancestorMemoryExcludes(cwd: string): string[] {
  const patterns: string[] = [];
  let dir = path.resolve(cwd);
  while (path.dirname(dir) !== dir) {
    dir = path.dirname(dir);
    patterns.push(path.join(dir, 'CLAUDE.md'), path.join(dir, '.claude', 'CLAUDE.md'), path.join(dir, 'CLAUDE.local.md'));
  }
  return patterns;
}

export function buildArgs(inv: Invocation): string[] {
  if (inv.cli === 'claude') {
    return [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--json-schema', JSON.stringify(inv.schema),
      // Isolation: ignore the user's personal CLAUDE.md, hooks, MCP servers and skills.
      '--setting-sources', 'project',
      '--settings', JSON.stringify({ claudeMdExcludes: ancestorMemoryExcludes(inv.cwd) }),
      '--strict-mcp-config',
      '--disable-slash-commands',
      // Headless: anything not pre-approved is denied, never auto-approved.
      '--permission-mode', 'dontAsk',
      '--tools', (inv.tools ?? ['Read', 'Grep', 'Glob']).join(','),
      ...(inv.allowedTools?.length ? ['--allowedTools', inv.allowedTools.join(',')] : []),
      '--no-session-persistence',
    ];
  }
  return [
    'exec',
    '--sandbox', inv.sandbox ?? 'read-only',
    '--ephemeral',
    '--ignore-user-config',
    '--skip-git-repo-check',
    '--output-schema', inv.schemaPath,
    '--output-last-message', inv.lastMessagePath,
    '--json',
    '--cd', inv.cwd,
    '-',
  ];
}

export function spawnCli(inv: Invocation): ChildProcess {
  const child = spawn(BINARIES[inv.cli], buildArgs(inv), {
    cwd: inv.cwd,
    env: childEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin!.end(inv.prompt);
  return child;
}

// Pulls the structured final answer out of a finished run.
export function extractClaudeResult(stdoutJsonl: string): { output: unknown; error: string | null } {
  let result: Record<string, any> | null = null;
  for (const line of stdoutJsonl.split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type === 'result') result = ev;
    } catch {
      /* non-JSON noise is ignored */
    }
  }
  if (!result) return { output: null, error: 'Claude finished without a result event.' };
  if (result.is_error || result.subtype !== 'success') {
    return { output: null, error: `Claude reported ${result.subtype ?? 'an error'}: ${String(result.result ?? '').slice(0, 300)}` };
  }
  if (!result.structured_output) return { output: null, error: 'Claude did not return the structured response.' };
  return { output: result.structured_output, error: null };
}

// One human-readable line per interesting event, for the live log in the UI.
export function describeEvent(cli: Cli, line: string): string | null {
  let ev: any;
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  const clip = (s: unknown, n = 140) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  if (cli === 'claude') {
    if (ev.type === 'system' && ev.subtype === 'init') return `Session started (${ev.model ?? 'default model'})`;
    if (ev.type === 'assistant') {
      const parts: string[] = [];
      for (const c of ev.message?.content ?? []) {
        if (c.type === 'text' && c.text?.trim()) parts.push(clip(c.text));
        if (c.type === 'tool_use' && c.name !== 'StructuredOutput') {
          const arg = c.input?.query ?? c.input?.url ?? c.input?.file_path ?? c.input?.pattern ?? '';
          parts.push(`→ ${c.name}${arg ? `: ${clip(arg, 100)}` : ''}`);
        }
        if (c.type === 'tool_use' && c.name === 'StructuredOutput') parts.push('→ Returning the structured result');
      }
      return parts.length ? parts.join('  ') : null;
    }
    if (ev.type === 'result') return `Finished: ${ev.subtype} in ${Math.round((ev.duration_ms ?? 0) / 1000)}s`;
    return null;
  }
  const item = ev.item ?? {};
  if (ev.type === 'thread.started') return 'Session started';
  if (ev.type === 'item.started' && item.type === 'command_execution') return `→ ${clip(item.command, 100)}`;
  if (ev.type === 'item.completed' && item.type === 'agent_message') return clip(item.text);
  if (ev.type === 'item.completed' && item.type === 'reasoning') return clip(item.text);
  if (ev.type === 'turn.completed') return 'Finished';
  if (ev.type === 'error' || ev.type === 'turn.failed') return `Error: ${clip(ev.message ?? ev.error?.message)}`;
  return null;
}
