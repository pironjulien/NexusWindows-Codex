// Arrêt d'urgence commun. Ces tests n'écrivent JAMAIS le vrai %USERPROFILE%\.nexus\stop (il figerait les autres
// agents de Julien) : chaque test a son dossier temporaire, et NEXUS_SHARED_HOME pointe vers un dossier temporaire
// pour toute instance commune et tout processus enfant.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, unlink, utimes, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { EmergencyStop, HOLD_S, sharedDirectory } from '../lib/stop.mjs';
import { WindowsSession } from '../lib/session.mjs';
import { NativeUIA } from '../lib/native.mjs';

const realDirectory = path.join(os.homedir(), '.nexus');
if (!process.env.NEXUS_SHARED_HOME) process.env.NEXUS_SHARED_HOME = await mkdtemp(path.join(os.tmpdir(), 'nexus-codex-shared-'));
assert.notEqual(path.resolve(sharedDirectory()), path.resolve(realDirectory));
const executable = process.env.NEXUS_FOREGROUND_EXE;
const STOPPED = /Arrêt d'urgence demandé par Julien.*plus aucune action pendant encore \d+ s ; ne pas contourner/;

async function directory(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nexus-codex-stop-'));
  assert.notEqual(path.resolve(dir), path.resolve(realDirectory));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function clocks() {
  const c = { mono: 1000, wall: Date.now() };
  return { c, options: { monotonic: () => c.mono, wall: () => c.wall, watch: false } };
}
const press = (dir, nonce = Math.random().toString(16).slice(2)) =>
  writeFile(path.join(dir, 'stop'), JSON.stringify({ by: 'Test', pid: process.pid, at: Date.now() / 1000, hold_s: HOLD_S, nonce }));

test('a new recent version freezes actions for the remaining time with the required message', async t => {
  const dir = await directory(t);
  const { c, options } = clocks();
  const stop = new EmergencyStop({ directory: dir, ...options });
  assert.equal(stop.remainingS(), 0);
  stop.assertClear();
  await press(dir);
  c.wall = Date.now() + 20000; // fichier vieux de 20 s au moment où il est vu
  assert.throws(() => stop.assertClear(), error => error.emergencyStop && error.deferred && STOPPED.test(error.message));
  const left = stop.remainingS();
  assert.ok(left > 95 && left < 100.5, String(left)); // dates de fichier et Date.now() n'ont pas la même résolution
});

test('an old stop file is ignored', async t => {
  const dir = await directory(t);
  await press(dir);
  const old = new Date(Date.now() - (HOLD_S + 30) * 1000);
  await utimes(path.join(dir, 'stop'), old, old);
  const stop = new EmergencyStop({ directory: dir, watch: false });
  assert.equal(stop.remainingS(), 0);
  stop.assertClear();
});

test('deleting the file or moving the wall clock never lifts the stop; only time does', async t => {
  const dir = await directory(t);
  const { c, options } = clocks();
  const stop = new EmergencyStop({ directory: dir, ...options });
  await press(dir);
  assert.ok(stop.remainingS() > 119);
  await unlink(path.join(dir, 'stop'));
  c.wall += 3600 * 1000; // l'horloge murale saute d'une heure
  assert.throws(() => stop.assertClear(), STOPPED);
  c.mono += 60 * 1000;
  assert.ok(Math.abs(stop.remainingS() - 60) < 1.5);
  c.mono += 61 * 1000;
  assert.equal(stop.remainingS(), 0);
  stop.assertClear();
});

test('the same version is counted once; a new press re-arms, never lifts', async t => {
  const dir = await directory(t);
  const { c, options } = clocks();
  const stop = new EmergencyStop({ directory: dir, ...options });
  await press(dir, 'first');
  assert.ok(stop.remainingS() > 119);
  c.mono += 121 * 1000; // temps écoulé en mémoire, fichier inchangé et date toujours « récente »
  assert.equal(stop.remainingS(), 0);
  c.mono += 1000;
  await press(dir, 'second');
  assert.ok(stop.remainingS() > 119);
  c.mono += 30 * 1000;
  await press(dir, 'third');
  assert.ok(stop.remainingS() > 119);
});

test('a future-dated file cannot hold the stop beyond HOLD_S', async t => {
  const dir = await directory(t);
  await press(dir);
  const future = new Date(Date.now() + 3600 * 1000);
  await utimes(path.join(dir, 'stop'), future, future);
  const stop = new EmergencyStop({ directory: dir, watch: false });
  assert.ok(stop.remainingS() <= HOLD_S);
});

test('the idle watcher latches a stop deleted before the next action', async t => {
  const dir = await directory(t);
  const stop = new EmergencyStop({ directory: dir });
  t.after(() => stop.close());
  await press(dir);
  await new Promise(resolve => setTimeout(resolve, 450));
  await unlink(path.join(dir, 'stop'));
  assert.throws(() => stop.assertClear(), STOPPED);
});

// --- Session : refus avant toute entrée, jamais rejoué ; les observations restent permises. ---
function provider() {
  return {
    target: 'windows', calls: [], done: false,
    windows: [{ id: 10, app: 'test!App', title: 'Test' }],
    async list_windows() { return this.windows; },
    async get_window({ id }) { return this.windows.find(w => w.id === id); },
    async activate_window() { this.calls.push('activate'); },
    async get_window_state({ window, include_text, include_screenshot }) {
      return {
        window,
        accessibility: include_text ? {
          tree: `0 window Test\n\t1 group ID: main\n\t\t2 button Go ID: go\n\t\t3 edit Input ID: input\n\t\t4 text Status Value: ${this.done ? 'Done' : 'Ready'} ID: status`,
          focused_element: '3 edit Input ID: input',
        } : null,
        screenshots: include_screenshot ? [{ id: 'shot-1', width: 800, height: 600 }] : [],
      };
    },
    async click(input) { this.calls.push(input); this.done = true; },
    async set_value(input) { this.calls.push(input); this.done = true; },
  };
}
async function session(t, foreground = async (_, action) => action()) {
  const dir = await directory(t);
  const stop = new EmergencyStop({ directory: dir, watch: false });
  const root = await directory(t);
  const sky = provider();
  const win = new WindowsSession(sky, { stateRoot: root, native: { withForeground: foreground }, emergencyStop: stop });
  await win.bind({ id: 10 });
  return { dir, stop, sky, win, observation: await win.observe() };
}

test('act, activate and runRecipe are refused during a stop; the refused action is never replayed', async t => {
  const { dir, sky, win, observation } = await session(t);
  const learned = await win.act(observation, { kind: 'click', selector: { automationId: 'go' }, expect: { selector: { automationId: 'status' }, field: 'value', equals: 'Done' } });
  await win.remember('go', learned, { staticUI: true });
  sky.done = false; sky.calls.length = 0;
  const obs = await win.observe();
  await press(dir);
  await assert.rejects(win.act(obs, { kind: 'click', selector: { automationId: 'go' } }), STOPPED);
  await assert.rejects(win.act(obs, { kind: 'setValue', selector: { automationId: 'input' }, value: 'x' }), /Stale|Arrêt/);
  await assert.rejects(win.activate(), STOPPED);
  const fresh = await win.observe(); // les observations restent permises
  assert.equal(fresh.elements.length, 5);
  await assert.rejects(win.runRecipe(fresh, 'go'), STOPPED);
  // L'observation présentée lors du refus est consommée : rien ne peut la rejouer après l'arrêt.
  await assert.rejects(win.act(fresh, { kind: 'click', selector: { automationId: 'go' } }), /Stale|Arrêt/);
  assert.equal(sky.calls.length, 0);
  assert.ok(win.metrics().some(m => m.status === 'stopped'));
  assert.equal(win.emergencyStopStatus().stopped, true);
});

test('a stop arriving while the foreground token is awaited refuses the input', async t => {
  let dir;
  const ctx = await session(t, async (_, action) => { await press(dir); return action(); });
  dir = ctx.dir;
  await assert.rejects(ctx.win.act(ctx.observation, { kind: 'click', selector: { automationId: 'go' } }), STOPPED);
  assert.equal(ctx.sky.calls.length, 0);
  assert.equal(ctx.win.metrics().at(-1).status, 'stopped');
});

// --- Transport natif : refus côté JS sans lancer le helper, et refus du helper reconnu comme arrêt. ---
test('native actions and foreground leases are refused during a stop; inspection stays allowed', async t => {
  const dir = await directory(t);
  const stop = new EmergencyStop({ directory: dir, watch: false });
  const native = new NativeUIA(process.execPath, {
    args: [fileURLToPath(new URL('./fixtures/native-worker.mjs', import.meta.url))], timeoutMs: 2000, emergencyStop: stop,
  });
  t.after(() => native.close());
  const window = { id: 1, app: 'transport-fixture' };
  await assert.rejects(native.call(window, 'stopped'), error => error.emergencyStop === true && error.deferred === true && STOPPED.test(error.message));
  await press(dir);
  await assert.rejects(native.call(window, 'click', {}), STOPPED);
  await assert.rejects(native.withForeground('test', async () => assert.fail('action run during stop')), STOPPED);
  assert.equal((await native.inspect(window)).count, 2);
});

// --- Helper .NET réel (tester-computer-use.ps1 -LiveInstallation), toujours dans un dossier temporaire. ---
function run(args, env, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, env: { ...process.env, NEXUS_SHARED_HOME: env } });
    let out = '';
    child.stdout.setEncoding('utf8'); child.stdout.on('data', d => { out += d; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, out }));
    child.stdin.end(input);
  });
}

