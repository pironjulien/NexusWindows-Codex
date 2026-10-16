import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { NativeUIA } from '../lib/native.mjs';

const executable = process.env.NEXUS_FOREGROUND_EXE;
const python = process.env.NEXUS_FOREGROUND_PYTHON;
const lockPath = path.join(os.homedir(), '.nexus', 'foreground.lock');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('real foreground lease excludes other processes, defers input and releases on failure', { skip: !executable, timeout: 20000 }, async () => {
  const first = new NativeUIA(executable), second = new NativeUIA(executable);
  await first.withForeground('lease integration test', async () => {
    const diagnostic = JSON.parse(await readFile(lockPath, 'utf8'));
    assert.equal(diagnostic.owner, 'NexusCodex');
    assert.equal(diagnostic.purpose, 'lease integration test');
    assert.ok(diagnostic.pid > 0 && diagnostic.since > 0);
    let performed = false;
    await assert.rejects(second.withForeground('must defer', async () => { performed = true; }), error => error.deferred && /lease integration test/.test(error.message));
    assert.equal(performed, false);
  });
  assert.equal(await readFile(lockPath, 'utf8'), '');
  await assert.rejects(first.withForeground('failure cleanup', async () => { throw Error('action failed'); }), /action failed/);
  await second.withForeground('reacquire after failure', async () => {});
  assert.equal(await readFile(lockPath, 'utf8'), '');
});

test('real foreground lease waits for the holder and releases when its pipe closes or it dies', { skip: !executable, timeout: 12000 }, async () => {
  for (const terminate of [false, true]) {
    const holder = spawn(executable, ['--foreground-token', 'crash test'], { windowsHide: true });
    try {
      await new Promise((resolve, reject) => { holder.stdout.once('data', resolve); holder.once('error', reject); holder.once('close', () => reject(Error('Holder exited before readiness'))); });
      let performed = false;
      const waiting = new NativeUIA(executable).withForeground('wait test', async () => { performed = true; });
      await delay(150);
      assert.equal(performed, false);
      if (terminate) holder.kill(); else holder.stdin.end();
      await waiting;
      assert.equal(performed, true);
    } finally { holder.kill(); }
  }
});

test('C# lease interoperates with the shared Python LockFileEx implementation', { skip: !executable || !python, timeout: 12000 }, async () => {
  const shared = path.resolve(import.meta.dirname, '../../../shared');
  const code = 'import sys; sys.path.insert(0, sys.argv[1]); from foreground_lock import ForegroundLock; lock = ForegroundLock("InteropPython", timeout=0, purpose="interop test"); ok = lock.acquire(); print(ok, flush=True); sys.stdin.readline(); lock.release()';
  const probe = () => spawn(python, ['-B', '-c', code, shared], { windowsHide: true });
  const ready = child => new Promise((resolve, reject) => {
    child.stdout.once('data', bytes => resolve(bytes.toString().trim())); child.once('error', reject);
    child.once('close', () => reject(Error('Python probe exited before readiness')));
  });
  await new NativeUIA(executable).withForeground('C# interop test', async () => {
    const child = probe();
    try { assert.equal(await ready(child), 'False'); } finally { child.stdin.end(); }
  });
  const child = probe();
  try {
    assert.equal(await ready(child), 'True');
    let performed = false;
    const waiting = new NativeUIA(executable).withForeground('Python interop wait', async () => { performed = true; });
    await delay(150); assert.equal(performed, false);
    child.stdin.end(); await waiting; assert.equal(performed, true);
  } finally { child.stdin.end(); }
});
