// Workspace operations for the engineering loop: code snapshots without
// commits, protection of other roles' files, and sandboxed test runs.

import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { BINARIES, childEnv } from './clis.ts';

const run = promisify(execFile);

// Paths the engineer must not change. workflow/runs is where the Control
// Center itself writes during a run, so it is left out of the comparison.
export const PROTECTED = ['agents', 'product', 'design', 'engineering', 'workflow'];
const UNWATCHED = [path.join('workflow', 'runs')];
const NOT_CODE = PROTECTED.map((p) => `:(exclude)${p}`);

// ---------- code snapshots ----------

// Records the working tree (tracked and untracked, minus .gitignore) as a Git
// tree object, using a throwaway index. Nothing is committed, HEAD and the
// real index do not move, and the tree can be diffed later.
export async function snapshotTree(ws: string): Promise<string> {
  const index = path.join(os.tmpdir(), `aisdlc-index-${process.pid}-${Date.now()}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    await run('git', ['add', '-A'], { cwd: ws, env });
    const { stdout } = await run('git', ['write-tree'], { cwd: ws, env });
    return stdout.trim();
  } finally {
    await fs.rm(index, { force: true });
  }
}

export async function codeDiff(ws: string, from: string, to: string): Promise<{ stat: string; patch: string }> {
  const args = (mode: string[]) => ['diff', ...mode, from, to, '--', '.', ...NOT_CODE];
  const [stat, patch] = await Promise.all([
    run('git', args(['--stat']), { cwd: ws, maxBuffer: 64 * 1024 * 1024 }),
    run('git', args(['--unified=3']), { cwd: ws, maxBuffer: 64 * 1024 * 1024 }),
  ]);
  return { stat: stat.stdout.trim(), patch: patch.stdout };
}

export async function changedFiles(ws: string, from: string, to: string): Promise<string[]> {
  const { stdout } = await run('git', ['diff', '--name-only', from, to, '--', '.', ...NOT_CODE], { cwd: ws });
  return stdout.trim().split('\n').filter(Boolean);
}

// ---------- protection of other roles' files ----------

async function walk(ws: string, rel: string, out: Map<string, Buffer>) {
  if (UNWATCHED.includes(rel)) return;
  const full = path.join(ws, rel);
  if (!existsSync(full)) return;
  const stat = await fs.stat(full);
  if (stat.isDirectory()) {
    for (const name of await fs.readdir(full)) await walk(ws, path.join(rel, name), out);
  } else {
    out.set(rel, await fs.readFile(full));
  }
}

export async function snapshotProtected(ws: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const dir of PROTECTED) await walk(ws, dir, files);
  return files;
}

// Puts every protected file back exactly as it was and returns what had changed.
export async function restoreProtected(ws: string, before: Map<string, Buffer>): Promise<string[]> {
  const after = await snapshotProtected(ws);
  const violations: string[] = [];
  for (const [rel, content] of after) {
    if (!before.has(rel)) {
      violations.push(`created ${rel}`);
      await fs.rm(path.join(ws, rel), { force: true });
    } else if (!before.get(rel)!.equals(content)) {
      violations.push(`modified ${rel}`);
      await fs.writeFile(path.join(ws, rel), before.get(rel)!);
    }
  }
  for (const [rel, content] of before) {
    if (!after.has(rel)) {
      violations.push(`deleted ${rel}`);
      await fs.mkdir(path.dirname(path.join(ws, rel)), { recursive: true });
      await fs.writeFile(path.join(ws, rel), content);
    }
  }
  return violations;
}

// ---------- sandboxed tests ----------

export interface TestResult {
  ok: boolean;
  command: string | null;
  summary: string;
  output: string;
}

const TEST_TIMEOUT_MS = 5 * 60_000;

// Runs the product's `test` script inside the Codex seatbelt sandbox:
// writes only inside the product folder and the temp dir, no network,
// .git read-only. Agent-written code never runs unsandboxed.
export async function runTests(ws: string, onSpawn?: (kill: () => void) => void): Promise<TestResult> {
  let script: string | undefined;
  try {
    script = JSON.parse(await fs.readFile(path.join(ws, 'package.json'), 'utf8')).scripts?.test;
  } catch {
    return { ok: false, command: null, summary: 'No package.json in the product folder.', output: '' };
  }
  if (!script) return { ok: false, command: null, summary: 'package.json has no "test" script.', output: '' };

  return new Promise((resolve) => {
    const child = spawn(BINARIES.codex, ['sandbox', '-c', 'sandbox_mode="workspace-write"', 'sh', '-c', script!], {
      cwd: ws,
      env: { ...childEnv(), CI: '1', NO_COLOR: '1' },
    });
    let output = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, TEST_TIMEOUT_MS);
    onSpawn?.(() => child.kill('SIGTERM'));
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('error', (e) => (output += `\n${e.message}`));
    child.on('close', (code) => {
      clearTimeout(timer);
      // node:test prints `# pass 3` (TAP) or `ℹ pass 3` (spec reporter).
      const counts = [...output.matchAll(/^(?:#|ℹ) (tests|pass|fail) (\d+)$/gm)].map((m) => `${m[1]} ${m[2]}`).join(', ');
      const summary = timedOut
        ? 'Test suite timed out after 5 minutes.'
        : code === 0
          ? `Test suite passed${counts ? ` (${counts})` : ''}.`
          : `Test suite failed with exit code ${code}${counts ? ` (${counts})` : ''}.`;
      resolve({ ok: code === 0 && !timedOut, command: script!, summary, output });
    });
  });
}
