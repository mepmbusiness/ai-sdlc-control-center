import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  initialState,
  runBlockers,
  startRun,
  completeRun,
  startCheck,
  completeCheck,
  decideGate,
  unblock,
  interruptActiveRun,
  reconcile,
  reopen,
  environmentChanged,
  EngineError,
  type Workflow,
} from '../server/engine.ts';

const wf: Workflow = JSON.parse(readFileSync(new URL('../templates/workflow.json', import.meta.url), 'utf8'));
const T = '2026-10-07T12:00:00.000Z';
const fresh = () => initialState(wf, { name: 'Demo', slug: 'demo' }, T);

function throwsCode(fn: () => unknown, code: string) {
  assert.throws(fn, (e: unknown) => e instanceof EngineError && e.code === code);
}

test('a new product starts with the idea done and discovery ready', () => {
  const s = fresh();
  assert.equal(s.stages.idea.status, 'PASS');
  assert.equal(s.stages.discovery.status, 'READY');
  assert.equal(s.currentStage, 'discovery');
  assert.equal(s.stages['product-definition'].status, 'WAITING');
});

test('discovery PASS opens the human gate, it does not skip it', () => {
  let s = startRun(fresh(), wf, 'discovery', 'r1', T);
  assert.equal(s.stages.discovery.status, 'RUNNING');
  s = completeRun(s, wf, 'r1', { status: 'PASS', summary: 'ok', blockers: [] }, T);
  assert.equal(s.stages.discovery.status, 'PASS');
  assert.equal(s.stages['discovery-approval'].status, 'APPROVAL_REQUIRED');
  assert.equal(s.currentStage, 'discovery-approval');
  assert.equal(s.stages['product-definition'].status, 'WAITING');
});

test('the next stage cannot run until the gate is approved', () => {
  let s = startRun(fresh(), wf, 'discovery', 'r1', T);
  s = completeRun(s, wf, 'r1', { status: 'PASS', summary: null, blockers: [] }, T);
  const reasons = runBlockers(s, wf, 'product-definition');
  assert.ok(reasons.some((r) => r.includes('not ready')));
});

test('only one agent runs at a time', () => {
  const s = startRun(fresh(), wf, 'discovery', 'r1', T);
  throwsCode(() => startRun(s, wf, 'discovery', 'r2', T), 'not_runnable');
  assert.ok(runBlockers(s, wf, 'discovery').some((r) => r.includes('Only one agent')));
});

test('rejecting a gate requires feedback and sends the work back to its author', () => {
  let s = startRun(fresh(), wf, 'discovery', 'r1', T);
  s = completeRun(s, wf, 'r1', { status: 'PASS', summary: null, blockers: [] }, T);
  throwsCode(() => decideGate(s, wf, 'discovery-approval', 'REJECTED', '  ', T), 'feedback_required');
  s = decideGate(s, wf, 'discovery-approval', 'REJECTED', 'Missing competitors', T);
  assert.equal(s.stages['discovery-approval'].status, 'REJECTED');
  assert.equal(s.stages['discovery-approval'].decision?.feedback, 'Missing competitors');
  assert.equal(s.stages['discovery-approval'].decision?.artifactRunId, 'r1');
  assert.equal(s.stages.discovery.status, 'READY');
  assert.equal(s.currentStage, 'discovery');
  // A rejected gate cannot be approved until the author produces a new version.
  throwsCode(() => decideGate(s, wf, 'discovery-approval', 'APPROVED', null, T), 'not_pending');
});

test('a re-run after rejection reopens the gate with a clean critique', () => {
  let s = startRun(fresh(), wf, 'discovery', 'r1', T);
  s = completeRun(s, wf, 'r1', { status: 'PASS', summary: null, blockers: [] }, T);
  s = startCheck(s, wf, 'discovery-approval', 'c1', T);
  s = completeCheck(s, 'c1', { status: 'CONCERNS', summary: 'x', findings: 2 }, T);
  s = decideGate(s, wf, 'discovery-approval', 'REJECTED', 'Fix it', T);
  s = startRun(s, wf, 'discovery', 'r2', T);
  s = completeRun(s, wf, 'r2', { status: 'PASS', summary: null, blockers: [] }, T);
  assert.equal(s.stages['discovery-approval'].status, 'APPROVAL_REQUIRED');
  assert.equal(s.stages['discovery-approval'].check, null);
  assert.equal(s.stages['discovery-approval'].decision, null);
});

