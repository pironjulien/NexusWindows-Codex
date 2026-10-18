// Actions en arrière-plan avant l'entrée physique, repli seulement sans effet relu, capture native, lot vérifié,
// fenêtres liées et présence de Julien. Fournisseurs factices : aucune entrée de bureau réelle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir, utimes, mkdir } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { WindowsSession, textChunks } from '../lib/session.mjs';
import { Presence, JulienActiveError } from '../lib/presence.mjs';
import { EmergencyStop } from '../lib/stop.mjs';
import { NativeUIA } from '../lib/native.mjs';
import { digest, parseTree, stateDigest } from '../lib/tree.mjs';

const go = { automationId: 'go', role: 'button' };
const expectDone = { selector: { automationId: 'status' }, field: 'value', equals: 'Done' };

function sky() {
  return {
    target: 'windows', calls: [], done: false, extra: '', focus: 3, value: 'Ready',
    windows: [{ id: 10, app: 'test!App', title: 'Test' }],
    async list_windows() { return this.windows; },
    async get_window({ id }) { const w = this.windows.find(x => x.id === id); if (!w) throw Error('gone'); return w; },
    async activate_window() {},
    async get_window_state({ window, include_text, include_screenshot }) {
      this.states = (this.states ?? 0) + 1;
      this.lastState = { include_text, include_screenshot };
      const tree = window.id === 10
        ? `0 window Test\n\t1 group ID: main\n\t\t2 button Go ID: go\n\t\t3 edit Input ID: input\n\t\t4 text Status Value: ${this.done ? 'Done' : this.value} ID: status${this.extra}`
        : `0 window Dialog\n\t1 button Close ID: close\n\t2 text Message Value: Hello ID: message`;
      return {
        window,
        accessibility: include_text ? { tree, focused_element: `${this.focus} edit Input ID: input` } : null,
        screenshots: include_screenshot ? [{ id: 'shot-1', width: 800, height: 600 }] : [],
      };
    },
    async click(input) { this.calls.push(['click', input]); if (!this.inert) this.done = true; },
    async type_text(input) { this.calls.push(['type', input.text]); this.onType?.(input.text); this.done = true; },
    async set_value(input) { this.calls.push(['set_value', input]); this.done = true; },
    async press_key(input) { this.calls.push(['key', input]); },
  };
}
function stopIn(dir) { return new EmergencyStop({ directory: dir, watch: false }); }
async function setup(t, { native = {}, presence, pause } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-codex-bg-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const provider = sky();
  let tokens = 0;
  const helper = { async withForeground(_, action) { tokens++; return action(); }, ...native };
  const stop = stopIn(root);
  if (presence) Object.defineProperty(stop, 'presence', { value: presence });
  const session = new WindowsSession(provider, { stateRoot: root, native: helper, emergencyStop: stop, pause });
  await session.bind({ id: 10 });
  return { root, sky: provider, session, helper, tokens: () => tokens, observation: await session.observe() };
}
const notApplicable = message => Object.assign(new Error(message), { notApplicable: true });

// ---- 1. Arrière-plan d'abord ----
test('a Sky-observed click is first tried in background and never takes the foreground token', async t => {
  const calls = [];
  const { session, sky: s, observation, tokens } = await setup(t, { native: {
    async call(window, op, args) { calls.push({ op, args }); s.done = true; return { ok: true, technique: 'background:messages', mechanism: 'BN_CLICKED', effect: 'sent', foregroundTaken: false }; },
  } });
  const r = await session.act(observation, { kind: 'click', selector: go, expect: expectDone });
  assert.equal(r.status, 'verified');
  assert.equal(r.technique, 'background:messages');
  assert.equal(r.foregroundTaken, false);
  assert.equal(s.calls.length, 0);
  assert.equal(tokens(), 0);
  assert.deepEqual(calls[0], { op: 'click', args: { mode: 'background', selector: go } });
  assert.equal(session.metrics().at(-1).technique, 'background:messages');
});

