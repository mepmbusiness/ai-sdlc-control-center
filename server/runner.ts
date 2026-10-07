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

const RUN_TIMEOUT_MS = { produce: 20 * 60_000, check: 10 * 60_000 };
const children = new Map<string, ChildProcess>();
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

async function inputsSection(ws: string, files: string[]): Promise<string> {
  const parts: string[] = [];
  for (const rel of files) {
    const text = await store.readText(ws, rel);
    parts.push(`### ${rel}\n\n${text ?? '_(missing)_'}`);
  }
  return parts.join('\n\n');
}

async function producerPrompt(ws: string, wf: Workflow, state: WorkflowState, def: StageDef): Promise<string> {
  const contract = await store.loadContract(ws, def.agent!);
  const gate = wf.stages.find((s) => s.kind === 'gate' && s.reviews === def.id);
  const decision = gate ? state.stages[gate.id].decision : null;
  const st = state.stages[def.id];

  const sections = [
    contract.body,
    '---',
    `## Input artifacts\n\n${await inputsSection(ws, def.inputs ?? [])}`,
  ];
  if (decision?.decision === 'REJECTED' && decision.feedback) {
    sections.push(
      `## Human feedback on your previous version\n\nA human rejected the previous version with this feedback. Address it explicitly.\n\n> ${decision.feedback.replace(/\n/g, '\n> ')}`,
      `## Your previous version\n\n${await inputsSection(ws, def.outputs ?? [])}`,
    );
  }
  if (st.status === 'FAIL' && st.blockers.length) {
    sections.push(`## Blockers from your previous attempt\n\n${st.blockers.map((b) => `- ${b}`).join('\n')}`);
  }
  const required = requiredSections(contract, def);
  const files = (def.outputs ?? [])
    .map((o) => `- \`${o}\`${required[o]?.length ? `: level-2 headings ${required[o].map((h) => `"${h}"`).join(', ')}` : ''}`)
    .join('\n');
  sections.push(
    '## How to answer',
    'Do not create or edit files. Return your result as the structured response: `status`, `summary`, ' +
      '`artifacts` (one entry per file below, with the exact path and the complete content) and `blockers`.',
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

export async function startProduce(ws: string, stageId: string): Promise<string> {
  const wf = await store.loadWorkflow(ws);
  let state = await store.loadState(ws);
  const pf = await preflight(ws, wf, state, stageId, 'produce');
  if (!pf.ok) {
    throw new engine.EngineError('preflight_failed', pf.items.filter((i) => !i.ok).map((i) => `${i.label}: ${i.detail}`).join(' | '));
  }
  const def = engine.stageDef(wf, stageId);
  const agent = wf.agents[def.agent!];
  const runId = newRunId(stageId, 'produce');
  const runDir = `workflow/runs/${runId}`;
  const prompt = await producerPrompt(ws, wf, state, def);
  // Validated before the run is recorded, so an unsafe contract never leaves a stage stuck in RUNNING.
  const toolset = agent.cli === 'claude' ? producerToolset(await store.loadContract(ws, def.agent!)) : undefined;

  state = engine.startRun(state, wf, stageId, runId, now());
  await store.saveState(ws, state);
  await store.writeText(ws, `${runDir}/prompt.md`, prompt);
  await store.appendActivity(ws, {
    ts: now(), actor: 'agent', event: 'run_started', stage: stageId, agent: def.agent, cli: agent.cli, runId,
    inputs: def.inputs, message: `${agent.tool} started ${def.label} (${agent.label})`,
  });

  const schema = JSON.parse((await store.readText(ws, 'workflow/schemas/producer.schema.json'))!);
  delete schema.$id;
  delete schema.description;
  const child = spawnCli({
    cli: agent.cli,
    cwd: ws,
    prompt,
    schema,
    schemaPath: store.safeJoin(ws, 'workflow/schemas/producer.schema.json'),
    lastMessagePath: store.safeJoin(ws, `${runDir}/last-message.json`),
    tools: toolset?.tools,
    allowedTools: toolset?.allowed,
  });
  children.set(runId, child);
  const startedAt = state.stages[stageId].startedAt!;
  const logFile = store.safeJoin(ws, `${runDir}/events.jsonl`);

  collect(child, logFile, agent.cli, runId, def.timeoutMinutes ? def.timeoutMinutes * 60_000 : RUN_TIMEOUT_MS.produce)
    .then((r) => store.withLock(() => finishProduce(ws, wf, def, runId, startedAt, r)))
    .catch((err) => console.error(`[run ${runId}]`, err));
  return runId;
}

async function finishProduce(
  ws: string,
  wf: Workflow,
  def: StageDef,
  runId: string,
  startedAt: string,
  r: { code: number | null; stdout: string; stderr: string; timedOut: boolean },
) {
  const runDir = `workflow/runs/${runId}`;
  const agent = wf.agents[def.agent!];
  await store.writeText(ws, `${runDir}/stdout.jsonl`, r.stdout);
  if (r.stderr.trim()) await store.writeText(ws, `${runDir}/stderr.log`, r.stderr);

  let status: 'PASS' | 'FAIL' = 'FAIL';
  let summary: string | null = null;
  let blockers: string[] = [];
  let checks: { name: string; ok: boolean; detail: string }[] = [];
  const outputs: string[] = [];

  const parsed =
    r.code !== 0 || r.timedOut
      ? { output: null, error: failureReason(r, runId) }
      : agent.cli === 'claude'
        ? extractClaudeResult(r.stdout)
        : await readCodexOutput(store.safeJoin(ws, `${runDir}/last-message.json`));

  if (parsed.error) {
    blockers = [parsed.error];
    summary = 'The agent run did not complete.';
  } else {
    const out = parsed.output as { status: 'PASS' | 'FAIL'; summary: string; artifacts: Artifact[]; blockers: string[] };
    const contract = await store.loadContract(ws, def.agent!);
    const artifacts = (out.artifacts ?? []).map((a) => ({ path: a.path.replace(/^\.\//, ''), content: a.content }));
    checks = artifactChecks(artifacts, def.outputs ?? [], requiredSections(contract, def));
    const failed = checks.filter((c) => !c.ok).map((c) => `Check failed: ${c.name}${c.detail ? ` (${c.detail})` : ''}`);
    summary = out.summary;
    blockers = [...(out.blockers ?? []), ...failed];
    status = out.status === 'PASS' && failed.length === 0 ? 'PASS' : 'FAIL';
    for (const a of artifacts) {
      if (!(def.outputs ?? []).includes(a.path) || !a.content.trim()) continue;
      // On FAIL keep drafts inside the run folder, never overwriting the last good artifact.
      const target = status === 'PASS' ? a.path : `${runDir}/draft/${a.path}`;
      await store.writeText(ws, target, a.content.trimEnd() + '\n');
      outputs.push(target);
    }
  }

  const completedAt = now();
  await store.writeJson(ws, `${runDir}/handoff.json`, {
    protocol: 'aisdlc.handoff/v1',
    runId,
    stage: def.id,
    agent: def.agent,
    cli: agent.cli,
    status,
    summary: summary ?? '',
    outputs,
    blockers,
    checks,
    next: status === 'PASS' ? def.next ?? null : null,
    returnTo: status === 'FAIL' ? def.returnTo ?? def.id : null,
    startedAt,
    completedAt,
  });

  let state = await store.loadState(ws);
  state = engine.completeRun(state, wf, runId, { status, summary, blockers }, completedAt);
  await store.saveState(ws, state);
  await store.appendActivity(ws, {
    ts: completedAt, actor: 'agent', event: 'run_finished', stage: def.id, agent: def.agent, cli: agent.cli, runId,
    result: state.stages[def.id].status, outputs, blockers,
    message: `${def.label} ${state.stages[def.id].status}${outputs.length && status === 'PASS' ? `, ${outputs.join(', ')} written` : ''}`,
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
  if (!child) return false;
  cancelled.add(runId);
  child.kill('SIGTERM');
  return true;
}

export async function readRunLog(ws: string, runId: string): Promise<{ ts: string; msg: string }[]> {
  if (!/^[\w-]+$/.test(runId)) return [];
  const text = (await store.readText(ws, path.join('workflow/runs', runId, 'events.jsonl'))) ?? '';
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
