// Workflow engine: pure state transitions, no I/O.
// Every rule about what may happen next lives here, so the HTTP layer, a
// future automatic orchestrator and the tests all go through the same guards.

export type Status =
  | 'WAITING'
  | 'READY'
  | 'RUNNING'
  | 'PASS'
  | 'FAIL'
  | 'BLOCKED'
  | 'APPROVAL_REQUIRED'
  | 'APPROVED'
  | 'REJECTED';

export type StageKind = 'start' | 'agent' | 'gate' | 'end';
export type Cli = 'claude' | 'codex';

export interface StageDef {
  id: string;
  label: string;
  kind: StageKind;
  enabled: boolean;
  owner?: string;
  agent?: string;
  inputs?: string[];
  outputs?: string[];
  next?: string;
  returnTo?: string;
  reviews?: string;
  check?: { agent: string };
  timeoutMinutes?: number;
  writeAccess?: boolean; // the stage's agent edits code directly, in a sandbox
  diff?: 'since-last-review' | 'since-baseline'; // what a checker is shown
  verdict?: boolean; // the stage's report is kept even on FAIL (it explains the FAIL)
}

export interface AgentDef {
  label: string;
  cli: Cli;
  tool: string;
}

export interface Workflow {
  schemaVersion: number;
  maxConsecutiveFailures: number;
  stages: StageDef[];
  agents: Record<string, AgentDef>;
}

export interface CheckState {
  status: 'RUNNING' | 'PASS' | 'CONCERNS' | 'ERROR';
  runId: string;
  agent: string;
  summary: string | null;
  findings: number;
  completedAt: string | null;
}

export interface DecisionState {
  decision: 'APPROVED' | 'REJECTED';
  feedback: string | null;
  decidedAt: string;
  artifactRunId: string | null;
}

export interface StageState {
  status: Status;
  startedAt: string | null;
  completedAt: string | null;
  lastRunId: string | null;
  attempts: number;
  consecutiveFailures: number;
  blockers: string[];
  summary: string | null;
  check: CheckState | null;
  decision: DecisionState | null;
}

export interface ActiveRun {
  runId: string;
  stageId: string;
  agent: string;
  cli: Cli;
  purpose: 'produce' | 'check';
  startedAt: string;
}

export interface WorkflowState {
  schemaVersion: 1;
  project: { name: string; slug: string; createdAt: string };
  currentStage: string;
  stages: Record<string, StageState>;
  activeRun: ActiveRun | null;
  updatedAt: string;
}

export class EngineError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function stageDef(wf: Workflow, id: string): StageDef {
  const def = wf.stages.find((s) => s.id === id);
  if (!def) throw new EngineError('unknown_stage', `Unknown stage "${id}".`);
  return def;
}

function emptyStage(status: Status): StageState {
  return {
    status,
    startedAt: null,
    completedAt: null,
    lastRunId: null,
    attempts: 0,
    consecutiveFailures: 0,
    blockers: [],
    summary: null,
    check: null,
    decision: null,
  };
}

// Status a stage gets when the workflow arrives at it.
function arrivalStatus(def: StageDef): Status {
  if (def.kind === 'gate') return 'APPROVAL_REQUIRED';
  if (def.kind === 'end') return 'PASS';
  if (def.kind === 'agent' && def.enabled) return 'READY';
  return 'WAITING';
}

export function initialState(
  wf: Workflow,
  project: { name: string; slug: string },
  now: string,
): WorkflowState {
  const stages: Record<string, StageState> = {};
  for (const def of wf.stages) stages[def.id] = emptyStage('WAITING');

  const start = wf.stages[0];
  stages[start.id] = { ...emptyStage('PASS'), startedAt: now, completedAt: now };
  const first = stageDef(wf, start.next!);
  stages[first.id].status = arrivalStatus(first);

  return {
    schemaVersion: 1,
    project: { ...project, createdAt: now },
    currentStage: first.id,
    stages,
    activeRun: null,
    updatedAt: now,
  };
}

// Why a stage cannot run right now. Empty list means it can.
export function runBlockers(state: WorkflowState, wf: Workflow, stageId: string): string[] {
  const def = stageDef(wf, stageId);
  const st = state.stages[stageId];
  const reasons: string[] = [];
  if (def.kind !== 'agent') reasons.push(`"${def.label}" is not an agent stage.`);
  if (!def.enabled) reasons.push(`"${def.label}" is not available in this version yet.`);
  if (state.activeRun) {
    reasons.push(`Another agent is running (${state.activeRun.agent}). Only one agent runs at a time.`);
  }
  if (st.status === 'BLOCKED') {
    reasons.push(`"${def.label}" is blocked after repeated failures. Unblock it to retry.`);
  } else if (!['READY', 'FAIL'].includes(st.status)) {
    reasons.push(`"${def.label}" is ${st.status}, not ready to run.`);
  }
  return reasons;
}