test('a technique that does not apply falls back to Sky physical input under the shared token', async t => {
  const { session, sky: s, observation, tokens } = await setup(t, { native: { async call() { throw notApplicable('Win32 control without a silent background technique'); } } });
  const r = await session.act(observation, { kind: 'click', selector: go, expect: expectDone });
  assert.equal(r.status, 'verified');
  assert.equal(r.technique, 'physical:sky');
  assert.equal(r.foregroundTaken, true);
  assert.equal(r.attempts[0].outcome, 'not-applicable');
  assert.equal(s.calls.length, 1);
  assert.equal(tokens(), 1);
});

test('background input "sent" without a re-read effect is never repeated physically: sent-unconfirmed, never verified', async t => {
  const { session, sky: s, observation, tokens } = await setup(t, { native: { async call() { return { technique: 'background:uia', mechanism: 'Invoke', effect: 'sent' }; } } });
  const r = await session.act(observation, { kind: 'click', selector: go, expect: expectDone, timeoutMs: 0 });
  assert.equal(r.status, 'sent-unconfirmed');
  assert.equal(r.verified, false);
  assert.deepEqual(r.attempts.map(a => [a.technique, a.outcome]), [['background:uia', 'effect-not-read']]);
  assert.equal(s.calls.length, 0);
  assert.equal(tokens(), 0);
});

test('a slow background effect is not doubled by a physical click (review of 16/10)', async t => {
  let sent = 0;
  const { session, sky: s, observation } = await setup(t, { native: { async call() {
    setTimeout(() => { sent++; s.done = true; }, 300); // l'effet arrive après la fenêtre d'attente de la postcondition
    return { technique: 'background:uia', mechanism: 'Invoke', effect: 'sent' };
  } } });
  s.click = async input => { s.calls.push(['click', input]); sent++; s.done = true; };
  const r = await session.act(observation, { kind: 'click', selector: go, expect: expectDone, timeoutMs: 100 });
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(s.calls.length, 0);
  assert.equal(r.status, 'sent-unconfirmed');
  assert.equal(r.verified, false);
  assert.equal(sent, 1); // une seule action réelle
});

test('a re-read "none" falls back exactly once, under the token, after Julien pauses', async t => {
  const { session, sky: s, observation, tokens } = await setup(t, { native: { async call() { return { technique: 'background:uia', mechanism: 'Invoke', effect: 'none' }; } } });
  const r = await session.act(observation, { kind: 'click', selector: go, expect: expectDone, timeoutMs: 0 });
  assert.equal(r.status, 'verified');
  assert.deepEqual(r.attempts.map(a => [a.technique, a.outcome]), [['background:uia', 'no-effect'], ['physical:sky', undefined]]);
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0][1].element_index, 2);
  assert.equal(tokens(), 1);
});

test('a background effect that changed state but missed the postcondition is never repeated physically', async t => {
  const { session, sky: s, observation } = await setup(t, { native: { async call() { s.value = 'Partial'; return { technique: 'background:messages', effect: 'sent' }; } } });
  const r = await session.act(observation, { kind: 'click', selector: go, expect: expectDone, timeoutMs: 0 });
  assert.equal(r.status, 'unmet');
  assert.equal(r.technique, 'background:messages');
  assert.equal(s.calls.length, 0);
});

test('a re-read "applied" effect blocks fallback; "none" allows it; fallback:false forbids it', async t => {
  {
    const { session, sky: s, observation } = await setup(t, { native: { async call() { return { technique: 'background:uia', effect: 'applied' }; } } });
    assert.equal((await session.act(observation, { kind: 'click', selector: go, expect: expectDone, timeoutMs: 0 })).status, 'unmet');
    assert.equal(s.calls.length, 0);
  }
  {
    const { session, sky: s, observation } = await setup(t, { native: { async call() { s.value = 'Noise'; return { technique: 'background:uia', effect: 'none' }; } } });
    assert.equal((await session.act(observation, { kind: 'click', selector: go, expect: expectDone, timeoutMs: 0 })).status, 'verified');
    assert.equal(s.calls.length, 1);
  }
  {
    const { session, sky: s, observation } = await setup(t, { native: { async call() { return { technique: 'background:uia', effect: 'none' }; } } });
    assert.equal((await session.act(observation, { kind: 'click', selector: go, expect: expectDone, timeoutMs: 0, fallback: false })).status, 'unmet');
    assert.equal(s.calls.length, 0);
  }
});

