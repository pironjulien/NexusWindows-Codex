import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile, writeFile, readdir, open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ApplicationMemory } from '../lib/memory.mjs';
import { digest, validateSelector } from '../lib/tree.mjs';

const recipe = () => ({
  kind: 'click', selector: { automationId: 'clear' },
  expect: { selector: { automationId: 'result' }, field: 'value', equals: '0' },
  structureHash: digest('structure'), revision: digest('revision'),
  verifiedAt: new Date().toISOString(), verifiedCount: 1,
});
async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-cu-memory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const memory = new ApplicationMemory(root);
  return { memory, file: memory.file('fixture!app', 'clear') };
}

test('recipe validation rejects corrupted metadata and unexpected executable fields', async t => {
  const { memory, file } = await setup(t);
  await memory.save('fixture!app', 'clear', recipe());
  const original = JSON.parse(await readFile(file, 'utf8'));
  for (const change of [
    { revision: 'broken' }, { verifiedCount: -1 }, { verifiedCount: '1' },
    { verifiedAt: 'tomorrow' }, { point: { x: 1, y: 1 } }, { action: 'Expand' },
    { kind: 'secondary', action: '' },
  ]) {
    await writeFile(file, JSON.stringify({ ...original, ...change }));
    await assert.rejects(memory.read('fixture!app', 'clear'));
  }
});

test('invalid memory updates preserve the last verified recipe', async t => {
  const { memory, file } = await setup(t);
  await memory.save('fixture!app', 'clear', recipe());
  const original = await readFile(file, 'utf8');
  await assert.rejects(memory.save('fixture!app', 'clear', { ...recipe(), kind: 'typeText', text: 'private' }));
  assert.equal(await readFile(file, 'utf8'), original);
});

test('a failed memory publication releases the lock and removes temporary data', async t => {
  const { memory, file } = await setup(t);
  await mkdir(file, { recursive: true }); // A directory makes publishing the JSON file fail.
  await assert.rejects(memory.save('fixture!app', 'clear', recipe()));
  assert.deepEqual(await readdir(path.dirname(file)), ['clear.json']);
  await rm(file, { recursive: true });
  await memory.save('fixture!app', 'clear', recipe());
  assert.equal((await memory.read('fixture!app', 'clear')).verifiedCount, 1);
});

test('a concurrent writer cannot replace a locked recipe', async t => {
  const { memory, file } = await setup(t);
  await memory.save('fixture!app', 'clear', recipe());
  const original = await readFile(file, 'utf8');
  const lock = await open(file + '.lock', 'wx');
  try {
    await assert.rejects(memory.save('fixture!app', 'clear', { ...recipe(), verifiedCount: 2 }), { code: 'EEXIST' });
    assert.equal(await readFile(file, 'utf8'), original);
  } finally { await lock.close(); }
});

test('an explicit invalid ancestor is rejected rather than silently broadening a selector', () => {
  for (const ancestor of [null, false, '', 0]) {
    assert.throws(() => validateSelector({ automationId: 'clear', ancestor }));
  }
});
