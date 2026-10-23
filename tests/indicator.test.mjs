// Logo « agent au travail » : allumé pendant les actions (jamais les observations), commandes envoyées au garde, et
// rendu natif quand l'exécutable est fourni (NEXUS_FOREGROUND_EXE, validation de l'installation).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { WindowsSession } from '../lib/session.mjs';
import { EmergencyStop } from '../lib/stop.mjs';

const until = async (check, ms = 3000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 20))) if (await check()) return true;
  return false;
};

test('actions light the indicator on the bound window, observations never do', async () => {
  const window = { id: 4242, app: 'fixture', title: 'Test' };
  const calls = [];
  const stop = { assertClear() {}, busy: hwnd => calls.push(['busy', hwnd]), idle: () => calls.push(['idle']) };
  const sky = { target: 'windows', async list_windows() { return [window]; }, async get_window() { return window; },
    async activate_window() { assert.deepEqual(calls.at(-1), ['busy', 4242]); },
    async get_window_state() { return { window, accessibility: { tree: '0 window Test' }, screenshots: [] }; } };
  const native = { async withForeground(_, run) { return run(); } };
  const session = new WindowsSession(sky, { native, emergencyStop: stop });
  try {
    await session.windows();
    await session.bind({ id: 4242 });
    await session.observe();
    assert.deepEqual(calls, []);
    await session.activate();
    assert.deepEqual(calls, [['busy', 4242], ['idle']]);
    calls.length = 0;
    await assert.rejects(session.act(null, { kind: 'key', key: 'a' }));
    assert.deepEqual(calls, [['busy', 4242], ['idle']]); // une action refusée éteint aussi
  } finally { await session.close(); }
});

test('the guard receives busy with the window, then a single idle after overlapping actions', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nexus-codex-busy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const record = path.join(dir, 'commands.txt');
  const stop = new EmergencyStop({ directory: dir, watch: false });
  t.after(() => stop.close());
  stop.startGuard(process.execPath, [fileURLToPath(new URL('./fixtures/busy-guard.mjs', import.meta.url)), record]);
  stop.busy(123);
  stop.busy(Number.NaN);
  stop.idle();
  stop.idle();
  stop.idle(); // de trop : ignoré
  assert.ok(await until(async () => (await readFile(record, 'utf8').catch(() => '')).split('\n').length >= 4));
  assert.deepEqual((await readFile(record, 'utf8')).trim().split('\n'), ['busy 123', 'busy 0', 'idle']);
});

const executable = process.env.NEXUS_FOREGROUND_EXE;
test('native frames: round logo spinning on itself, without halo', { skip: !executable && 'NEXUS_FOREGROUND_EXE absent' }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nexus-codex-frames-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'frames.bin');
  const run = spawnSync(executable, ['--indicator-frames', '72', out], { windowsHide: true, timeout: 30000 });
  assert.equal(run.status, 0, String(run.stderr));
  const data = await readFile(out);
  const side = 144, size = side * side * 4;
  assert.equal(data.length, 48 * size);
  const alpha = (f, x, y) => data[f * size + (y * side + x) * 4 + 3];
  const opaque = f => Array.from({ length: side }, (_, x) => alpha(f, x, side / 2) > 200).filter(Boolean).length;
  assert.equal(alpha(0, side / 2, side / 2), 255);
  assert.equal(alpha(0, 0, 0), 0);
  assert.ok(opaque(0) >= 60 && opaque(0) <= 80, `diamètre ${opaque(0)}`);
  assert.ok(opaque(12) < opaque(0), 'le logo tourne');
  const at = 0 * size + ((side / 2 - 40) * side + side / 2) * 4;
  // Plus de halo bleu-violet (Julien, 22/10) : au-dessus du logo, au plus l'ombre noire, jamais de couleur.
  assert.ok(data[at] === 0 && data[at + 1] === 0 && data[at + 2] === 0, 'aucune couleur au-dessus du logo');
});