test('a helper refusal sends nothing and never falls back; an unknown helper error is never followed by input', async t => {
  {
    const { session, sky: s, observation } = await setup(t, { native: { async call() { throw Object.assign(Error('Password controls require the dedicated supported workflow'), { refused: true }); } } });
    await assert.rejects(session.act(observation, { kind: 'click', selector: go }), /Password/);
    assert.equal(s.calls.length, 0);
    assert.equal(session.metrics().at(-1).status, 'refused');
  }
  {
    const { session, sky: s, observation } = await setup(t, { native: { async call() { throw Error('transport lost after posting'); } } });
    await assert.rejects(session.act(observation, { kind: 'click', selector: go }), /outcome is unknown/);
    assert.equal(s.calls.length, 0);
  }
});

test('select and menu run only in background; without a technique nothing is sent', async t => {
  const seen = [];
  const { session, sky: s, observation } = await setup(t, { native: { async call(_, op, args) { seen.push([op, args]); if (op === 'menu') { s.done = true; return { technique: 'background:messages', mechanism: 'WM_COMMAND', effect: 'sent' }; } throw notApplicable('Option is absent from the list'); } } });
  await assert.rejects(session.act(observation, { kind: 'select', selector: { automationId: 'input' }, option: 'Bravo' }), /No background technique/);
  assert.equal(s.calls.length, 0);
  const r = await session.act(await session.observe(), { kind: 'menu', path: 'Fichier > Compter', expect: expectDone });
  assert.equal(r.status, 'verified');
  assert.deepEqual(seen.map(([op, a]) => [op, a.option ?? a.path]), [['select', 'Bravo'], ['menu', 'Fichier > Compter']]);
  await assert.rejects(new WindowsSession(sky(), {}).act(null, { kind: 'menu', path: 'x' }), /Stale|native/);
});

test('background typing does not require system keyboard focus; physical typing still does', async t => {
  const { session, sky: s, observation } = await setup(t, { native: { async call(_, op, args) { assert.equal(op, 'typeText'); assert.deepEqual(args.selector, { automationId: 'input' }); s.done = true; return { technique: 'background:messages', mechanism: 'EM_REPLACESEL', effect: 'applied' }; } } });
  s.focus = 2; // la fenêtre n'a pas le premier plan : aucun champ n'a le focus clavier système
  const r = await session.act(observation, { kind: 'typeText', focus: { automationId: 'input' }, text: 'abc', expect: expectDone });
  assert.equal(r.technique, 'background:messages');
  assert.equal(s.calls.length, 0);
  const t2 = await setup(t, { native: { async call() { throw notApplicable('Background typing needs a native Edit control'); } } });
  t2.sky.focus = 2;
  await assert.rejects(t2.session.act(t2.observation, { kind: 'typeText', focus: { automationId: 'input' }, text: 'abc' }), /keyboard focus/);
  assert.equal(t2.sky.calls.length, 0);
});

function nativeTree(provider, extra = {}) {
  const capture = provider.get_window_state.bind(provider);
  return {
    calls: [], ...extra,
    async inspect(window) {
      const state = await capture({ window, include_text: true });
      return { ...state, revision: digest('rev'), elements: parseTree(state.accessibility.tree).map(e => ({ ...e, runtimeId: [7, e.index] })) };
    },
  };
}
test('a native observation falls back to the foreground UIA path of the helper, not to Sky', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-codex-bg-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const s = sky();
  s.get_window_state = (orig => async input => ({ ...(await orig(input)), accessibility: null }))(s.get_window_state.bind(s));
  const native = nativeTree(sky(), {
    async call(_, op, args) {
      this.calls.push(args.mode);
      if (args.mode === 'background') throw notApplicable('No background click pattern');
      s.done = true; return { technique: 'foreground:uia', mechanism: 'SetFocus', effect: 'applied', foregroundTaken: true };
    },
  });
  native.inspect = (inspect => async window => { const r = await inspect(window); if (s.done) r.elements = r.elements.map(e => e.automationId === 'status' ? { ...e, value: 'Done' } : e); return r; })(native.inspect.bind(native));
  const session = new WindowsSession(s, { stateRoot: root, native, emergencyStop: stopIn(root) });
  await session.bind({ id: 10 });
  const obs = await session.observe();
  assert.equal(obs.source, 'native-uia');
  const r = await session.act(obs, { kind: 'click', selector: go, expect: expectDone });
  assert.deepEqual(native.calls, ['background', 'foreground']);
  assert.equal(r.technique, 'foreground:uia');
  assert.equal(r.foregroundTaken, true);
  assert.equal(s.calls.length, 0);
});

