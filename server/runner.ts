// Runs one agent (or one cross-check) end to end: preflight, prompt, CLI,
// deterministic checks, artifact, handoff record, state and activity.

import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import * as engine from './engine.ts';
import type { Workflow, WorkflowState, StageDef } from './engine.ts';
import * as store from './store.ts';
import { cliStatus, spawnCli, extractClaudeResult, describeEvent, strippedKeysPresent } from './clis.ts';
import * as wsx from './workspace.ts';

const RUN_TIMEOUT_MS = { produce: 20 * 60_000, check: 10 * 60_000 };
const children = new Map<string, ChildProcess>();
const killers = new Map<string, () => void>(); // test runs started on behalf of a checker
const cancelled = new Set<string>();

const now = () => new Date().toISOString();

function newRunId(stageId: string, purpose: string): string {
  const stamp = now().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  return `${stamp}-${stageId}${purpose === 'check' ? '-check' : ''}`;
}

// Producers return artifacts in their structured response and the Control
// Center writes them, so a producer contract may only ask for read-only tools.
// Web tools need explicit pre-approval in dontAsk mode; file reads do not.
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'];
const NEEDS_APPROVAL = ['WebSearch', 'WebFetch'];

export function producerToolset(contract: store.Contract): { tools: string[]; allowed: string[] } {
  const perms = (contract.meta.permissions ?? {}) as { tools?: string[] };
  const requested = perms.tools ?? ['Read', 'Grep', 'Glob'];
  const refused = requested.filter((t) => !READ_ONLY_TOOLS.includes(t));
  if (refused.length) {
    throw new engine.EngineError('unsafe_contract', `Contract ${contract.meta.id} asks for write-capable tools: ${refused.join(', ')}.`);
  }
  return { tools: requested, allowed: requested.filter((t) => NEEDS_APPROVAL.includes(t)) };
}

// ---------- preflight ----------

export interface PreflightItem {
  label: string;
  ok: boolean;
  detail: string;
}

export async function preflight(ws: string, wf: Workflow, state: WorkflowState, stageId: string, purpose: 'produce' | 'check') {
  const def = engine.stageDef(wf, stageId);
  const items: PreflightItem[] = [];
  let agentId: string;

  if (purpose === 'produce') {
    const reasons = engine.runBlockers(state, wf, stageId);
    items.push({ label: 'Workflow allows this stage to run', ok: !reasons.length, detail: reasons.join(' ') || 'Previous gates approved, no other agent running.' });
    agentId = def.agent!;
    for (const input of def.inputs ?? []) {
      const exists = existsSync(store.safeJoin(ws, input));
      items.push({ label: `Input ${input}`, ok: exists, detail: exists ? 'Present' : 'Missing. The previous stage has not produced it.' });
    }
  } else {
    const ok = def.kind === 'gate' && !!def.check && state.stages[stageId].status === 'APPROVAL_REQUIRED' && !state.activeRun;
    items.push({ label: 'Gate is waiting for a decision', ok, detail: ok ? 'Ready for an independent check.' : 'The gate is not pending, or another agent is running.' });
    agentId = def.check?.agent ?? '';
    const reviewed = def.reviews ? engine.stageDef(wf, def.reviews) : null;
    for (const out of reviewed?.outputs ?? []) {
      const exists = existsSync(store.safeJoin(ws, out));
      items.push({ label: `Artifact ${out}`, ok: exists, detail: exists ? 'Present' : 'Missing' });
    }
  }

  const agent = wf.agents[agentId];
  const contractOk = existsSync(store.safeJoin(ws, `agents/${agentId}.md`));
  items.push({ label: `Agent contract agents/${agentId}.md`, ok: contractOk, detail: contractOk ? 'Present' : 'Missing' });

  const status = (await cliStatus())[agent.cli];
  items.push({ label: `${agent.tool} CLI installed`, ok: status.installed, detail: status.version ?? status.detail });
  items.push({ label: `${agent.tool} CLI signed in`, ok: status.loggedIn, detail: status.detail });
  items.push({
    label: 'Runs on your subscription, not a paid API key',
    ok: status.subscription,
    detail: status.subscription ? 'Subscription login detected.' : 'The CLI is not using a subscription login. Paid API usage is not allowed in V1.',
  });
  const keys = strippedKeysPresent();
  if (keys.length) {
    items.push({ label: 'API keys in environment', ok: true, detail: `${keys.join(', ')} found and removed from the agent's environment.` });
  }

  return {
    stage: stageId,
    purpose,
    agent: agentId,
    agentLabel: agent.label,
    tool: agent.tool,
    cli: agent.cli,
    ok: items.every((i) => i.ok),
    items,
  };
}

