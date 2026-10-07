import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildArgs, ancestorMemoryExcludes, describeEvent, extractClaudeResult } from '../server/clis.ts';

const base = { prompt: 'p', schema: { type: 'object' }, schemaPath: '/w/s.json', lastMessagePath: '/w/out.json' };

test('claude runs isolated from the user configuration and cannot auto-approve', () => {
  const args = buildArgs({ ...base, cli: 'claude', cwd: '/Users/someone/Projects/tool/workspaces/demo' });
  const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
  assert.ok(settings.claudeMdExcludes.includes('/Users/someone/.claude/CLAUDE.md'), 'personal CLAUDE.md excluded');
  assert.equal(args[args.indexOf('--setting-sources') + 1], 'project');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  for (const flag of ['--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--json-schema']) {
    assert.ok(args.includes(flag), flag);
  }
  assert.ok(!args.some((a) => /bypass|dangerously/i.test(a)));
});

test('ancestor excludes cover every parent directory but not the workspace itself', () => {
  const ex = ancestorMemoryExcludes('/a/b/ws');
  assert.ok(ex.includes('/a/b/CLAUDE.md') && ex.includes('/a/.claude/CLAUDE.md') && ex.includes('/CLAUDE.md'));
  assert.ok(!ex.includes('/a/b/ws/CLAUDE.md'));
});

test('codex reviewers run in a read-only sandbox without user config', () => {
  const args = buildArgs({ ...base, cli: 'codex', cwd: '/w' });
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  for (const flag of ['--ephemeral', '--ignore-user-config', '--output-schema', '--output-last-message']) assert.ok(args.includes(flag), flag);
  assert.ok(!args.some((a) => /bypass|dangerously|approve-for-me/i.test(a)));
});

test('the structured result is taken from the result event only on success', () => {
  const ok = extractClaudeResult('{"type":"system"}\n{"type":"result","subtype":"success","structured_output":{"a":1}}\n');
  assert.deepEqual(ok, { output: { a: 1 }, error: null });
  const bad = extractClaudeResult('{"type":"result","subtype":"error_max_turns","is_error":true,"result":"x"}');
  assert.match(bad.error!, /error_max_turns/);
  assert.match(extractClaudeResult('').error!, /without a result/);
});

test('live log lines describe tool use in plain words', () => {
  const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'WebSearch', input: { query: 'q' } }] } });
  assert.equal(describeEvent('claude', line), '→ WebSearch: q');
  assert.equal(describeEvent('codex', JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'ls' } })), '→ ls');
  assert.equal(describeEvent('claude', 'not json'), null);
});