// ---- 2. Capture propre ----
test('native capture replaces the Sky screenshot; blank or failed capture falls back to Sky', async t => {
  let shot = { ok: true, path: 'C:/local/capture.png', width: 504, height: 412, method: 'printwindow', scale: 1, ms: 12, blank: false, frame: { left: 1, top: 2, width: 504, height: 412 } };
  const { session, sky: s } = await setup(t, { native: { async capture(window, directory) { assert.match(directory, /captures$/); if (shot instanceof Error) throw shot; return shot; } } });
  let obs = await session.observe({ mode: 'image', capture: 'native' });
  assert.equal(obs.images[0].method, 'printwindow');
  assert.equal(obs.screenshots.length, 0);
  await assert.rejects(session.act(obs, { kind: 'click', point: { x: 1, y: 1 }, screenshotId: 'shot-1' }), /screenshotId/);
  shot = { ...shot, blank: true, path: null };
  obs = await session.observe({ mode: 'image', capture: 'native' });
  assert.equal(obs.images.length, 0);
  assert.match(obs.imageFallback, /blank/);
  assert.equal(obs.screenshots[0].id, 'shot-1');
  shot = Object.assign(new Error('Window is minimized: nothing to draw'), { notApplicable: true });
  obs = await session.observe({ mode: 'both', capture: 'native' });
  assert.match(obs.imageFallback, /minimized/);
  assert.equal(obs.screenshots.length, 1);
});

test('a successful native image needs no Sky call at all in image mode', async t => {
  const { session, sky: s } = await setup(t, { native: { async capture() { return { path: 'x.png', width: 1, height: 1, method: 'printwindow', blank: false }; } } });
  const before = s.states;
  await session.observe({ mode: 'image', capture: 'native' });
  assert.equal(s.states, before);
});

test('local captures are pruned by age and count', async t => {
  const { session, root } = await setup(t, { native: { async capture() { return { path: 'x.png', width: 1, height: 1, method: 'printwindow', blank: false }; } } });
  const dir = path.join(root, 'captures');
  await mkdir(dir, { recursive: true });
  const old = new Date(Date.now() - 3600 * 1000);
  for (let i = 0; i < 40; i++) {
    const file = path.join(dir, `${i}.png`);
    await writeFile(file, 'x');
    if (i < 5) await utimes(file, old, old);
  }
  await session.observe({ mode: 'image', capture: 'native' });
  const left = await readdir(dir);
  assert.equal(left.length, 32);
  for (let i = 0; i < 5; i++) assert.equal(left.includes(`${i}.png`), false);
});

// ---- 3. Lot vérifié ----
test('a batch chains verified steps on internal re-observations and stops at the first unmet step', async t => {
  const { session, sky: s, observation } = await setup(t, { native: { async call(_, op, args) {
    if (args.value === 'one') { s.value = 'one'; return { technique: 'background:uia', effect: 'applied' }; }
    if (args.value === 'two') { s.value = 'deux'; return { technique: 'background:uia', effect: 'applied' }; }
    s.value = 'three'; return { technique: 'background:uia', effect: 'applied' };
  } } });
  const step = (value, expected = value) => ({ kind: 'setValue', selector: { automationId: 'input' }, value, timeoutMs: 0, expect: { selector: { automationId: 'status' }, field: 'value', equals: expected } });
  const r = await session.actBatch(observation, [step('one'), step('two'), step('three')]);
  assert.equal(r.status, 'stopped');
  assert.equal(r.stoppedAt, 1);
  assert.deepEqual(r.steps.map(x => x.status), ['verified', 'unmet']);
  assert.equal(s.value, 'deux'); // la troisième étape n'a jamais été envoyée
  assert.ok(r.observation.elements.length);
  await assert.rejects(session.act(observation, step('x')), /Stale/); // l'observation d'origine a servi une fois
  const next = await session.act(r.observation, step('three'));
  assert.equal(next.status, 'verified');
});

