import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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