// ---------- prompt ----------

// Markdown inputs are inlined; HTML (the prototype) is large, so agents get its
// path and read it with their own tools when they need it.
async function inputsSection(ws: string, files: string[]): Promise<string> {
  const parts: string[] = [];
  for (const rel of files) {
    const text = await store.readText(ws, rel);
    if (text !== null && rel.endsWith('.html')) {
      parts.push(`### ${rel}\n\n_HTML file, ${Math.round(text.length / 1024)} KB. Read it from the repository if you need it._`);
    } else {
      parts.push(`### ${rel}\n\n${text ?? '_(missing)_'}`);
    }
  }
  return parts.join('\n\n');
}

export type Mode = 'document' | 'engineer' | 'checker';
export const stageMode = (def: StageDef): Mode => (def.writeAccess ? 'engineer' : def.returnTo ? 'checker' : 'document');

async function producerPrompt(
  ws: string,
  wf: Workflow,
  state: WorkflowState,
  def: StageDef,
  contract: store.Contract,
  extras: string[],
): Promise<string> {
  const mode = stageMode(def);
  const gate = wf.stages.find((s) => s.kind === 'gate' && s.reviews === def.id);
  const decision = gate ? state.stages[gate.id].decision : null;
  const st = state.stages[def.id];

  const sections = [contract.body, '---', `## Input artifacts\n\n${await inputsSection(ws, def.inputs ?? [])}`, ...extras];
  if (decision?.decision === 'REJECTED' && decision.feedback) {
    sections.push(
      `## Human feedback on your previous version\n\nA human rejected the previous version with this feedback. Address it explicitly.\n\n> ${decision.feedback.replace(/\n/g, '\n> ')}`,
      `## Your previous version\n\n${await inputsSection(ws, def.outputs ?? [])}`,
    );
  }
  if (mode === 'engineer') {
    // Work sent back by checkers: their latest report and blockers.
    for (const checker of wf.stages.filter((s) => s.returnTo === def.id)) {
      const cst = state.stages[checker.id];
      if (cst.status !== 'FAIL' || !cst.blockers.length) continue;
      sections.push(
        `## Blockers from ${checker.label} (fix these)\n\n${cst.blockers.map((b) => `- ${b}`).join('\n')}`,
        `## Latest ${checker.label} report\n\n${await inputsSection(ws, checker.outputs ?? [])}`,
      );
    }
  }
  if (st.status === 'FAIL' && st.blockers.length) {
    sections.push(`## Blockers from your previous attempt\n\n${st.blockers.map((b) => `- ${b}`).join('\n')}`);
  }
  if (mode === 'engineer') {
    sections.push('## How to answer', 'Write the code in the workspace, then return the structured response described in your contract.');
    return sections.join('\n\n');
  }
  const required = requiredSections(contract, def);
  const files = (def.outputs ?? [])
    .map((o) => `- \`${o}\`${required[o]?.length ? `: level-2 headings ${required[o].map((h) => `"${h}"`).join(', ')}` : ''}`)
    .join('\n');
  sections.push(
    '## How to answer',
    'Do not create or edit files. Return your result as the structured response: `status`, `summary`, ' +
      '`artifacts` (one entry per file below, with the exact path and the complete content) and `blockers`.' +
      (mode === 'checker' ? ' `status` is your verdict: PASS or FAIL. A FAIL must list actionable blockers.' : ''),
    `## Files to return\n\n${files}`,
  );
  return sections.join('\n\n');
}

async function checkPrompt(ws: string, wf: Workflow, gate: StageDef): Promise<string> {
  const critic = await store.loadContract(ws, gate.check!.agent);
  const reviewed = engine.stageDef(wf, gate.reviews!);
  const author = await store.loadContract(ws, reviewed.agent!);
  return [
    critic.body,
    '---',
    `## Contract of the agent that wrote the artifact (${reviewed.agent})\n\n${author.body}`,
    `## Inputs that agent received\n\n${await inputsSection(ws, reviewed.inputs ?? [])}`,
    `## Artifact under review\n\n${await inputsSection(ws, reviewed.outputs ?? [])}`,
    '## How to answer',
    'Do not create or edit files. Return `verdict`, `summary` and `findings` as the structured response.',
  ].join('\n\n');
}