export function startRun(
  state: WorkflowState,
  wf: Workflow,
  stageId: string,
  runId: string,
  now: string,
): WorkflowState {
  const reasons = runBlockers(state, wf, stageId);
  if (reasons.length) throw new EngineError('not_runnable', reasons.join(' '));
  const def = stageDef(wf, stageId);
  const agent = wf.agents[def.agent!];

  const next = structuredClone(state);
  const st = next.stages[stageId];
  st.status = 'RUNNING';
  st.startedAt = now;
  st.completedAt = null;
  st.lastRunId = runId;
  st.attempts += 1;
  st.blockers = [];
  next.currentStage = stageId;
  next.activeRun = { runId, stageId, agent: def.agent!, cli: agent.cli, purpose: 'produce', startedAt: now };
  next.updatedAt = now;
  return next;
}

export interface RunResult {
  status: 'PASS' | 'FAIL';
  summary: string | null;
  blockers: string[];
  // true when the run itself broke (CLI crash, invalid report). Only a real
  // FAIL verdict sends work back to returnTo; a broken run just fails in place.
  error?: boolean;
}

export function completeRun(
  state: WorkflowState,
  wf: Workflow,
  runId: string,
  result: RunResult,
  now: string,
): WorkflowState {
  const run = state.activeRun;
  if (!run || run.runId !== runId || run.purpose !== 'produce') {
    throw new EngineError('no_such_run', `Run ${runId} is not the active run.`);
  }
  const def = stageDef(wf, run.stageId);
  const next = structuredClone(state);
  const st = next.stages[run.stageId];
  st.completedAt = now;
  st.summary = result.summary;
  st.blockers = result.blockers;
  next.activeRun = null;
  next.updatedAt = now;

  if (result.status === 'PASS') {
    st.status = 'PASS';
    st.consecutiveFailures = 0;
    const target = stageDef(wf, def.next!);
    const tst = next.stages[target.id];
    tst.status = arrivalStatus(target);
    if (target.kind === 'gate') {
      // A new artifact needs a fresh decision and a fresh critique.
      tst.check = null;
      tst.decision = null;
    }
    next.currentStage = target.id;
    return next;
  }

  st.consecutiveFailures += 1;
  st.status = st.consecutiveFailures >= wf.maxConsecutiveFailures ? 'BLOCKED' : 'FAIL';
  if (st.status === 'BLOCKED') {
    st.blockers = [
      ...st.blockers,
      `Failed ${st.consecutiveFailures} times in a row. A human must review before retrying.`,
    ];
  }
  if (def.returnTo && st.status === 'FAIL' && !result.error) {
    const back = stageDef(wf, def.returnTo);
    next.stages[back.id].status = 'READY';
    next.currentStage = back.id;
  }
  return next;
}

export function startCheck(
  state: WorkflowState,
  wf: Workflow,
  gateId: string,
  runId: string,
  now: string,
): WorkflowState {
  const def = stageDef(wf, gateId);
  if (def.kind !== 'gate' || !def.check) {
    throw new EngineError('no_check', `"${def.label}" has no cross-check.`);
  }
  if (state.activeRun) {
    throw new EngineError('busy', `Another agent is running (${state.activeRun.agent}).`);
  }
  if (state.stages[gateId].status !== 'APPROVAL_REQUIRED') {
    throw new EngineError('not_pending', `"${def.label}" is not waiting for approval.`);
  }
  const agent = wf.agents[def.check.agent];
  const next = structuredClone(state);
  next.stages[gateId].check = {
    status: 'RUNNING',
    runId,
    agent: def.check.agent,
    summary: null,
    findings: 0,
    completedAt: null,
  };
  next.activeRun = { runId, stageId: gateId, agent: def.check.agent, cli: agent.cli, purpose: 'check', startedAt: now };
  next.updatedAt = now;
  return next;
}

export function completeCheck(
  state: WorkflowState,
  runId: string,
  result: { status: 'PASS' | 'CONCERNS' | 'ERROR'; summary: string | null; findings: number },
  now: string,
): WorkflowState {
  const run = state.activeRun;
  if (!run || run.runId !== runId || run.purpose !== 'check') {
    throw new EngineError('no_such_run', `Run ${runId} is not the active check.`);
  }
  const next = structuredClone(state);
  next.stages[run.stageId].check = {
    status: result.status,
    runId,
    agent: run.agent,
    summary: result.summary,
    findings: result.findings,
    completedAt: now,
  };
  next.activeRun = null;
  next.updatedAt = now;
  return next;
}