test('a batch validates every step before any input and completes with one report per step', async t => {
  const { session, sky: s, observation } = await setup(t, { native: { async call(_, __, args) { s.value = args.value; return { technique: 'background:uia', effect: 'applied' }; } } });
  const step = value => ({ kind: 'setValue', selector: { automationId: 'input' }, value, expect: { selector: { automationId: 'status' }, field: 'value', equals: value } });
  await assert.rejects(session.actBatch(observation, [step('a'), { kind: 'setValue', selector: { automationId: 'input' }, value: 'b' }]), /Step 1: .*expect/);
  assert.equal(s.value, 'Ready');
  const r = await session.actBatch(await session.observe(), [step('a'), step('b')]);
  assert.equal(r.status, 'completed');
  assert.deepEqual(r.steps.map(x => [x.index, x.status, x.technique]), [[0, 'verified', 'background:uia'], [1, 'verified', 'background:uia']]);
});

test('a batch stops on an unknown outcome and on an emergency stop, which is rethrown with the report', async t => {
  const { session, sky: s, observation, root } = await setup(t, { native: { async call(_, __, args) { if (args.value === 'boom') throw Error('lost'); s.value = args.value; return { effect: 'applied' }; } } });
  const step = value => ({ kind: 'setValue', selector: { automationId: 'input' }, value, expect: { selector: { automationId: 'status' }, field: 'value', equals: value } });
  const r = await session.actBatch(observation, [step('a'), step('boom'), step('c')]);
  assert.deepEqual(r.steps.map(x => x.status), ['verified', 'unknown']);
  assert.equal(r.observation, null);
  await writeFile(path.join(root, 'stop'), JSON.stringify({ by: 'Test', at: Date.now() / 1000, nonce: 'x' }));
  await assert.rejects(session.actBatch(await session.observe(), [step('d')]), error => error.emergencyStop && error.batch.steps[0].status === 'stopped');
  assert.equal(s.value, 'a');
});

// ---- 4. Fenêtres liées ----
function related(state) {
  return async () => ({ ok: true, boundEnabled: state.boundEnabled ?? true, windows: state.windows });
}
test('an owned dialog opened by an action is followed without a new bind, then left when it closes', async t => {
  const state = { windows: [] };
  const dialog = { id: 20, app: 'test!App', title: 'Dialog' };
  const { session, sky: s, observation } = await setup(t, { native: {
    related: related(state),
    async call(_, op, args) {
      if (args.selector.automationId === 'go') { state.windows = [{ id: 20, ownerChain: [10], enabled: true, z: 1 }]; s.windows.push(dialog); }
      else { state.windows = []; s.windows = s.windows.filter(w => w.id !== 20); }
      return { technique: 'background:uia', effect: 'sent' };
    },
  } });
  const opened = await session.act(observation, { kind: 'click', selector: go, expect: { selector: { automationId: 'close' }, exists: true } });
  assert.equal(opened.status, 'verified');
  assert.deepEqual(opened.windowChange, { reason: 'opened', from: 10, to: 20, owned: true });
  assert.equal(opened.observation.window.id, 20);
  assert.deepEqual(opened.observation.windowStack, [10, 20]);
  const closed = await session.act(opened.observation, { kind: 'click', selector: { automationId: 'close' }, expect: { selector: go, exists: true } });
  assert.equal(closed.windowChange.reason, 'closed');
  assert.equal(closed.observation.window.id, 10);
});

