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
// Fake npm: "installs" whatever package.json declares into node_modules.
const FAKE_NPM = path.join(tmp, 'fake-npm');
writeFileSync(FAKE_NPM, `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
  fs.mkdirSync(path.join('node_modules', name), { recursive: true });
  fs.writeFileSync(path.join('node_modules', name, 'package.json'), JSON.stringify({ name }));
}
console.log('installed with args: ' + process.argv.slice(2).join(' '));
`);
chmodSync(FAKE_NPM, 0o755);

const env = {
  ...process.env,
  AISDLC_NPM_BIN: FAKE_NPM,
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
  assert.equal(s.stages.implementation.status, 'READY');
  assert.equal(gitCount(), 5, 'one checkpoint commit per approved gate');
});

const runOf = async (stage: string) => (await state()).stages[stage].lastRunId as string;
const promptOf = async (stage: string) => readFileSync(path.join(ws(), 'workflow/runs', await runOf(stage), 'prompt.md'), 'utf8');
async function run(stage: string) {
  const r = await post(`/api/stages/${stage}/run`);
  assert.equal(r.status, 202, `${stage} starts: ${r.body.error ?? ''}`);
  await waitIdle();
  return (await state()).stages[stage];
}
const passes = async (stage: string) => {
  const st = await run(stage);
  assert.equal(st.status, 'PASS', `${stage}: ${st.blockers.join('; ')}`);
};

test('packages from git, file or URL specs are refused', async () => {
  modes({ codex: 'bad-dep' });
  await run('implementation');
  modes({});
  const deps = (await get('/api/overview')).body.dependencies;
  assert.ok(deps.refused.some((x: string) => x.startsWith('evil@git+https')));
  const r = await post('/api/dependencies/install');
  assert.equal(r.status, 409);
  assert.match(r.body.error, /only registry packages/);
});

test('the engineer asks for a package and a human installs it, scripts disabled', async () => {
  modes({ codex: 'needs-dep' });
  const st = await run('implementation');
  modes({});
  assert.equal(st.status, 'FAIL');
  assert.ok(st.blockers.some((b: string) => b.includes('Needs package install: left-pad')));
  const deps = (await get('/api/overview')).body.dependencies;
  assert.deepEqual(deps.missing.map((d: any) => d.name), ['left-pad']);
  const r = await post('/api/dependencies/install');
  assert.equal(r.status, 200, r.body.error);
  assert.ok(existsSync(path.join(ws(), 'node_modules/left-pad/package.json')));
  assert.match(readFileSync(path.join(ws(), '.gitignore'), 'utf8'), /^node_modules\/$/m);
  assert.match(readFileSync(path.join(ws(), r.body.log), 'utf8'), /--ignore-scripts/);
  assert.equal((await post('/api/dependencies/install')).status, 409, 'nothing left to install');
});

test('the engineer cannot change other roles\' files: changes are reverted and the run fails', async () => {
  const prd = readFileSync(path.join(ws(), 'product/prd.md'), 'utf8');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ws() }).toString();
  modes({ codex: 'tamper' });
  const st = await run('implementation');
  assert.equal(st.status, 'FAIL');
  assert.ok(st.blockers.some((b: string) => b.includes('modified product/prd.md')));
  assert.equal(readFileSync(path.join(ws(), 'product/prd.md'), 'utf8'), prd, 'PRD restored byte for byte');
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ws() }).toString(), head, 'no commits by the engineer');
  modes({});
});

test('the engineer cannot pass with a failing test suite: the Control Center runs it', async () => {
  modes({ codex: 'break-tests' });
  const st = await run('implementation');
  assert.equal(st.status, 'FAIL');
  assert.ok(st.blockers.some((b: string) => b.includes('Test suite passes')));
  modes({});
});