export function decideGate(
  state: WorkflowState,
  wf: Workflow,
  gateId: string,
  decision: 'APPROVED' | 'REJECTED',
  feedback: string | null,
  now: string,
): WorkflowState {
  const def = stageDef(wf, gateId);
  if (def.kind !== 'gate') throw new EngineError('not_a_gate', `"${def.label}" is not a human gate.`);
  if (state.activeRun) {
    throw new EngineError('busy', `Wait for ${state.activeRun.agent} to finish before deciding.`);
  }
  if (state.stages[gateId].status !== 'APPROVAL_REQUIRED') {
    throw new EngineError('not_pending', `"${def.label}" is not waiting for approval.`);
  }
  const text = feedback?.trim() || null;
  if (decision === 'REJECTED' && !text) {
    throw new EngineError('feedback_required', 'Say what should change so the agent can act on it.');
  }

  const next = structuredClone(state);
  const gate = next.stages[gateId];
  const reviewed = next.stages[def.reviews!];
  gate.status = decision;
  gate.completedAt = now;
  gate.decision = { decision, feedback: text, decidedAt: now, artifactRunId: reviewed.lastRunId };
  next.updatedAt = now;

  if (decision === 'APPROVED') {
    const target = stageDef(wf, def.next!);
    next.stages[target.id].status = arrivalStatus(target);
    if (target.kind === 'end') next.stages[target.id].completedAt = now;
    next.currentStage = target.id;
  } else {
    reviewed.status = 'READY';
    reviewed.consecutiveFailures = 0;
    next.currentStage = def.reviews!;
  }
  return next;
}

export function unblock(state: WorkflowState, wf: Workflow, stageId: string, now: string): WorkflowState {
  const def = stageDef(wf, stageId);
  if (state.stages[stageId].status !== 'BLOCKED') {
    throw new EngineError('not_blocked', `"${def.label}" is not blocked.`);
  }
  if (state.activeRun) {
    throw new EngineError('busy', `Wait for ${state.activeRun.agent} to finish before unblocking.`);
  }
  const next = structuredClone(state);
  next.stages[stageId].status = 'READY';
  next.stages[stageId].consecutiveFailures = 0;
  next.updatedAt = now;
  return next;
}

// Used at startup: a run that was active when the server stopped can never
// report back, so it is closed as a failure instead of hanging forever.
export function interruptActiveRun(state: WorkflowState, wf: Workflow, reason: string, now: string): WorkflowState {
  const run = state.activeRun;
  if (!run) return state;
  if (run.purpose === 'check') {
    return completeCheck(state, run.runId, { status: 'ERROR', summary: reason, findings: 0 }, now);
  }
  return completeRun(state, wf, run.runId, { status: 'FAIL', summary: reason, blockers: [reason], error: true }, now);
}

// Used after a workflow definition changes (for example, a new version enables
// more stages): a stage the workflow already arrived at gets the status it
// would have had if it had been enabled at the time.
export function reconcile(state: WorkflowState, wf: Workflow, now: string): WorkflowState {
  const next = structuredClone(state);
  for (const def of wf.stages) {
    if (!next.stages[def.id]) next.stages[def.id] = emptyStage('WAITING');
  }
  const cur = stageDef(wf, next.currentStage);
  if (next.stages[cur.id].status === 'WAITING' && !next.activeRun) {
    next.stages[cur.id].status = arrivalStatus(cur);
  }
  next.updatedAt = now;
  return next;
}

// A human sends the workflow back to an earlier agent stage, for example when
// the product review blocks a release. Later stages keep their history and are
// re-entered in order as the workflow moves forward again.
export function reopen(state: WorkflowState, wf: Workflow, stageId: string, reason: string, now: string): WorkflowState {
  const def = stageDef(wf, stageId);
  if (def.kind !== 'agent' || !def.enabled) throw new EngineError('not_reopenable', `"${def.label}" cannot be reopened.`);
  if (state.activeRun) throw new EngineError('busy', `Wait for ${state.activeRun.agent} to finish.`);
  const order = wf.stages.map((s) => s.id);
  if (order.indexOf(stageId) >= order.indexOf(state.currentStage)) {
    throw new EngineError('not_earlier', `"${def.label}" is not before the current stage.`);
  }
  if (!reason.trim()) throw new EngineError('feedback_required', 'Say why the work goes back, so the agent can act on it.');
  const next = structuredClone(state);
  const st = next.stages[stageId];
  st.status = 'READY';
  st.consecutiveFailures = 0;
  st.blockers = [`Reopened by a human: ${reason.trim()}`];
  next.currentStage = stageId;
  next.updatedAt = now;
  return next;
}