// ---------- deterministic checks (run by the Control Center, not the agent) ----------

type Check = { name: string; ok: boolean; detail: string };
export type Artifact = { path: string; content: string };

// Accepts both the per-file map and the older single-list form of required_sections.
export function requiredSections(contract: store.Contract, def: StageDef): Record<string, string[]> {
  const raw = contract.meta.required_sections;
  if (Array.isArray(raw)) return { [def.outputs![0]]: raw };
  return (raw as Record<string, string[]>) ?? {};
}

export function artifactChecks(artifacts: Artifact[], outputs: string[], required: Record<string, string[]>): Check[] {
  const checks: Check[] = [];
  const byPath = new Map(artifacts.map((a) => [a.path.replace(/^\.\//, ''), a.content]));
  for (const path of byPath.keys()) {
    if (!outputs.includes(path)) checks.push({ name: `Only declared outputs`, ok: false, detail: `${path} is not an output of this stage` });
  }
  for (const out of outputs) {
    const content = byPath.get(out);
    if (content === undefined || !content.trim()) {
      checks.push({ name: `File ${out}`, ok: false, detail: content === undefined ? 'missing' : 'empty' });
      continue;
    }
    checks.push({ name: `File ${out}`, ok: true, detail: '' });
    if (out.endsWith('.html')) {
      checks.push({ name: `${out} is an HTML document`, ok: /<html[\s>]/i.test(content), detail: '' });
    }
    for (const c of sectionChecks(content, required[out] ?? []).slice(1)) {
      checks.push({ ...c, name: `${out}: ${c.name}` });
    }
  }
  return checks;
}

export function sectionChecks(markdown: string, required: string[]): { name: string; ok: boolean; detail: string }[] {
  const headings = new Map<string, string>();
  const lines = markdown.split('\n');
  let current: string | null = null;
  for (const line of lines) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      current = h[1].toLowerCase();
      headings.set(current, '');
    } else if (current) {
      headings.set(current, headings.get(current)! + line.trim());
    }
  }
  const checks = [{ name: 'Artifact is not empty', ok: markdown.trim().length > 0, detail: '' }];
  for (const sec of required) {
    const body = headings.get(sec.toLowerCase());
    checks.push({
      name: `Section "${sec}"`,
      ok: body !== undefined && body.length > 0,
      detail: body === undefined ? 'missing' : body.length ? '' : 'empty',
    });
  }
  return checks;
}

// ---------- execution ----------

function collect(child: ChildProcess, logFile: string, cli: 'claude' | 'codex', runId: string, timeoutMs: number) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
    let stdout = '';
    let stderr = '';
    let pending = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout!.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      pending += text;
      const lines = pending.split('\n');
      pending = lines.pop()!;
      for (const line of lines) {
        const msg = describeEvent(cli, line);
        if (msg) fs.appendFile(logFile, JSON.stringify({ ts: now(), msg }) + '\n').catch(() => {});
      }
    });
    child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (err) => {
      stderr += `\n${err.message}`;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      children.delete(runId);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

function failureReason(r: { code: number | null; stderr: string; timedOut: boolean }, runId: string): string {
  if (cancelled.delete(runId)) return 'Cancelled by the user.';
  if (r.timedOut) return 'The agent took too long and was stopped.';
  const tail = r.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300);
  return `The CLI exited with code ${r.code}${tail ? `: ${tail}` : '.'}`;
}

async function readCodexOutput(file: string): Promise<{ output: unknown; error: string | null }> {
  try {
    return { output: JSON.parse(await fs.readFile(file, 'utf8')), error: null };
  } catch {
    return { output: null, error: 'Codex did not return the structured response.' };
  }
}

type Collected = { code: number | null; stdout: string; stderr: string; timedOut: boolean };
type Trees = { baseline?: string; lastReviewed?: string };
const TREES = 'workflow/trees.json';