test('pre-existing owned windows are not followed, unless the bound window is disabled by them', async t => {
  const state = { windows: [{ id: 30, ownerChain: [10], enabled: true, z: 1 }] };
  const palette = { id: 30, app: 'test!App', title: 'Palette' };
  const { session, sky: s } = await setup(t, { native: { related: related(state) } });
  s.windows.push(palette);
  // La palette existait au bind : l'observation reste sur la fenêtre principale.
  await session.bind({ id: 10 });
  assert.equal((await session.observe()).window.id, 10);
  state.boundEnabled = false; // un dialogue modal possédé bloque la fenêtre principale
  const obs = await session.observe();
  assert.equal(obs.window.id, 30);
  assert.equal(obs.windowChange.reason, 'opened');
});

test('a same-process window appears during an action is followed only if Sky lists it', async t => {
  const state = { windows: [] };
  const { session, sky: s, observation } = await setup(t, { native: {
    related: related(state),
    async call() { state.windows = [{ id: 40, ownerChain: [], enabled: true, z: 1 }, { id: 41, ownerChain: [], enabled: true, z: 2 }]; s.windows.push({ id: 41, app: 'test!App', title: 'Second' }); return { effect: 'sent' }; },
  } });
  const r = await session.act(observation, { kind: 'click', selector: go });
  assert.equal(r.windowChange.to, 41); // 40 n'est pas ciblable par Sky : jamais devinée
});

// ---- 5. Présence de Julien ----
function clock() {
  const c = { now: 1000 };
  return { c, monotonic: () => c.now, sleep: async ms => { c.now += ms; } };
}
test('presence waits for a pause, defers when Julien stays active and ignores own injections in fallback mode', async () => {
  const { c, monotonic, sleep } = clock();
  const p = new Presence({ monotonic });
  assert.equal(p.available, false);
  assert.deepEqual(await p.waitForPause({ sleep }), { waitedMs: 0, source: 'none', idleMs: null });
  p.setSource('raw-input');
  p.input();
  const waited = await p.waitForPause({ quietMs: 500, sleep });
  assert.ok(waited.waitedMs >= 500 && waited.idleMs >= 500);
  let ticks = 0;
  p.input();
  await assert.rejects(p.waitForPause({ quietMs: 500, maxWaitMs: 1000, sleep: async ms => { c.now += ms; if (ticks++ % 2 === 0) p.input(); } }), JulienActiveError);
  const q = new Presence({ monotonic });
  q.setSource('last-input-info');
  const injection = q.beginInjection();
  c.now += 50;
  assert.equal(q.input({ injectedPossible: true }), false); // notre propre frappe
  q.endInjection(injection);
  c.now += 1000;
  assert.equal(q.input({ injectedPossible: true }), true); // celle de Julien
});

test('physical input waits for Julien to pause; an active Julien defers it and nothing is sent', async t => {
  const { c, monotonic, sleep } = clock();
  const presence = new Presence({ monotonic });
  presence.setSource('raw-input');
  const { session, sky: s, observation } = await setup(t, { presence, pause: { quietMs: 400, maxWaitMs: 1200, sleep: async ms => { c.now += ms; presence.input(); } } });
  presence.input();
  await assert.rejects(session.act(observation, { kind: 'click', selector: go }), error => error.julienActive && /rien n'a été envoyé/.test(error.message));
  assert.equal(s.calls.length, 0);
  assert.equal(session.metrics().at(-1).status, 'julien-active');
  const quiet = await setup(t, { presence, pause: { quietMs: 400, maxWaitMs: 1200, sleep } });
  presence.input();
  const r = await quiet.session.act(quiet.observation, { kind: 'click', selector: go, expect: expectDone });
  assert.equal(r.status, 'verified');
  assert.ok(r.waitedMs >= 400);
  assert.equal(r.presence, 'raw-input');
});

test('typing stops between chunks when Julien takes the keyboard back; the rest is never sent', async t => {
  const { c, monotonic } = clock();
  const presence = new Presence({ monotonic });
  presence.setSource('raw-input');
  c.now += 5000;
  const { session, sky: s, observation } = await setup(t, { presence, pause: { quietMs: 400 } });
  s.onType = () => { c.now += 10; presence.input(); }; // Julien tape pendant la première tranche
  const text = 'é'.repeat(120);
  const r = await session.act(observation, { kind: 'typeText', focus: { automationId: 'input' }, text, expect: expectDone });
  assert.equal(r.status, 'interrupted');
  assert.equal(r.verified, false);
  assert.deepEqual(r.typed, { chunks: 1, total: 120 });
  assert.equal(s.calls.length, 1);
  assert.equal(r.julienInput, true);
});

test('background actions never wait for Julien: they do not touch his keyboard, mouse or foreground', async t => {
  const { monotonic } = clock();
  const presence = new Presence({ monotonic });
  presence.setSource('raw-input');
  presence.input(); // Julien tape en ce moment même
  const { session, sky: s, observation } = await setup(t, { presence, native: { async call() { s.done = true; return { technique: 'background:uia', effect: 'sent' }; } } });
  const r = await session.act(observation, { kind: 'click', selector: go, expect: expectDone });
  assert.equal(r.status, 'verified');
  assert.equal(r.waitedMs, undefined);
});

test('text chunks never split a grapheme and cover the whole text', () => {
  const text = 'a👍🏽b'.repeat(40) + '\nligne é';
  const chunks = textChunks(text, 7);
  assert.equal(chunks.join(''), text);
  for (const chunk of chunks) assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(chunk), false);
  assert.ok(chunks.some(chunk => chunk.includes('👍🏽')));
  assert.deepEqual(textChunks(''), ['']);
});

