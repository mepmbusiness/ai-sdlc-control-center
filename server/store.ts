// File-backed persistence. The workspace repository is the source of truth:
// this module only reads and writes plain JSON / Markdown files inside it.

import { promises as fs, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse as parseYaml } from 'yaml';
import type { Workflow, WorkflowState } from './engine.ts';

const run = promisify(execFile);

export const TOOL_ROOT = path.resolve(import.meta.dirname, '..');
export const TEMPLATES = path.join(TOOL_ROOT, 'templates');
export const WORKSPACES = process.env.AISDLC_WORKSPACES
  ? path.resolve(process.env.AISDLC_WORKSPACES)
  : path.join(TOOL_ROOT, 'workspaces');

export interface ActivityEntry {
  ts: string;
  actor: 'human' | 'agent' | 'system';
  event: string;
  message: string;
  stage?: string;
  agent?: string;
  cli?: string;
  runId?: string;
  result?: string;
  inputs?: string[];
  outputs?: string[];
  blockers?: string[];
  feedback?: string | null;
}

export interface Contract {
  meta: Record<string, unknown> & { id: string; required_sections?: string[] };
  body: string;
}

export function slugify(name: string): string {
  return (
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || 'product'
  );
}

// V1 manages a single product: the first workspace that has a state file.
export function activeWorkspace(): string | null {
  if (!existsSync(WORKSPACES)) return null;
  for (const name of readdirSync(WORKSPACES).sort()) {
    const dir = path.join(WORKSPACES, name);
    if (statSync(dir).isDirectory() && existsSync(path.join(dir, 'workflow', 'state.json'))) return dir;
  }
  return null;
}

// Resolves a workspace-relative path and refuses anything that escapes it.
export function safeJoin(ws: string, rel: string): string {
  const full = path.resolve(ws, rel);
  if (full !== ws && !full.startsWith(ws + path.sep)) {
    throw new Error(`Path "${rel}" is outside the workspace.`);
  }
  return full;
}

async function writeAtomic(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, content);
  await fs.rename(tmp, file);
}

export async function writeText(ws: string, rel: string, content: string): Promise<void> {
  await writeAtomic(safeJoin(ws, rel), content);
}

export async function readText(ws: string, rel: string): Promise<string | null> {
  try {
    return await fs.readFile(safeJoin(ws, rel), 'utf8');
  } catch {
    return null;
  }
}

export async function writeJson(ws: string, rel: string, data: unknown): Promise<void> {
  await writeText(ws, rel, JSON.stringify(data, null, 2) + '\n');
}

export async function readJson<T>(ws: string, rel: string): Promise<T | null> {
  const text = await readText(ws, rel);
  return text === null ? null : (JSON.parse(text) as T);
}

// Serializes every read-modify-write of workflow state in this process.
let queue: Promise<unknown> = Promise.resolve();
export function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = queue.then(fn, fn);
  queue = result.catch(() => {});
  return result;
}

export const loadWorkflow = async (ws: string) => (await readJson<Workflow>(ws, 'workflow/workflow.json'))!;
export const loadState = async (ws: string) => (await readJson<WorkflowState>(ws, 'workflow/state.json'))!;
export const saveState = (ws: string, state: WorkflowState) => writeJson(ws, 'workflow/state.json', state);

export async function appendActivity(ws: string, entry: ActivityEntry): Promise<void> {
  await fs.appendFile(safeJoin(ws, 'workflow/activity.jsonl'), JSON.stringify(entry) + '\n');
}

export async function readActivity(ws: string, limit = 200): Promise<ActivityEntry[]> {
  const text = (await readText(ws, 'workflow/activity.jsonl')) ?? '';
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ActivityEntry)
    .slice(-limit)
    .reverse();
}

export async function appendApproval(ws: string, gateId: string, record: unknown): Promise<void> {
  const rel = `workflow/approvals/${gateId}.json`;
  const history = (await readJson<unknown[]>(ws, rel)) ?? [];
  history.push(record);
  await writeJson(ws, rel, history);
}