export async function startProduce(ws: string, stageId: string): Promise<string> {
  const wf = await store.loadWorkflow(ws);
  let state = await store.loadState(ws);
  const pf = await preflight(ws, wf, state, stageId, 'produce');
  if (!pf.ok) {
    throw new engine.EngineError('preflight_failed', pf.items.filter((i) => !i.ok).map((i) => `${i.label}: ${i.detail}`).join(' | '));
  }
  const def = engine.stageDef(wf, stageId);
  const agent = wf.agents[def.agent!];
  const mode = stageMode(def);
  const contract = await store.loadContract(ws, def.agent!);
  // Validated before the run is recorded, so a bad setup never leaves a stage stuck in RUNNING.
  if (mode === 'engineer' && agent.cli !== 'codex') {
    throw new engine.EngineError('unsupported', 'Only the Codex adapter supports write access in this version.');
  }
  const toolset = agent.cli === 'claude' ? producerToolset(contract) : undefined;
  const runId = newRunId(stageId, 'produce');

  state = engine.startRun(state, wf, stageId, runId, now());
  await store.saveState(ws, state);
  await store.appendActivity(ws, {
    ts: now(), actor: 'agent', event: 'run_started', stage: stageId, agent: def.agent, cli: agent.cli, runId,
    inputs: def.inputs, message: `${agent.tool} started ${def.label} (${agent.label})`,
  });

  const startedAt = state.stages[stageId].startedAt!;
  execute(ws, wf, state, def, contract, runId, startedAt, toolset).catch((err) =>
    store
      .withLock(() =>
        finishRun(ws, wf, def, runId, startedAt, {
          status: 'FAIL', summary: 'The run could not be completed.', blockers: [`Control Center error: ${(err as Error).message}`],
          checks: [], outputs: [], error: true,
        }),
      )
      .catch((e) => console.error(`[run ${runId}]`, e)),
  );
  return runId;
}

async function execute(
  ws: string,
  wf: Workflow,
  state: WorkflowState,
  def: StageDef,
  contract: store.Contract,
  runId: string,
  startedAt: string,
  toolset: { tools: string[]; allowed: string[] } | undefined,
) {
  const mode = stageMode(def);
  const agent = wf.agents[def.agent!];
  const runDir = `workflow/runs/${runId}`;
  const logFile = store.safeJoin(ws, `${runDir}/events.jsonl`);
  await fs.mkdir(path.dirname(logFile), { recursive: true });
  const log = (msg: string) => fs.appendFile(logFile, JSON.stringify({ ts: now(), msg }) + '\n');
  const trees = (await store.readJson<Trees>(ws, TREES)) ?? {};
  const extras: string[] = [];
  const ctx: EngineerCtx & CheckerCtx = {};

  if (mode === 'engineer') {
    const before = await wsx.snapshotTree(ws);
    if (!trees.baseline) {
      trees.baseline = before;
      await store.writeJson(ws, TREES, trees);
    }
    ctx.treeBefore = before;
    ctx.protectedBefore = await wsx.snapshotProtected(ws);
    await log('Snapshot of the code and of protected files taken');
  }
  if (mode === 'checker') {
    await log('Running the test suite in the sandbox');
    ctx.tests = await wsx.runTests(ws, (kill) => killers.set(runId, kill));
    killers.delete(runId);
    await store.writeText(ws, `${runDir}/tests.log`, ctx.tests.output);
    await log(ctx.tests.summary);
    if (cancelled.has(runId)) throw new Error('Cancelled by the user.');
    const head = await wsx.snapshotTree(ws);
    const base = def.diff === 'since-last-review' ? trees.lastReviewed ?? trees.baseline : trees.baseline;
    if (!base) throw new Error('No implementation baseline found. Run Implementation first.');
    const diff = await wsx.codeDiff(ws, base, head);
    ctx.reviewedTree = head;
    const fixReview = def.diff === 'since-last-review' && !!trees.lastReviewed;
    const MAX = 400_000;
    extras.push(
      `## Diff to review (${fixReview ? 'only the changes since your last review' : 'the whole implementation'})\n\n` +
        '```\n' + (diff.stat || '(no code changes)') + '\n```\n\n```diff\n' +
        (diff.patch.length > MAX ? diff.patch.slice(0, MAX) + '\n... (diff truncated; read the files directly)' : diff.patch) + '\n```',
      `## Test suite result (run by the Control Center in a sandbox)\n\nCommand: \`${ctx.tests.command ?? 'none'}\`\n\n${ctx.tests.summary}\n\n\`\`\`\n${ctx.tests.output.slice(-6000)}\n\`\`\``,
    );
    if (fixReview) extras.push(`## Your previous review\n\n${await inputsSection(ws, def.outputs ?? [])}`);
  }

  const prompt = await producerPrompt(ws, wf, state, def, contract, extras);
  await store.writeText(ws, `${runDir}/prompt.md`, prompt);
  const schemaRel = `workflow/schemas/${mode === 'engineer' ? 'implementation' : 'producer'}.schema.json`;
  const schema = JSON.parse((await store.readText(ws, schemaRel))!);
  delete schema.$id;
  delete schema.description;
  if (cancelled.has(runId)) throw new Error('Cancelled by the user.');
  const child = spawnCli({
    cli: agent.cli,
    cwd: ws,
    prompt,
    schema,
    schemaPath: store.safeJoin(ws, schemaRel),
    lastMessagePath: store.safeJoin(ws, `${runDir}/last-message.json`),
    tools: toolset?.tools,
    allowedTools: toolset?.allowed,
    sandbox: mode === 'engineer' ? 'workspace-write' : 'read-only',
  });
  children.set(runId, child);
  const r = await collect(child, logFile, agent.cli, runId, def.timeoutMinutes ? def.timeoutMinutes * 60_000 : RUN_TIMEOUT_MS.produce);
  await store.writeText(ws, `${runDir}/stdout.jsonl`, r.stdout);
  if (r.stderr.trim()) await store.writeText(ws, `${runDir}/stderr.log`, r.stderr);

  const parsed =
    r.code !== 0 || r.timedOut
      ? { output: null, error: failureReason(r, runId) }
      : agent.cli === 'claude'
        ? extractClaudeResult(r.stdout)
        : await readCodexOutput(store.safeJoin(ws, `${runDir}/last-message.json`));

  if (mode === 'engineer') {
    // Protected files are restored even when the run failed or was cancelled.
    const violations = await wsx.restoreProtected(ws, ctx.protectedBefore!);
    if (violations.length) await log(`Reverted changes to protected files: ${violations.join(', ')}`);
    const result = await engineerResult(ws, def, runId, parsed, violations, ctx.treeBefore!, log);
    return store.withLock(() => finishRun(ws, wf, def, runId, startedAt, result));
  }
  const result = mode === 'checker' ? await checkerResult(ws, def, runId, parsed, contract, ctx) : await documentResult(ws, def, runId, parsed, contract);
  return store.withLock(() => finishRun(ws, wf, def, runId, startedAt, result));
}

