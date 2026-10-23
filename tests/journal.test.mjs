import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appName, journalLine, journalRoot, writeJournal } from '../lib/journal.mjs';

test('the common journal line keeps no screen text and maps every status', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'nexus-journal-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { NEXUS_JOURNAL_HOME: home };
  const line = journalLine({ session: 's1', app: ['process:C:', 'Windows', 'System32', 'mspaint.exe'].join('\\'), kind: 'click', status: 'verified',
    technique: 'physical:sky', durationMs: 12.6, now: new Date('2026-10-23T05:00:00Z') });
  writeJournal(line, env);
  const dir = journalRoot(env);
  const [file] = await readdir(dir);
  assert.equal(file, '2026-10.jsonl');
  const saved = JSON.parse(await readFile(path.join(dir, file), 'utf8'));
  assert.deepEqual({ app: saved.app, issue: saved.issue, ms: saved.ms, premier_plan: saved.premier_plan, erreur: saved.erreur },
    { app: 'mspaint.exe', issue: '✓', ms: 13, premier_plan: true, erreur: null });
  assert.equal(journalLine({ status: 'julien-active' }).issue, 'différé');
  assert.equal(journalLine({ status: 'confirmation-required' }).issue, 'refus');
  assert.equal(appName('Microsoft.Paint_8wekyb3d8bbwe!App'), 'microsoft.paint_8wekyb3d8bbwe!app');
});

test('tests never write the real journal', () => {
  writeJournal(journalLine({ status: 'verified' }), { NODE_TEST_CONTEXT: 'child', LOCALAPPDATA: 'Z:/nowhere' });
});

test('the journal never breaks an action, even without a global process', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'nexus-journal-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const saved = globalThis.process;
  try {
    Object.defineProperty(globalThis, 'process', { value: undefined, configurable: true, writable: true });
    assert.ok(journalRoot().endsWith(path.join('windows', 'codex'))); // aucune lecture de process.env
    writeJournal(journalLine({ kind: 'click', status: 'verified' }), { NEXUS_JOURNAL_HOME: home });
  } finally {
    Object.defineProperty(globalThis, 'process', { value: saved, configurable: true, writable: true });
  }
  assert.equal((await readdir(journalRoot({ NEXUS_JOURNAL_HOME: home }))).length, 1);
  assert.equal(journalLine({ kind: { text: 'secret' }, status: 'verified' }).action, 'invalid');
  assert.equal(journalLine({ kind: 'key', status: 'sent-unconfirmed', technique: 'background:messages', foreground: true }).premier_plan, true);
  assert.equal(journalLine({ kind: 'key', status: 'already-satisfied' }).issue, '=');
});

test('unknown action names are never kept and the REPL root matches the review', () => {
  assert.equal(journalLine({ kind: 'ConfidentialPayload', status: 'refused' }).action, 'invalid');
  assert.equal(journalLine({ kind: 'typeText', status: 'verified' }).action, 'typeText');
  assert.ok(journalRoot({}).includes(path.join('AppData', 'Local', 'NexusJournal')));
});