test('real helper refuses the foreground token and UIA actions during a stop', { skip: !executable, timeout: 20000 }, async t => {
  const dir = await directory(t);
  await press(dir);
  const token = await run(['--foreground-token', 'stop test'], dir, '');
  assert.equal(token.code, 1);
  const reply = JSON.parse(token.out);
  assert.equal(reply.error, 'EmergencyStopException');
  assert.match(reply.message, STOPPED);
  const request = JSON.stringify({ operation: 'click', windowId: 0, app: 'none', selector: { name: 'x' }, runtimeId: [] });
  const action = JSON.parse((await run([], dir, request)).out);
  assert.equal(action.error, 'EmergencyStopException');
  // Fichier ancien : ignoré (le refus vient alors de la fenêtre inexistante, pas de l'arrêt).
  const old = new Date(Date.now() - (HOLD_S + 30) * 1000);
  await utimes(path.join(dir, 'stop'), old, old);
  const after = JSON.parse((await run([], dir, request)).out);
  assert.notEqual(after.error, 'EmergencyStopException');
});

test('real guard in a test directory leaves the hotkey alone and writes the protocol file on a press', { skip: !executable, timeout: 20000 }, async t => {
  const dir = await directory(t);
  const guard = spawn(executable, ['--stop-guard', 'test'], { windowsHide: true, env: { ...process.env, NEXUS_SHARED_HOME: dir } });
  t.after(() => guard.kill());
  guard.stdout.setEncoding('utf8');
  const events = [];
  let buffer = '';
  const seen = name => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('guard event missing: ' + name)), 8000);
    const scan = () => { if (events.some(e => e.event === name)) { clearTimeout(timer); resolve(); } };
    guard.stdout.on('data', scan); scan();
  });
  guard.stdout.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) { events.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); }
  });
  await seen('hotkey');
  assert.equal(events.find(e => e.event === 'hotkey').state, 'disabled');
  guard.stdin.write('press\n');
  await seen('stop');
  const written = JSON.parse(await readFile(path.join(dir, 'stop'), 'utf8'));
  assert.equal(written.by, 'NexusCodex');
  assert.equal(written.hold_s, HOLD_S);
  assert.ok(written.pid > 0 && written.at > 0 && /^[0-9a-f]{12}$/.test(written.nonce));
  const stop = new EmergencyStop({ directory: dir, watch: false });
  assert.throws(() => stop.assertClear(), STOPPED);
  guard.stdin.end();
  const code = await new Promise(resolve => guard.once('close', resolve));
  assert.equal(code, 0);
});

// --- Garde mort (crash) : relancé au point de contrôle de chaque action, pas seulement par status(). ---
const until = async (condition, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return true;
};
test('a crashed guard is restarted by the next action checkpoint, and presence comes back', async t => {
  const dir = await directory(t);
  const { c, options } = clocks();
  const stop = new EmergencyStop({ directory: dir, ...options });
  t.after(() => stop.close());
  const marker = path.join(dir, 'crash-once');
  await writeFile(marker, '');
  stop.startGuard(process.execPath, [fileURLToPath(new URL('./fixtures/guard.mjs', import.meta.url)), marker]);
  assert.equal(stop.guardExpected, true);
  assert.ok(await until(() => stop.guardState === 'exited'), 'le garde factice aurait dû planter');
  assert.equal(stop.presence.available, false); // présence inconnue après le crash
  c.mono += 4000; // au-delà de la relance bornée (HEARTBEAT_S)
  stop.assertClear(); // contrôle d'une action : relance le garde mort
  assert.notEqual(stop.guardState, 'exited');
  assert.ok(await until(() => stop.presence.available), 'la présence aurait dû revenir avec le garde relancé');
});