export function parseContract(text: string): Contract {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error('Agent contract is missing its YAML header.');
  return { meta: parseYaml(m[1]), body: m[2].trim() };
}

export async function loadContract(ws: string, agentId: string): Promise<Contract> {
  const text = await readText(ws, `agents/${agentId}.md`);
  if (text === null) throw new Error(`Agent contract agents/${agentId}.md is missing.`);
  return parseContract(text);
}

// ---------- Git (local only: never pushes) ----------

export async function git(ws: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd: ws });
  return stdout.trim();
}

export async function commitAll(ws: string, message: string): Promise<string | null> {
  await git(ws, 'add', '-A');
  const staged = await git(ws, 'diff', '--cached', '--name-only');
  if (!staged) return null;
  await git(ws, 'commit', '-q', '-m', message);
  return git(ws, 'rev-parse', '--short', 'HEAD');
}

export async function gitInfo(ws: string) {
  try {
    const [branch, last, status] = await Promise.all([
      git(ws, 'rev-parse', '--abbrev-ref', 'HEAD'),
      git(ws, 'log', '-1', '--format=%h %s'),
      git(ws, 'status', '--porcelain'),
    ]);
    return { branch, lastCommit: last, changedFiles: status ? status.split('\n').length : 0 };
  } catch {
    return null;
  }
}

// ---------- Workspace creation ----------

export async function createWorkspace(
  input: { name: string; idea: string; context: string },
  initState: (wf: Workflow, project: { name: string; slug: string }) => WorkflowState,
  now: string,
): Promise<string> {
  const slug = slugify(input.name);
  const ws = path.join(WORKSPACES, slug);
  if (existsSync(ws)) throw new Error(`A workspace named "${slug}" already exists.`);
  await fs.mkdir(ws, { recursive: true });

  await fs.cp(path.join(TEMPLATES, 'agents'), path.join(ws, 'agents'), { recursive: true });
  await fs.cp(path.join(TEMPLATES, 'schemas'), path.join(ws, 'workflow', 'schemas'), { recursive: true });
  await fs.copyFile(path.join(TEMPLATES, 'workflow.json'), path.join(ws, 'workflow', 'workflow.json'));
  for (const dir of ['product', 'design', 'engineering', 'workflow/approvals', 'workflow/runs', 'workflow/checks']) {
    await fs.mkdir(path.join(ws, dir), { recursive: true });
  }

  const idea = [
    `# Idea: ${input.name.trim()}`,
    '',
    '## Problem or idea',
    '',
    input.idea.trim(),
    '',
    '## Context',
    '',
    input.context.trim() || '_No additional context provided._',
    '',
  ].join('\n');
  await writeText(ws, 'product/idea.md', idea);

  const wf = await loadWorkflow(ws);
  await saveState(ws, initState(wf, { name: input.name.trim(), slug }));
  await fs.writeFile(path.join(ws, 'workflow', 'activity.jsonl'), '');
  await appendActivity(ws, {
    ts: now,
    actor: 'human',
    event: 'product_created',
    message: `Product "${input.name.trim()}" created`,
    stage: 'idea',
    outputs: ['product/idea.md'],
  });
  await writeText(
    ws,
    'README.md',
    `# ${input.name.trim()}\n\nProduct workspace managed by AI SDLC Control Center.\n\n` +
      '- `product/`, `design/`, `engineering/`: artifacts written by agents\n' +
      '- `agents/`: the agent contracts used for this product\n' +
      '- `workflow/state.json`: current workflow state\n' +
      '- `workflow/activity.jsonl`: append-only activity log\n' +
      '- `workflow/approvals/`: human gate decisions\n' +
      '- `workflow/runs/`: prompt, raw log and handoff of every agent run\n',
  );

  await git(ws, 'init', '-q');
  await commitAll(ws, `Start product "${input.name.trim()}"\n\nCaptures the initial idea and workflow state before any agent runs.`);
  return ws;
}