interface EngineerCtx { treeBefore?: string; protectedBefore?: Map<string, Buffer> }
interface CheckerCtx { tests?: wsx.TestResult; reviewedTree?: string }
interface StageResult {
  status: 'PASS' | 'FAIL';
  summary: string | null;
  blockers: string[];
  checks: Check[];
  outputs: string[];
  error: boolean;
  extra?: Record<string, unknown>;
}
type Parsed = { output: unknown; error: string | null };

async function documentResult(ws: string, def: StageDef, runId: string, parsed: Parsed, contract: store.Contract): Promise<StageResult> {
  if (parsed.error) return { status: 'FAIL', summary: 'The agent run did not complete.', blockers: [parsed.error], checks: [], outputs: [], error: true };
  const out = parsed.output as { status: 'PASS' | 'FAIL'; summary: string; artifacts: Artifact[]; blockers: string[] };
  const artifacts = (out.artifacts ?? []).map((a) => ({ path: a.path.replace(/^\.\//, ''), content: a.content }));
  const checks = artifactChecks(artifacts, def.outputs ?? [], requiredSections(contract, def));
  const failed = checks.filter((c) => !c.ok).map((c) => `Check failed: ${c.name}${c.detail ? ` (${c.detail})` : ''}`);
  const status = out.status === 'PASS' && failed.length === 0 ? 'PASS' : 'FAIL';
  const outputs = await writeArtifacts(ws, def, runId, artifacts, status === 'PASS');
  return { status, summary: out.summary, blockers: [...(out.blockers ?? []), ...failed], checks, outputs, error: false };
}

async function writeArtifacts(ws: string, def: StageDef, runId: string, artifacts: Artifact[], final: boolean): Promise<string[]> {
  const outputs: string[] = [];
  for (const a of artifacts) {
    if (!(def.outputs ?? []).includes(a.path) || !a.content.trim()) continue;
    // Drafts stay inside the run folder, never overwriting the last good artifact.
    const target = final ? a.path : `workflow/runs/${runId}/draft/${a.path}`;
    await store.writeText(ws, target, a.content.trimEnd() + '\n');
    outputs.push(target);
  }
  return outputs;
}

async function checkerResult(ws: string, def: StageDef, runId: string, parsed: Parsed, contract: store.Contract, ctx: CheckerCtx): Promise<StageResult> {
  const testCheck = { name: 'Test suite passes (sandboxed run by the Control Center)', ok: ctx.tests!.ok, detail: ctx.tests!.summary };
  if (parsed.error) {
    return { status: 'FAIL', summary: 'The review did not complete.', blockers: [parsed.error], checks: [testCheck], outputs: [], error: true };
  }
  const out = parsed.output as { status: 'PASS' | 'FAIL'; summary: string; artifacts: Artifact[]; blockers: string[] };
  const artifacts = (out.artifacts ?? []).map((a) => ({ path: a.path.replace(/^\.\//, ''), content: a.content }));
  const checks = artifactChecks(artifacts, def.outputs ?? [], requiredSections(contract, def));
  const invalid = checks.filter((c) => !c.ok).map((c) => `Report check failed: ${c.name}${c.detail ? ` (${c.detail})` : ''}`);
  if (out.status === 'FAIL' && !(out.blockers ?? []).length) invalid.push('FAIL verdict without actionable blockers.');
  if (invalid.length) {
    // A malformed report is the reviewer's problem, not the engineer's: fail in place.
    const outputs = await writeArtifacts(ws, def, runId, artifacts, false);
    return { status: 'FAIL', summary: out.summary, blockers: invalid, checks: [...checks, testCheck], outputs, error: true };
  }
  const blockers = [...(out.blockers ?? [])];
  if (!ctx.tests!.ok) blockers.push(`Test suite does not pass: ${ctx.tests!.summary}`);
  const status = out.status === 'PASS' && ctx.tests!.ok ? 'PASS' : 'FAIL';
  const outputs = await writeArtifacts(ws, def, runId, artifacts, true);
  outputs.push(`workflow/runs/${runId}/tests.log`);
  if (def.diff === 'since-last-review') {
    const trees = (await store.readJson<Trees>(ws, TREES)) ?? {};
    await store.writeJson(ws, TREES, { ...trees, lastReviewed: ctx.reviewedTree });
  }
  return { status, summary: out.summary, blockers, checks: [...checks, testCheck], outputs, error: false, extra: { reviewedTree: ctx.reviewedTree } };
}

interface Implementation {
  status: 'PASS' | 'FAIL';
  summary: string;
  tasks_completed: string[];
  tasks_remaining: string[];
  files_changed: string[];
  how_to_run: string;
  fixes: { blocker: string; resolution: string }[];
  notes_for_reviewers: string;
  blockers: string[];
}

export function renderNotes(runId: string, impl: Implementation, tests: wsx.TestResult, changed: string[], violations: string[]): string {
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : '_None._');
  return [
    '# Implementation notes',
    '',
    `- Run: \`${runId}\``,
    `- Reported status: **${impl.status}**`,
    `- Test suite (run by the Control Center in a sandbox): ${tests.summary}`,
    `- How to run: \`${impl.how_to_run}\``,
    '',
    '## Summary', '', impl.summary, '',
    '## Tasks completed', '', list(impl.tasks_completed), '',
    '## Tasks remaining', '', list(impl.tasks_remaining), '',
    '## Fixes in this run', '',
    impl.fixes.length ? impl.fixes.map((f) => `- **${f.blocker}**\n  ${f.resolution}`).join('\n') : '_Not a fix run._', '',
    '## Files changed (measured by the Control Center)', '', list(changed), '',
    '## Notes for reviewers', '', impl.notes_for_reviewers || '_None._', '',
    ...(violations.length ? ['## Reverted changes to protected files', '', list(violations), ''] : []),
    '## Blockers', '', list(impl.blockers), '',
  ].join('\n');
}

async function engineerResult(
  ws: string,
  def: StageDef,
  runId: string,
  parsed: Parsed,
  violations: string[],
  treeBefore: string,
  log: (m: string) => Promise<void>,
): Promise<StageResult> {
  const protectedCheck = {
    name: 'Files owned by other roles left untouched',
    ok: !violations.length,
    detail: violations.length ? `reverted: ${violations.join(', ')}` : '',
  };
  if (parsed.error) {
    return { status: 'FAIL', summary: 'The implementation run did not complete.', blockers: [parsed.error], checks: [protectedCheck], outputs: [], error: true };
  }
  const impl = parsed.output as Implementation;
  await log('Running the test suite in the sandbox');
  const tests = await wsx.runTests(ws);
  await store.writeText(ws, `workflow/runs/${runId}/tests.log`, tests.output);
  await log(tests.summary);
  const treeAfter = await wsx.snapshotTree(ws);
  const changed = await wsx.changedFiles(ws, treeBefore, treeAfter);

  const checks = [
    protectedCheck,
    { name: 'Test suite passes (sandboxed run by the Control Center)', ok: tests.ok, detail: tests.summary },
    { name: 'Every planned task done', ok: impl.tasks_remaining.length === 0, detail: impl.tasks_remaining.join(', ') },
    { name: 'Code changed', ok: changed.length > 0, detail: `${changed.length} files` },
  ];
  const failed = checks.filter((c) => !c.ok).map((c) => `Check failed: ${c.name}${c.detail ? ` (${c.detail})` : ''}`);
  const status = impl.status === 'PASS' && failed.length === 0 ? 'PASS' : 'FAIL';
  const notes = def.outputs![0];
  await store.writeText(ws, notes, renderNotes(runId, impl, tests, changed, violations));
  return {
    status,
    summary: impl.summary,
    blockers: [...impl.blockers, ...failed],
    checks,
    outputs: [notes, `workflow/runs/${runId}/tests.log`],
    error: false,
    extra: { treeBefore, treeAfter, filesChanged: changed },
  };
}

async function finishRun(ws: string, wf: Workflow, def: StageDef, runId: string, startedAt: string, res: StageResult) {
  const agent = wf.agents[def.agent!];
  const completedAt = now();
  if (cancelled.delete(runId) && !res.blockers.includes('Cancelled by the user.')) {
    res = { ...res, status: 'FAIL', blockers: ['Cancelled by the user.'], error: true };
  }
  await store.writeJson(ws, `workflow/runs/${runId}/handoff.json`, {
    protocol: 'aisdlc.handoff/v1',
    runId,
    stage: def.id,
    agent: def.agent,
    cli: agent.cli,
    status: res.status,
    summary: res.summary ?? '',
    outputs: res.outputs,
    blockers: res.blockers,
    checks: res.checks,
    next: res.status === 'PASS' ? def.next ?? null : null,
    returnTo: res.status === 'FAIL' ? (res.error ? def.id : def.returnTo ?? def.id) : null,
    startedAt,
    completedAt,
    ...(res.extra ?? {}),
  });

  let state = await store.loadState(ws);
  state = engine.completeRun(state, wf, runId, { status: res.status, summary: res.summary, blockers: res.blockers, error: res.error }, completedAt);
  await store.saveState(ws, state);
  const finalStatus = state.stages[def.id].status;
  const routed = res.status === 'FAIL' && !res.error && def.returnTo ? `, sent back to ${engine.stageDef(wf, def.returnTo).label}` : '';
  await store.appendActivity(ws, {
    ts: completedAt, actor: 'agent', event: 'run_finished', stage: def.id, agent: def.agent, cli: agent.cli, runId,
    result: finalStatus, outputs: res.outputs, blockers: res.blockers,
    message: `${def.label} ${finalStatus}${routed}${res.status === 'PASS' && res.outputs.length ? `, ${res.outputs.filter((o) => !o.endsWith('.log')).join(', ')} written` : ''}`,
  });
}

export async function startCheck(ws: string, gateId: string): Promise<string> {
  const wf = await store.loadWorkflow(ws);
  let state = await store.loadState(ws);
  const pf = await preflight(ws, wf, state, gateId, 'check');
  if (!pf.ok) {
    throw new engine.EngineError('preflight_failed', pf.items.filter((i) => !i.ok).map((i) => `${i.label}: ${i.detail}`).join(' | '));
  }
  const gate = engine.stageDef(wf, gateId);
  const agent = wf.agents[gate.check!.agent];
  const runId = newRunId(gateId, 'check');
  const runDir = `workflow/runs/${runId}`;
  const prompt = await checkPrompt(ws, wf, gate);

  state = engine.startCheck(state, wf, gateId, runId, now());
  await store.saveState(ws, state);
  await store.writeText(ws, `${runDir}/prompt.md`, prompt);
  await store.appendActivity(ws, {
    ts: now(), actor: 'agent', event: 'check_started', stage: gateId, agent: gate.check!.agent, cli: agent.cli, runId,
    inputs: engine.stageDef(wf, gate.reviews!).outputs, message: `${agent.tool} started an independent check for ${gate.label}`,
  });

  const schemaRel = 'workflow/schemas/critique.schema.json';
  const schema = JSON.parse((await store.readText(ws, schemaRel))!);
  delete schema.$id;
  delete schema.description;
  const child = spawnCli({
    cli: agent.cli,
    cwd: ws,
    prompt,
    schema,
    schemaPath: store.safeJoin(ws, schemaRel),
    lastMessagePath: store.safeJoin(ws, `${runDir}/last-message.json`),
  });
  children.set(runId, child);
  const logFile = store.safeJoin(ws, `${runDir}/events.jsonl`);
  collect(child, logFile, agent.cli, runId, RUN_TIMEOUT_MS.check)
    .then((r) => store.withLock(() => finishCheck(ws, wf, gate, runId, r)))
    .catch((err) => console.error(`[check ${runId}]`, err));
  return runId;
}

interface Critique {
  verdict: 'PASS' | 'CONCERNS';
  summary: string;
  findings: { severity: string; issue: string; evidence: string; suggestion: string }[];
}

export function renderCritique(gateLabel: string, agentTool: string, runId: string, c: Critique): string {
  const lines = [
    `# Independent check: ${gateLabel}`,
    '',
    `- Reviewer: ${agentTool} (advisory, does not block the gate)`,
    `- Verdict: **${c.verdict}**`,
    `- Run: \`${runId}\``,
    '',
    '## Summary',
    '',
    c.summary,
    '',
    '## Findings',
    '',
  ];
  if (!c.findings.length) lines.push('_No findings._');
  for (const f of c.findings) {
    lines.push(`### [${f.severity.toUpperCase()}] ${f.issue}`, '', `- Evidence: ${f.evidence}`, `- Suggestion: ${f.suggestion}`, '');
  }
  return lines.join('\n') + '\n';
}

async function finishCheck(
  ws: string,
  wf: Workflow,
  gate: StageDef,
  runId: string,
  r: { code: number | null; stdout: string; stderr: string; timedOut: boolean },
) {
  const runDir = `workflow/runs/${runId}`;
  const agent = wf.agents[gate.check!.agent];
  await store.writeText(ws, `${runDir}/stdout.jsonl`, r.stdout);
  if (r.stderr.trim()) await store.writeText(ws, `${runDir}/stderr.log`, r.stderr);

  const parsed =
    r.code !== 0 || r.timedOut
      ? { output: null, error: failureReason(r, runId) }
      : await readCodexOutput(store.safeJoin(ws, `${runDir}/last-message.json`));

  let result: { status: 'PASS' | 'CONCERNS' | 'ERROR'; summary: string | null; findings: number };
  if (parsed.error) {
    result = { status: 'ERROR', summary: parsed.error, findings: 0 };
  } else {
    const c = parsed.output as Critique;
    await store.writeText(ws, `workflow/checks/${gate.id}.md`, renderCritique(gate.label, agent.tool, runId, c));
    await store.writeJson(ws, `workflow/checks/${gate.id}.json`, { runId, ...c });
    result = { status: c.verdict, summary: c.summary, findings: c.findings.length };
  }

  const ts = now();
  let state = await store.loadState(ws);
  state = engine.completeCheck(state, runId, result, ts);
  await store.saveState(ws, state);
  await store.appendActivity(ws, {
    ts, actor: 'agent', event: 'check_finished', stage: gate.id, agent: gate.check!.agent, cli: agent.cli, runId,
    result: result.status, outputs: result.status === 'ERROR' ? [] : [`workflow/checks/${gate.id}.md`],
    blockers: result.status === 'ERROR' ? [result.summary!] : [],
    message: `Independent check for ${gate.label}: ${result.status}${result.findings ? ` (${result.findings} findings)` : ''}`,
  });
}

export function cancelRun(runId: string): boolean {
  const child = children.get(runId);
  const kill = killers.get(runId);
  if (!child && !kill) return false;
  cancelled.add(runId);
  child?.kill('SIGTERM');
  kill?.();
  return true;
}

export async function readRunLog(ws: string, runId: string): Promise<{ ts: string; msg: string }[]> {
  if (!/^[\w-]+$/.test(runId)) return [];
  const text = (await store.readText(ws, path.join('workflow/runs', runId, 'events.jsonl'))) ?? '';
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