test('approving the gate moves to the next stage', () => {
  let s = startRun(fresh(), wf, 'discovery', 'r1', T);
  s = completeRun(s, wf, 'r1', { status: 'PASS', summary: null, blockers: [] }, T);
  s = decideGate(s, wf, 'discovery-approval', 'APPROVED', null, T);
  assert.equal(s.stages['discovery-approval'].status, 'APPROVED');
  assert.equal(s.currentStage, 'product-definition');
});

test('a gate cannot be decided while its critic is running', () => {
  let s = startRun(fresh(), wf, 'discovery', 'r1', T);
  s = completeRun(s, wf, 'r1', { status: 'PASS', summary: null, blockers: [] }, T);
  s = startCheck(s, wf, 'discovery-approval', 'c1', T);
  throwsCode(() => decideGate(s, wf, 'discovery-approval', 'APPROVED', null, T), 'busy');
});

test('the critique is advisory: CONCERNS does not block approval', () => {
  let s = startRun(fresh(), wf, 'discovery', 'r1', T);
  s = completeRun(s, wf, 'r1', { status: 'PASS', summary: null, blockers: [] }, T);
  s = startCheck(s, wf, 'discovery-approval', 'c1', T);
  s = completeCheck(s, 'c1', { status: 'CONCERNS', summary: 'x', findings: 3 }, T);
  s = decideGate(s, wf, 'discovery-approval', 'APPROVED', null, T);
  assert.equal(s.stages['discovery-approval'].status, 'APPROVED');
  assert.equal(s.stages['discovery-approval'].check?.status, 'CONCERNS');
});

test('repeated failures block the stage until a human unblocks it', () => {
  let s = fresh();
  for (let i = 1; i <= wf.maxConsecutiveFailures; i++) {
    s = startRun(s, wf, 'discovery', `r${i}`, T);
    s = completeRun(s, wf, `r${i}`, { status: 'FAIL', summary: null, blockers: ['vague idea'] }, T);
  }
  assert.equal(s.stages.discovery.status, 'BLOCKED');
  throwsCode(() => startRun(s, wf, 'discovery', 'rX', T), 'not_runnable');
  s = unblock(s, wf, 'discovery', T);
  assert.equal(s.stages.discovery.status, 'READY');
  assert.equal(s.stages.discovery.consecutiveFailures, 0);
});

test('an engineering FAIL routes back to the software engineer', () => {
  // Engineering stages are disabled in this slice; enable them for the rule test.
  const all: Workflow = { ...wf, stages: wf.stages.map((d) => ({ ...d, enabled: true })) };
  let s = initialState(all, { name: 'Demo', slug: 'demo' }, T);
  s.stages['code-review'].status = 'READY';
  s.currentStage = 'code-review';
  s = startRun(s, all, 'code-review', 'cr1', T);
  s = completeRun(s, all, 'cr1', { status: 'FAIL', summary: null, blockers: ['AC #3 not met'] }, T);
  assert.equal(s.stages['code-review'].status, 'FAIL');
  assert.deepEqual(s.stages['code-review'].blockers, ['AC #3 not met']);
  assert.equal(s.stages.implementation.status, 'READY');
  assert.equal(s.currentStage, 'implementation');
});

test('a run interrupted by a server restart is closed as a failure', () => {
  let s = startRun(fresh(), wf, 'discovery', 'r1', T);
  s = interruptActiveRun(s, wf, 'Server restarted during the run.', T);
  assert.equal(s.activeRun, null);
  assert.equal(s.stages.discovery.status, 'FAIL');
  assert.deepEqual(s.stages.discovery.blockers, ['Server restarted during the run.']);
});

test('disabled stages explain why they cannot run', () => {
  const partial: Workflow = { ...wf, stages: wf.stages.map((d) => (d.id === 'discovery' ? { ...d, enabled: false } : d)) };
  const reasons = runBlockers(initialState(partial, { name: 'Demo', slug: 'demo' }, T), partial, 'discovery');
  assert.ok(reasons.some((r) => r.includes('not available')));
});