test('a passing implementation writes notes and opens code review', async () => {
  const st = await run('implementation');
  assert.equal(st.status, 'PASS', st.blockers.join('; '));
  // Regression: the previous attempt's blockers must reach the next prompt.
  assert.match(await promptOf('implementation'), /## Blockers from your previous attempt[\s\S]*Test suite passes/);
  const notes = readFileSync(path.join(ws(), 'engineering/implementation-notes.md'), 'utf8');
  assert.match(notes, /Test suite \(run by the Control Center in a sandbox\): Test suite passed/);
  assert.match(notes, /src\/app\.js/);
  const s = await state();
  assert.equal(s.currentStage, 'code-review');
  assert.equal(s.stages['code-review'].status, 'READY');
});

test('a FAIL review sends actionable blockers back to the engineer, who receives the report', async () => {
  modes({ claude: 'verdict-fail' });
  const cr = await run('code-review');
  assert.equal(cr.status, 'FAIL');
  assert.match(await promptOf('code-review'), /the whole implementation/);
  assert.match(await promptOf('code-review'), /Test suite passed/);
  assert.ok(existsSync(path.join(ws(), 'engineering/code-review.md')), 'a FAIL report is still written');
  let s = await state();
  assert.equal(s.currentStage, 'implementation');
  modes({});
  const im = await run('implementation');
  assert.equal(im.status, 'PASS');
  const prompt = await promptOf('implementation');
  assert.match(prompt, /Blockers from Code review \(fix these\)/);
  assert.match(prompt, /AC-1 is not met/);
  s = await state();
  assert.equal(s.currentStage, 'code-review');
});

test('a reviewer FAIL without actionable blockers fails the review itself, not the engineer', async () => {
  modes({ claude: 'fail-no-blockers' });
  const cr = await run('code-review');
  assert.equal(cr.status, 'FAIL');
  assert.ok(cr.blockers.some((b: string) => b.includes('without actionable blockers')));
  const s = await state();
  assert.equal(s.currentStage, 'code-review');
  assert.equal(s.stages.implementation.status, 'PASS');
  modes({});
});

test('a re-review sees only the fix and its previous report', async () => {
  const cr = await run('code-review');
  assert.equal(cr.status, 'PASS', cr.blockers.join('; '));
  const prompt = await promptOf('code-review');
  assert.match(prompt, /only the changes since your last review/);
  assert.match(prompt, /## Your previous review/);
  assert.match(prompt, /fix run: true/, 'the fix diff is included');
  assert.doesNotMatch(prompt, /package\.json \|/, 'unchanged files are not in the fix diff');
});

test('a QA FAIL goes back through the engineer and code review before QA runs again', async () => {
  modes({ claude: 'verdict-fail' });
  assert.equal((await run('engineering-qa')).status, 'FAIL');
  modes({});
  assert.equal((await state()).currentStage, 'implementation');
  await passes('implementation');
  assert.equal((await state()).currentStage, 'code-review');
  await passes('code-review');
  await passes('engineering-qa');
  assert.match(await promptOf('engineering-qa'), /the whole implementation/, 'QA always sees everything');
  await passes('design-qa');
  const dq = await promptOf('design-qa');
  assert.match(dq, /Prototype S1, mobile: `workflow\/runs\/[\w-]+\/screens\/prototype-S1-mobile\.png`/);
  assert.match(dq, /App S1 \(\/\), desktop/);
  assert.match(dq, /Static app served from public\//);
  const shot = dq.match(/`(workflow\/runs\/[\w-]+\/screens\/app-S1-mobile\.png)`/)![1];
  const img = await fetch(`${BASE}/api/image?path=${encodeURIComponent(shot)}`);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(`${BASE}/api/image?path=product/prd.md`)).status, 400, 'only screenshots are served as images');
  const s = await state();
  assert.equal(s.currentStage, 'product-review');
  assert.equal(gitCount(), 5, 'the engineering loop never commits');
});

test('a blocked product review keeps its report and lets the human choose where work goes back', async () => {
  modes({ claude: 'verdict-fail' });
  const pr = await run('product-review');
  modes({});
  assert.equal(pr.status, 'FAIL');
  assert.ok(existsSync(path.join(ws(), 'product/product-review.md')), 'the blocking report is kept');
  assert.equal((await post('/api/stages/product-definition/reopen', { reason: ' ' })).body.code, 'feedback_required');
  assert.equal((await post('/api/stages/product-review/reopen', { reason: 'x' })).body.code, 'not_earlier');
  const r = await post('/api/stages/product-definition/reopen', { reason: 'Success metric M2 cannot be measured.' });
  assert.equal(r.status, 200);
  assert.equal((await state()).currentStage, 'product-definition');
  await runToGate('product-definition', 'prd-approval');
  assert.match(await promptOf('product-definition'), /Reopened by a human: Success metric M2 cannot be measured\./);
});

test('after the full loop, final approval ships and tags the release', async () => {
  for (const [stage, gate] of [['product-definition', 'prd-approval'], ['product-design', 'design-approval'], ['tech-design', 'tech-approval']]) {
    if ((await state()).stages[gate].status !== 'APPROVAL_REQUIRED') await runToGate(stage, gate);
    await post(`/api/gates/${gate}/decision`, { decision: 'APPROVED' });
  }
  for (const stage of ['implementation', 'code-review', 'engineering-qa', 'design-qa', 'product-review']) await passes(stage);
  assert.equal((await state()).stages['final-approval'].status, 'APPROVAL_REQUIRED');
  const r = await post('/api/gates/final-approval/decision', { decision: 'APPROVED' });
  assert.equal(r.status, 200);
  const s = await state();
  assert.equal(s.currentStage, 'ship');
  assert.equal(s.stages.ship.status, 'PASS');
  const tags = execFileSync('git', ['tag'], { cwd: ws() }).toString();
  assert.match(tags, /^ready-to-ship-\d{8}-\d{4}$/m);
});