test('state digest sees values and states that the structure hash ignores', () => {
  const a = parseTree('0 window W\n\t1 edit Name Value: x ID: n');
  const b = parseTree('0 window W\n\t1 edit Name Value: y ID: n');
  assert.notEqual(stateDigest(a), stateDigest(b));
});

// ---- 6. Revue croisée du 16/10 : premier plan, présence, arrêt pendant la frappe, élément hors champ ----
function activeJulien(c, presence) {
  // Julien tape sans pause : chaque attente voit une nouvelle entrée.
  return { quietMs: 400, maxWaitMs: 1200, sleep: async ms => { c.now += ms; presence.input(); } };
}
test('activate waits for Julien to pause like any foreground input; an active Julien defers it', async t => {
  const { c, monotonic } = clock();
  const presence = new Presence({ monotonic });
  presence.setSource('raw-input');
  const { session, sky: s, tokens } = await setup(t, { presence, pause: activeJulien(c, presence) });
  let activations = 0;
  s.activate_window = async () => { activations++; };
  presence.input();
  await assert.rejects(session.activate(), error => error.julienActive && /rien n'a été envoyé/.test(error.message));
  assert.equal(activations, 0);
  assert.equal(tokens(), 0);
});

test('Sky set_value and secondary actions, which can give focus, wait for Julien and run under the token', async t => {
  const { c, monotonic } = clock();
  const presence = new Presence({ monotonic });
  presence.setSource('raw-input');
  const { session, sky: s, observation, tokens } = await setup(t, { presence, pause: activeJulien(c, presence) });
  presence.input();
  await assert.rejects(session.act(observation, { kind: 'setValue', selector: { automationId: 'input' }, value: 'x' }), error => error.julienActive);
  assert.equal(s.calls.length, 0);
  assert.equal(tokens(), 0);
  const quiet = await setup(t, { presence, pause: { quietMs: 400, maxWaitMs: 1200, sleep: async ms => { c.now += ms; } } });
  presence.input();
  const r = await quiet.session.act(quiet.observation, { kind: 'setValue', selector: { automationId: 'input' }, value: 'x', expect: expectDone });
  assert.equal(r.status, 'verified');
  assert.equal(r.technique, 'sky:semantic');
  assert.equal(quiet.tokens(), 1);
  assert.ok(r.waitedMs >= 400);
});

test('every foreground action hands its target window to the token helper and reports the window given back', async t => {
  const seen = [];
  const { session, sky: s, observation } = await setup(t, { native: {
    async withForeground(purpose, action, options) {
      seen.push([purpose, options?.window?.id]);
      const value = await action();
      options?.onRelease?.('restored');
      return value;
    },
  } });
  const r = await session.act(observation, { kind: 'click', selector: go, expect: expectDone });
  assert.equal(r.technique, 'physical:sky');
  assert.equal(r.foregroundReturned, 'restored');
  await session.activate();
  assert.deepEqual(seen, [['Sky click', 10], ['activate_window', 10]]);
  assert.equal(s.calls.length, 1);
});

test('the token transport passes the target window and reads the give-back report, also after a failed action', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-codex-token-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const native = new NativeUIA(process.execPath, { tokenArgs: [fileURLToPath(new URL('./fixtures/token-helper.mjs', import.meta.url))], emergencyStop: stopIn(root) });
  const states = [];
  assert.equal(await native.withForeground('fixture', async () => 42, { window: { id: 77, app: 'x' }, onRelease: s => states.push(s) }), 42);
  await assert.rejects(native.withForeground('fixture', async () => { throw Error('action failed'); }, { window: { id: 78, app: 'x' }, onRelease: s => states.push(s) }), /action failed/);
  await native.withForeground('fixture', async () => {}, { onRelease: s => states.push(s) });
  assert.deepEqual(states, ['restored:77', 'restored:78', 'none']);
});

