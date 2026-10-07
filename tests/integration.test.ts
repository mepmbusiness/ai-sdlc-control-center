// End-to-end tests of the HTTP server with fake CLIs (no subscription quota used).
// Covers the vertical slice: idea -> discovery -> independent check -> gate,
// plus the failure scenarios: missing login, CLI crash, failed quality gate,
// rejection, cancellation and a server restart during a run.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 4391;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = mkdtempSync(path.join(tmpdir(), 'aisdlc-'));
const WORKSPACES = path.join(tmp, 'workspaces');
const MODE_FILE = path.join(tmp, 'modes.json');
let server: ChildProcess;

function wrapper(flavor: string) {
  const file = path.join(tmp, `fake-${flavor}`);
  writeFileSync(file, `#!/bin/sh\nexec node "${ROOT}/scripts/fake-cli.mjs" ${flavor} "$@"\n`);
  chmodSync(file, 0o755);
  return file;
}
const env = {
  ...process.env,
  PORT: String(PORT),
  AISDLC_WORKSPACES: WORKSPACES,
  AISDLC_CLAUDE_BIN: wrapper('claude'),
  AISDLC_CODEX_BIN: wrapper('codex'),
  AISDLC_CLI_CACHE_MS: '0',
  FAKE_MODE_FILE: MODE_FILE,
};
const modes = (m: { claude?: string; codex?: string }) => writeFileSync(MODE_FILE, JSON.stringify({ claude: 'pass', codex: 'pass', ...m }));

async function startServer() {
  server = spawn(process.execPath, ['server/index.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    server.stdout!.on('data', (d) => d.toString().includes('running at') && resolve());
    server.on('exit', (c) => reject(new Error(`server exited ${c}`)));
  });
}
async function stopServer() {
  server.kill('SIGKILL');
  await new Promise((r) => server.once('exit', r));
}

async function call(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(BASE + p.replace(BASE, ''), {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}
const get = (p: string) => call('GET', p);
const post = (p: string, b: unknown = {}) => call('POST', p, b);
const state = async () => (await get('/api/overview')).body.state;
async function waitIdle() {
  for (let i = 0; i < 100; i++) {
    if (!(await state()).activeRun) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('run did not finish');
}
const ws = () => path.join(WORKSPACES, 'meal-planner');
const gitCount = () => Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: ws() }).toString());

before(async () => {
  modes({});
  await startServer();
});
after(async () => {
  await stopServer();
  rmSync(tmp, { recursive: true, force: true });
});

test('creating a product writes idea.md, initial state and a first commit', async () => {
  assert.equal((await get('/api/overview')).body.project, null);
  assert.equal((await post('/api/products', { name: 'Meal planner' })).status, 400);
  const r = await post('/api/products', { name: 'Meal planner', idea: 'People waste food.', context: '' });
  assert.equal(r.status, 201);
  assert.match(readFileSync(path.join(ws(), 'product/idea.md'), 'utf8'), /People waste food/);
  assert.equal((await state()).stages.discovery.status, 'READY');
  assert.equal(gitCount(), 1);
  assert.equal((await post('/api/products', { name: 'Other', idea: 'x' })).status, 409, 'one product at a time');
});