test('reconcile makes the current stage runnable once a new version enables it', () => {
  const old: Workflow = { ...wf, stages: wf.stages.map((d) => (d.id === 'product-definition' ? { ...d, enabled: false } : d)) };
  let s = startRun(initialState(old, { name: 'Demo', slug: 'demo' }, T), old, 'discovery', 'r1', T);
  s = completeRun(s, old, 'r1', { status: 'PASS', summary: null, blockers: [] }, T);
  s = decideGate(s, old, 'discovery-approval', 'APPROVED', null, T);
  assert.equal(s.stages['product-definition'].status, 'WAITING');
  s = reconcile(s, wf, T);
  assert.equal(s.stages['product-definition'].status, 'READY');
  assert.equal(s.stages.discovery.status, 'PASS', 'history is untouched');
});

test('a broken checker run fails in place instead of bouncing work to the engineer', () => {
  const all: Workflow = { ...wf, stages: wf.stages.map((d) => ({ ...d, enabled: true })) };
  let s = initialState(all, { name: 'Demo', slug: 'demo' }, T);
  s.stages['code-review'].status = 'READY';
  s.currentStage = 'code-review';
  s = startRun(s, all, 'code-review', 'cr1', T);
  s = completeRun(s, all, 'cr1', { status: 'FAIL', summary: null, blockers: ['CLI crashed'], error: true }, T);
  assert.equal(s.stages['code-review'].status, 'FAIL');
  assert.equal(s.currentStage, 'code-review');
  assert.equal(s.stages.implementation.status, 'WAITING');
});

test('the fix loop goes back through code review, then QA, then design QA', () => {
  const all: Workflow = { ...wf, stages: wf.stages.map((d) => ({ ...d, enabled: true })) };
  let s = initialState(all, { name: 'Demo', slug: 'demo' }, T);
  s.stages['engineering-qa'].status = 'READY';
  s.currentStage = 'engineering-qa';
  s = startRun(s, all, 'engineering-qa', 'qa1', T);
  s = completeRun(s, all, 'qa1', { status: 'FAIL', summary: null, blockers: ['AC-4 fails on empty input'] }, T);
  assert.equal(s.currentStage, 'implementation');
  s = startRun(s, all, 'implementation', 'im2', T);
  s = completeRun(s, all, 'im2', { status: 'PASS', summary: null, blockers: [] }, T);
  assert.equal(s.currentStage, 'code-review', 'a fix is reviewed before QA runs again');
  s = startRun(s, all, 'code-review', 'cr2', T);
  s = completeRun(s, all, 'cr2', { status: 'PASS', summary: null, blockers: [] }, T);
  assert.equal(s.currentStage, 'engineering-qa');
  assert.equal(s.stages['engineering-qa'].status, 'READY');
});

test('reopen sends work back to an earlier agent stage with the human reason', () => {
  let s = startRun(fresh(), wf, 'discovery', 'r1', T);
  s = completeRun(s, wf, 'r1', { status: 'PASS', summary: null, blockers: [] }, T);
  s = decideGate(s, wf, 'discovery-approval', 'APPROVED', null, T);
  throwsCode(() => reopen(s, wf, 'discovery', '', T), 'feedback_required');
  throwsCode(() => reopen(s, wf, 'tech-design', 'x', T), 'not_earlier');
  s = reopen(s, wf, 'discovery', 'Missing a competitor', T);
  assert.equal(s.currentStage, 'discovery');
  assert.equal(s.stages.discovery.status, 'READY');
  assert.deepEqual(s.stages.discovery.blockers, ['Reopened by a human: Missing a competitor']);
});

test('installing packages resets the engineer failure streak', () => {
  let s = initialState(wf, { name: 'Demo', slug: 'demo' }, T);
  s.stages.implementation.status = 'READY';
  s.currentStage = 'implementation';
  for (let i = 1; i <= wf.maxConsecutiveFailures; i++) {
    s = startRun(s, wf, 'implementation', `i${i}`, T);
    s = completeRun(s, wf, `i${i}`, { status: 'FAIL', summary: null, blockers: ['Needs package install: x'] }, T);
  }
  assert.equal(s.stages.implementation.status, 'BLOCKED');
  s = environmentChanged(s, wf, T);
  assert.equal(s.stages.implementation.status, 'READY');
  assert.equal(s.stages.implementation.consecutiveFailures, 0);
});
