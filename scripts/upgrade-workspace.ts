// Brings an existing product workspace up to the Control Center's current
// templates: workflow definition, schemas and agent contracts. Workflow
// history is kept; only the definition changes. The old versions stay in the
// product's Git history.
//
// Usage: npm run upgrade-workspace [-- <workspace path>]

import { promises as fs, readdirSync } from 'node:fs';
import path from 'node:path';
import * as store from '../server/store.ts';
import { reconcile, type Workflow } from '../server/engine.ts';

const ws = process.argv[2] ? path.resolve(process.argv[2]) : store.activeWorkspace();
if (!ws) {
  console.error('No product workspace found.');
  process.exit(1);
}

const state = await store.loadState(ws);
if (state.activeRun) {
  console.error(`An agent is running (${state.activeRun.agent}). Wait for it to finish, then upgrade.`);
  process.exit(1);
}

const changed: string[] = [];
async function sync(from: string, rel: string) {
  const next = await fs.readFile(from, 'utf8');
  const prev = await store.readText(ws!, rel);
  if (prev === next) return;
  await store.writeText(ws!, rel, next);
  changed.push(`${prev === null ? 'added' : 'updated'} ${rel}`);
}

for (const file of readdirSync(path.join(store.TEMPLATES, 'agents'))) {
  await sync(path.join(store.TEMPLATES, 'agents', file), `agents/${file}`);
}
for (const file of readdirSync(path.join(store.TEMPLATES, 'schemas'))) {
  await sync(path.join(store.TEMPLATES, 'schemas', file), `workflow/schemas/${file}`);
}
await sync(path.join(store.TEMPLATES, 'workflow.json'), 'workflow/workflow.json');

if (!changed.length) {
  console.log('Workspace is already up to date.');
  process.exit(0);
}

const wf = (await store.loadWorkflow(ws)) as Workflow & { version?: string };
const now = new Date().toISOString();
const before = state.stages[state.currentStage].status;
const next = reconcile(state, wf, now);
await store.saveState(ws, next);
await store.appendActivity(ws, {
  ts: now,
  actor: 'system',
  event: 'workspace_upgraded',
  message: `Workflow definition upgraded to v${wf.version ?? '?'} (${changed.length} files)`,
  outputs: changed.map((c) => c.replace(/^(added|updated) /, '')),
});
const commit = await store.commitAll(
  ws,
  `Upgrade workflow definition to v${wf.version ?? '?'}\n\n` +
    'The Control Center enabled new stages; this brings the product up to the same contracts and schemas ' +
    'so later runs are auditable against the definition they actually used.\n\n' +
    changed.map((c) => `- ${c}`).join('\n'),
);

console.log(changed.map((c) => `  ${c}`).join('\n'));
console.log(`Current stage ${next.currentStage}: ${before} -> ${next.stages[next.currentStage].status}`);
console.log(commit ? `Committed ${commit}` : 'Nothing to commit');
