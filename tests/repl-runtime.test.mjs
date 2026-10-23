import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

// Le runtime Codex fournit les modules Node autorisés, mais pas le global process.
// Un processus enfant reproduit cette absence sans modifier le runner de tests.
test('the stop guard initializes without a process global and still enforces stops', async () => {
  const source = `
    import assert from 'node:assert/strict';
    import os from 'node:os';
    import path from 'node:path';
    import { mkdtemp, rm, writeFile } from 'node:fs/promises';
    import { sharedDirectory, EmergencyStop } from ${JSON.stringify(new URL('../lib/stop.mjs', import.meta.url).href)};
    delete globalThis.process;
    assert.equal(sharedDirectory(), path.join(os.homedir(), '.nexus'));
    const dir = await mkdtemp(path.join(os.tmpdir(), 'nexus-processless-'));
    assert.notEqual(path.resolve(dir), path.resolve(sharedDirectory()));
    assert.equal(sharedDirectory({NEXUS_SHARED_HOME:dir}), dir);
    const stop = new EmergencyStop({directory:dir,watch:false});
    try {
      stop.assertClear();
      await writeFile(path.join(dir, 'stop'), 'test-processless');
      assert.throws(() => stop.assertClear(), error => error.emergencyStop === true);
    } finally {
      stop.close();
      await rm(dir, {recursive:true,force:true});
    }
  `;
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], { windowsHide:true });
  assert.equal(stdout, '');
  assert.equal(stderr, '');
});

test('the native worker receives its mandatory policy without a process global', async () => {
  const source = `
    import assert from 'node:assert/strict';
    delete globalThis.process;
    const { NativeUIA } = await import(${JSON.stringify(new URL('../lib/native.mjs', import.meta.url).href)});
    const { policyPath } = await import(${JSON.stringify(new URL('../lib/garde-fous.mjs', import.meta.url).href)});
    const native = new NativeUIA(${JSON.stringify(process.execPath)}, {
      args: [${JSON.stringify(fileURLToPath(new URL('./fixtures/native-worker.mjs', import.meta.url)))}],
      timeoutMs: 2000,
    });
    try {
      const result = await native.inspect({id:1,app:'transport-fixture'});
      assert.equal(result.policy, policyPath());
      assert.ok(result.policy.endsWith('garde-fous.json'));
      assert.equal(result.envMarker, 'inherited');
    } finally { native.close(); }
  `;
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], {windowsHide:true,env:{...process.env,NEXUS_TRANSPORT_TEST:'inherited'}});
  assert.equal(stdout, '');assert.equal(stderr, '');
});

test('the foreground token transport tells a live helper from a lost one without a process global', async () => {
  // Relecture de Codex (21/10) : process.kill absent du REPL faisait passer tout helper vivant pour perdu.
  const fixture = fileURLToPath(new URL('./fixtures/token-helper.mjs', import.meta.url));
  const source = `
    import assert from 'node:assert/strict';
    const node = ${JSON.stringify(process.execPath)};
    delete globalThis.process;
    const { NativeUIA } = await import(${JSON.stringify(new URL('../lib/native.mjs', import.meta.url).href)});
    const stop = { assertClear() {} };
    const busy = ms => { const end = Date.now() + ms; while (Date.now() < end) {} };
    const live = new NativeUIA(node, { tokenArgs: [${JSON.stringify(fixture)}], emergencyStop: stop });
    let held = null;
    assert.equal(await live.withForeground('fixture', async lease => { busy(50); held = lease.held(); return 'ok'; }), 'ok');
    assert.equal(held, true);
    const dying = new NativeUIA(node, { tokenArgs: [${JSON.stringify(fixture)}, '--exit-after', '20'], emergencyStop: stop });
    await assert.rejects(dying.withForeground('fixture', async lease => { await new Promise(r => setTimeout(r, 0)); busy(150); held = lease.held(); return 'accepted'; }), /outcome unknown/);
    assert.equal(held, false);
  `;
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], { windowsHide: true });
  assert.equal(stdout, ''); assert.equal(stderr, '');
});