test('an emergency stop pressed while typing stops before the next character; nothing more is sent', async t => {
  const { session, sky: s, observation, root } = await setup(t);
  s.onType = () => { if (s.calls.length === 2) writeFileSync(path.join(root, 'stop'), JSON.stringify({ by: 'Test', at: Date.now() / 1000, nonce: 'typing' })); };
  const r = await session.act(observation, { kind: 'typeText', focus: { automationId: 'input' }, text: 'abcdefghij', expect: expectDone });
  assert.equal(r.status, 'interrupted');
  assert.equal(r.interrupted, 'emergency-stop');
  assert.deepEqual(r.typed, { chunks: 2, total: 10 });
  assert.deepEqual(s.calls.map(c => c[1]), ['a', 'b']);
});

test('a planned guard with unknown presence defers physical input instead of assuming Julien is idle', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-codex-bg-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stop = stopIn(root);
  t.after(() => stop.close());
  stop.startGuard(process.execPath, [fileURLToPath(new URL('./fixtures/guard.mjs', import.meta.url)), '-', 'silent']);
  const provider = sky();
  const session = new WindowsSession(provider, { stateRoot: root, native: { async withForeground(_, action) { return action(); } }, emergencyStop: stop, pause: { sleep: async () => {} } });
  await session.bind({ id: 10 });
  await assert.rejects(session.act(await session.observe(), { kind: 'click', selector: go }), error => error.presenceUnknown && error.deferred && /rien n'a été envoyé/.test(error.message));
  assert.equal(provider.calls.length, 0);
  assert.equal(session.metrics().at(-1).status, 'deferred');
});

test('a click on an off-screen target with no visible part is refused before any input', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-codex-bg-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const s = sky();
  let hidden = true;
  const native = nativeTree(s, { async call() { this.calls.push('call'); s.done = true; return { technique: 'background:uia', effect: 'sent' }; } });
  s.get_window_state = (orig => async input => ({ ...(await orig(input)), accessibility: null }))(s.get_window_state.bind(s));
  native.inspect = (inspect => async window => {
    const r = await inspect(window);
    r.elements = r.elements.map(e => e.index === 0 ? { ...e, bounds: [0, 0, 800, 600] }
      : e.automationId === 'go' ? { ...e, flags: hidden ? ['offscreen'] : [], bounds: hidden ? [0, 900, 80, 24] : [10, 10, 80, 24] } : e);
    return r;
  })(native.inspect.bind(native));
  const session = new WindowsSession(s, { stateRoot: root, native, emergencyStop: stopIn(root) });
  await session.bind({ id: 10 });
  await assert.rejects(session.act(await session.observe(), { kind: 'click', selector: go, expect: expectDone }), error => error.beforeInput && /off-screen/.test(error.message));
  assert.deepEqual(native.calls, []);
  hidden = false;
  assert.equal((await session.act(await session.observe(), { kind: 'click', selector: go, expect: expectDone })).status, 'verified');
});