test('security: only local JSON requests are accepted and paths cannot escape', async () => {
  assert.equal((await call('POST', '/api/products', {}, { 'content-type': 'text/plain' })).status, 415);
  const rebinding = await new Promise<number>((resolve) =>
    http.get({ host: '127.0.0.1', port: PORT, path: '/api/overview', headers: { host: 'evil.example' } }, (res) => resolve(res.statusCode!)),
  );
  assert.equal(rebinding, 403, 'DNS rebinding: foreign Host header refused');
  assert.equal((await call('POST', '/api/stages/discovery/run', {}, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await get('/api/artifact?path=../../package.json')).status, 400);
});

test('a gate cannot be decided before its artifact exists', async () => {
  const r = await post('/api/gates/discovery-approval/decision', { decision: 'APPROVED' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'not_pending');
});

test('a logged-out CLI blocks the run in preflight', async () => {
  modes({ claude: 'logged-out' });
  const pf = (await get('/api/preflight?stage=discovery&purpose=produce')).body;
  assert.equal(pf.ok, false);
  assert.ok(pf.items.some((i: any) => i.label.includes('signed in') && !i.ok));
  const r = await post('/api/stages/discovery/run');
  assert.equal(r.status, 409);
  assert.match(r.body.error, /signed in/);
  modes({});
});

test('a crashing CLI marks the stage FAIL with the error as a blocker', async () => {
  modes({ claude: 'crash' });
  assert.equal((await post('/api/stages/discovery/run')).status, 202);
  await waitIdle();
  const s = await state();
  assert.equal(s.stages.discovery.status, 'FAIL');
  assert.match(s.stages.discovery.blockers[0], /exited with code 2.*simulated CLI crash/);
  modes({});
});

test('a missing required section fails the quality gate and keeps only a draft', async () => {
  modes({ claude: 'missing-section' });
  await post('/api/stages/discovery/run');
  await waitIdle();
  const s = await state();
  assert.equal(s.stages.discovery.status, 'FAIL');
  assert.ok(s.stages.discovery.blockers.some((b: string) => b.includes('product/discovery.md: Section "Open questions"')));
  assert.equal(existsSync(path.join(ws(), 'product/discovery.md')), false);
  assert.ok(existsSync(path.join(ws(), 'workflow/runs', s.stages.discovery.lastRunId, 'draft/product/discovery.md')));
  modes({});
});

test('a passing run writes the artifact and a handoff record, then opens the gate', async () => {
  const run = (await post('/api/stages/discovery/run')).body.runId;
  await waitIdle();
  const s = await state();
  assert.equal(s.stages.discovery.status, 'PASS');
  assert.equal(s.stages['discovery-approval'].status, 'APPROVAL_REQUIRED');
  assert.match(readFileSync(path.join(ws(), 'product/discovery.md'), 'utf8'), /## Hypotheses/);
  const handoff = JSON.parse(readFileSync(path.join(ws(), 'workflow/runs', run, 'handoff.json'), 'utf8'));
  assert.equal(handoff.protocol, 'aisdlc.handoff/v1');
  assert.equal(handoff.status, 'PASS');
  assert.equal(handoff.next, 'discovery-approval');
  assert.deepEqual(handoff.outputs, ['product/discovery.md']);
  assert.ok(handoff.checks.every((c: any) => c.ok));
  const log = (await get(`/api/runs/${run}/log`)).body;
  assert.ok(log.some((l: any) => l.msg.includes('WebSearch')));
  assert.equal((await post('/api/stages/product-definition/run')).status, 409, 'next stage stays locked');
});

test('the independent check is stored and does not block the gate', async () => {
  modes({ codex: 'fail' });
  assert.equal((await post('/api/gates/discovery-approval/check')).status, 202);
  await waitIdle();
  const s = await state();
  assert.equal(s.stages['discovery-approval'].check.status, 'CONCERNS');
  assert.equal(s.stages['discovery-approval'].status, 'APPROVAL_REQUIRED');
  assert.match(readFileSync(path.join(ws(), 'workflow/checks/discovery-approval.md'), 'utf8'), /\[HIGH\] Unsourced fact/);
  modes({});
});

test('rejection needs feedback, is persisted, and the feedback reaches the next run', async () => {
  const empty = await post('/api/gates/discovery-approval/decision', { decision: 'REJECTED', feedback: ' ' });
  assert.equal(empty.body.code, 'feedback_required');
  const r = await post('/api/gates/discovery-approval/decision', { decision: 'REJECTED', feedback: 'Add competitor pricing.' });
  assert.equal(r.status, 200);
  let s = await state();
  assert.equal(s.stages['discovery-approval'].status, 'REJECTED');
  assert.equal(s.stages.discovery.status, 'READY');
  const approvals = JSON.parse(readFileSync(path.join(ws(), 'workflow/approvals/discovery-approval.json'), 'utf8'));
  assert.equal(approvals[0].decision, 'REJECTED');
  assert.equal(approvals[0].feedback, 'Add competitor pricing.');
  assert.ok(approvals[0].decidedAt);
  assert.equal(gitCount(), 1, 'rejections do not create checkpoint commits');

  const run = (await post('/api/stages/discovery/run')).body.runId;
  await waitIdle();
  s = await state();
  assert.match(readFileSync(path.join(ws(), 'workflow/runs', run, 'prompt.md'), 'utf8'), /Add competitor pricing\./);
  assert.match(s.stages.discovery.summary, /Addressed human feedback/);
  assert.equal(s.stages['discovery-approval'].status, 'APPROVAL_REQUIRED');
  assert.equal(s.stages['discovery-approval'].check, null, 'new version needs a new check');
});

test('cancelling a run marks it FAIL', async () => {
  // Undo the approval-required state by rejecting, so discovery can run again.
  await post('/api/gates/discovery-approval/decision', { decision: 'REJECTED', feedback: 'One more pass.' });
  modes({ claude: 'slow' });
  const run = (await post('/api/stages/discovery/run')).body.runId;
  assert.equal((await post(`/api/runs/${run}/cancel`)).status, 202);
  await waitIdle();
  const s = await state();
  assert.equal(s.stages.discovery.status, 'FAIL');
  assert.deepEqual(s.stages.discovery.blockers, ['Cancelled by the user.']);
  modes({});
});

test('a server restart during a run closes it as FAIL instead of hanging', async () => {
  modes({ claude: 'slow' });
  await post('/api/stages/discovery/run');
  await stopServer();
  modes({});
  await startServer();
  const s = await state();
  assert.equal(s.activeRun, null);
  assert.equal(s.stages.discovery.status, 'FAIL');
  assert.ok(s.stages.discovery.blockers.some((b: string) => b.includes('restarted')));
});

test('approval unlocks the next stage and creates a checkpoint commit', async () => {
  await post('/api/stages/discovery/run');
  await waitIdle();
  const r = await post('/api/gates/discovery-approval/decision', { decision: 'APPROVED' });
  assert.equal(r.status, 200);
  assert.ok(r.body.commit);
  const s = await state();
  assert.equal(s.stages['discovery-approval'].status, 'APPROVED');
  assert.equal(s.currentStage, 'product-definition');
  assert.equal(gitCount(), 2);
  const msg = execFileSync('git', ['log', '-1', '--format=%B'], { cwd: ws() }).toString();
  assert.match(msg, /^Approve Discovery/);
  const activity = (await get('/api/activity')).body.map((e: any) => e.event);
  for (const ev of ['product_created', 'run_started', 'run_finished', 'check_finished', 'gate_rejected', 'gate_approved', 'checkpoint_commit', 'run_interrupted']) {
    assert.ok(activity.includes(ev), `activity has ${ev}`);
  }
});

async function runToGate(stage: string, gate: string) {
  assert.equal((await post(`/api/stages/${stage}/run`)).status, 202, `${stage} starts`);
  await waitIdle();
  const s = await state();
  assert.equal(s.stages[stage].status, 'PASS', `${stage}: ${s.stages[stage].blockers.join('; ')}`);
  assert.equal(s.stages[gate].status, 'APPROVAL_REQUIRED');
}

test('a file outside the declared outputs fails the stage and is never written', async () => {
  modes({ claude: 'extra-file' });
  await post('/api/stages/product-definition/run');
  await waitIdle();
  const s = await state();
  assert.equal(s.stages['product-definition'].status, 'FAIL');
  assert.ok(s.stages['product-definition'].blockers.some((b: string) => b.includes('src/sneaky.js is not an output')));
  assert.equal(existsSync(path.join(ws(), 'src/sneaky.js')), false);
  modes({});
});

test('a contract that asks for write tools is refused before anything runs', async () => {
  const file = path.join(ws(), 'agents/product-manager.md');
  const original = readFileSync(file, 'utf8');
  writeFileSync(file, original.replace('tools: [Read, Grep, Glob]', 'tools: [Read, Write, Bash]'));
  const r = await post('/api/stages/product-definition/run');
  writeFileSync(file, original);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'unsafe_contract');
  assert.equal((await state()).stages['product-definition'].status, 'FAIL', 'stage left as it was, not RUNNING');
});

test('PRD, design and tech design each pass through their own gate', async () => {
  await runToGate('product-definition', 'prd-approval');
  await post('/api/gates/prd-approval/check');
  await waitIdle();
  await post('/api/gates/prd-approval/decision', { decision: 'APPROVED' });

  await runToGate('product-design', 'design-approval');
  for (const f of ['design/design-spec.md', 'design/design-system.md', 'design/prototype/index.html']) {
    assert.ok(existsSync(path.join(ws(), f)), `${f} written`);
  }
  const prompt = readFileSync(path.join(ws(), 'workflow/runs', (await state()).stages['product-design'].lastRunId, 'prompt.md'), 'utf8');
  assert.match(prompt, /### product\/prd\.md/, 'designer receives the approved PRD');
  await post('/api/gates/design-approval/decision', { decision: 'APPROVED' });
  const record = JSON.parse(readFileSync(path.join(ws(), 'workflow/approvals/design-approval.json'), 'utf8'))[0];
  const html = readFileSync(path.join(ws(), 'design/prototype/index.html'), 'utf8');
  assert.equal(record.artifacts.find((a: any) => a.path === 'design/prototype/index.html').sha256, createHash('sha256').update(html).digest('hex'));

  await runToGate('tech-design', 'tech-approval');
  assert.ok(existsSync(path.join(ws(), 'engineering/implementation-plan.md')));
  await post('/api/gates/tech-approval/decision', { decision: 'APPROVED' });
  const s = await state();
  assert.equal(s.currentStage, 'implementation');
  assert.equal(s.stages.implementation.status, 'WAITING', 'implementation arrives in v0.3');
  assert.equal(gitCount(), 5, 'one checkpoint commit per approved gate');
});
