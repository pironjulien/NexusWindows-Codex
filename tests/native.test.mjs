import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { NativeUIA, actionTimeoutMs, TOKEN_WAIT_MS, CHROMIUM_BUDGET_MS, CLEANUP_MS, ACTION_TIMEOUT_MS } from '../lib/native.mjs';
import { policyPath } from '../lib/garde-fous.mjs';

const window = { id: 1, app: 'transport-fixture' };
function worker(t, options = {}) {
  const native = new NativeUIA(process.execPath, {
    args: [fileURLToPath(new URL('./fixtures/native-worker.mjs', import.meta.url))],
    timeoutMs: 2000, ...options,
  });
  t.after(() => native.close());
  return native;
}

test('native transport reuses a worker, correlates replies and preserves split Unicode', async t => {
  const native = worker(t);
  const first = await native.inspect(window);
  const second = await native.call(window, 'chunks', { value: 'éà Ω 😀\nseconde ligne' });
  assert.equal(second.pid, first.pid);
  assert.equal(second.count, 2);
  assert.equal(second.value, 'éà Ω 😀\nseconde ligne');
});
test('provider error is never replayed and the next explicit request remains usable', async t => {
  const native = worker(t);
  await assert.rejects(native.call(window, 'reject'), /possible effect/);
  assert.equal((await native.inspect(window)).count, 2);
});
test('native timeout kills the worker; an explicit later observation starts a fresh one', async t => {
  const native = worker(t);
  const first = await native.inspect(window);
  native.timeoutMs = 50;
  await assert.rejects(native.call(window, 'hang'), /timed out.*unknown/);
  native.timeoutMs = 2000;
  const next = await native.inspect(window);
  assert.notEqual(next.pid, first.pid);
  assert.equal(next.count, 1);
});
test('concurrent native requests are refused without queueing another effect', async t => {
  const native = worker(t);
  await native.inspect(window);
  const pending = native.call(window, 'hang');
  const stopped = assert.rejects(pending, /closed.*unknown/);
  await assert.rejects(native.inspect(window), /Another native/);
  native.close();
  await stopped;
});
for (const operation of ['mismatch', 'malformed', 'crash', 'duplicate', 'trailing']) {
  test(`native ${operation} invalidates the process and never retries input`, async t => {
    const native = worker(t);
    const first = await native.inspect(window);
    await assert.rejects(native.call(window, operation));
    const next = await native.inspect(window);
    assert.notEqual(next.pid, first.pid);
    assert.equal(next.count, 1);
  });
}
test('idle native worker exits and can be recreated on demand', async t => {
  const native = worker(t, { idleTimeoutMs: 40 });
  const first = await native.inspect(window);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.notEqual((await native.inspect(window)).pid, first.pid);
});
test('oversized requests and invalid timeouts are refused before a worker action', async t => {
  assert.throws(() => new NativeUIA('unused', { timeoutMs: NaN }), /timeouts/);
  const native = worker(t);
  await assert.rejects(native.call(window, 'inspect', { value: 'x'.repeat(262145) }), /too large/);
  assert.equal((await native.inspect(window)).count, 1);
});
test('the helper receives the shared garde-fous policy path (it refuses every window request without it)', async t => {
  const native = worker(t);
  assert.equal((await native.inspect(window)).policy, policyPath());
});

test('a background action that may hold the token gets a Node timeout covering token, full Chromium budget and cleanup', () => {
  // Relecture de Codex du 22/10 (P2-10) : sinon Node tuerait le helper avant son nettoyage (désactivation, premier plan).
  const floor = TOKEN_WAIT_MS + CHROMIUM_BUDGET_MS + CLEANUP_MS;
  for (const operation of ['typeText', 'select', 'click']) assert.ok(actionTimeoutMs(operation, { mode: 'background' }, ACTION_TIMEOUT_MS) > floor, operation);
  assert.equal(actionTimeoutMs('inspect', {}, ACTION_TIMEOUT_MS), ACTION_TIMEOUT_MS);
});
