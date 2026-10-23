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

test('a key is first posted in background; not applicable (WPF, Chromium) falls back to Sky; sent is never replayed', async t => {
  {
    const seen = [];
    const { session, sky: s, observation } = await setup(t, { native: { async call(_w, op, args) { seen.push([op, args.key]); return { technique: 'background:messages', effect: 'sent' }; } } });
    const r = await session.act(observation, { kind: 'key', key: 'Control_L+k' });
    assert.deepEqual(seen, [['key', 'Control_L+k']]);
    assert.equal(r.technique, 'background:messages');
    assert.equal(s.calls.length, 0);
  }
  {
    const { session, sky: s, observation } = await setup(t, { native: { async call() { throw notApplicable('This interface ignores posted keys'); } } });
    await session.act(observation, { kind: 'key', key: 'Control_L+k' });
    assert.equal(s.calls.filter(c => c[0] === 'key').length, 1);
  }
});

test('a point of a native capture is clicked in background at frame origin + point; not applicable is refused (no Sky input)', async t => {
  const shot = { path: 'x.png', width: 400, height: 300, method: 'printwindow', scale: 1, ms: 5, frame: { left: 100, top: 50, width: 400, height: 300 } };
  {
    const seen = [];
    const { session, sky: s } = await setup(t, { native: { async capture() { return shot; }, async call(_w, op, args) { seen.push([op, args]); return { technique: 'background:messages', effect: 'sent' }; } } });
    const obs = await session.observe({ mode: 'image', capture: 'native' });
    const id = obs.images[0].id;
    assert.match(id, /^native-/);
    await session.act(obs, { kind: 'click', screenshotId: id, point: { x: 10, y: 20 }, button: 'right' });
    assert.equal(seen[0][0], 'point');
    assert.deepEqual([seen[0][1].x, seen[0][1].y, seen[0][1].button, seen[0][1].action], [110, 70, 'right', 'click']);
    assert.deepEqual(seen[0][1].frame, [100, 50, 400, 300]);
    assert.equal(s.calls.length, 0);
  }
  {
    const { session, sky: s } = await setup(t, { native: { async capture() { return shot; }, async call() { throw notApplicable('This interface ignores posted mouse input'); } } });
    const obs = await session.observe({ mode: 'both', capture: 'native' });
    await assert.rejects(session.act(obs, { kind: 'click', screenshotId: obs.images[0].id, point: { x: 10, y: 20 } }), /nothing was sent/);
    assert.equal(s.calls.length, 0);
  }
  {
    const { session } = await setup(t, { native: { async capture() { return shot; }, async call() { return { effect: 'sent' }; } } });
    const obs = await session.observe({ mode: 'image', capture: 'native' });
    await assert.rejects(session.act(obs, { kind: 'click', screenshotId: obs.images[0].id, point: { x: 401, y: 20 } }), /outside/);
  }
  {
    // Sans aucun élément lu sous le point, un clic gauche est refusé par la confirmation (ce qu'il déclencherait est inconnu).
    const { session } = await setup(t, { native: { async capture() { return shot; }, async call() { return { effect: 'sent' }; } } });
    const obs = await session.observe({ mode: 'image', capture: 'native' });
    await assert.rejects(session.act(obs, { kind: 'click', screenshotId: obs.images[0].id, point: { x: 10, y: 20 } }), /nothing is known under the point/);
  }
});

test('physical input goes through the helper itself (no Sky): native point, key and chunked typing under the token', async t => {
  // Décision de Julien du 22/10 : vraie souris et vrai clavier propres au helper (Physical.cs), Sky en secours seulement.
  const shot = { path: 'x.png', width: 400, height: 300, method: 'printwindow', scale: 1, ms: 5, frame: { left: 100, top: 50, width: 400, height: 300 } };
  const calls = [];
  const native = {
    async capture() { return shot; },
    async call(_w, op, args) {
      calls.push([op, args]);
      if (op !== 'physical') throw notApplicable('This interface ignores posted mouse input');
      return { ok: true, technique: 'physical:native', mechanism: `SendInput ${args.action}`, effect: 'sent', foregroundTaken: true };
    },
  };
  const { session, sky: s, tokens } = await setup(t, { native });
  const obs = await session.observe({ mode: 'both', capture: 'native' });
  const clicked = await session.act(obs, { kind: 'click', screenshotId: obs.images[0].id, point: { x: 10, y: 20 }, button: 'right', count: 1 });
  assert.equal(clicked.technique, 'physical:native');
  assert.deepEqual(calls.at(-1), ['physical', { action: 'click', x: 110, y: 70, frame: [100, 50, 400, 300], button: 'right', count: 1 }]);
  const wheelObs = await session.observe({ mode: 'both', capture: 'native' });
  const scrolled = await session.act(wheelObs, { kind: 'scroll', screenshotId: wheelObs.images[0].id, point: { x: 5, y: 5 }, scrollY: 120, scrollX: 0 });
  assert.equal(scrolled.technique, 'physical:native');
  assert.deepEqual(calls.at(-1), ['physical', { action: 'wheel', x: 105, y: 55, frame: [100, 50, 400, 300], deltaY: -120, deltaX: 0 }]);
  const keyed = await session.act(await session.observe(), { kind: 'key', key: 'Control_L+k' });
  assert.equal(keyed.technique, 'physical:native');
  assert.deepEqual(calls.at(-1), ['physical', { action: 'key', key: 'Control_L+k' }]);
  assert.equal(s.calls.length, 0); // Sky n'a jamais été appelé pour une entrée
  assert.ok(tokens() >= 2); // chaque entrée physique sous le jeton commun
});

test('native physical: drag at native points, typing interrupted after a sent chunk is partial (accord never given back)', async t => {
  // Relecture de Codex du 22/10 12:22 (P2-4, P1-3).
  const shot = { path: 'x.png', width: 400, height: 300, method: 'printwindow', scale: 1, ms: 5, frame: { left: 100, top: 50, width: 400, height: 300 } };
  {
    const calls = [];
    const { session, sky: s } = await setup(t, { native: { async capture() { return shot; }, async call(_w, op, args) {
      calls.push([op, args]); if (op !== 'physical') throw notApplicable('no background'); return { mechanism: 'SendInput drag' }; } } });
    const obs = await session.observe({ mode: 'both', capture: 'native' });
    const r = await session.act(obs, { kind: 'drag', screenshotId: obs.images[0].id, from: { x: 10.7, y: 20 }, to: { x: 30, y: 40 } });
    assert.equal(r.technique, 'physical:native');
    assert.deepEqual(calls.at(-1), ['physical', { action: 'drag', x: 110, y: 70, frame: [100, 50, 400, 300], toX: 130, toY: 90 }]);
    assert.equal(s.calls.length, 0);
  }
  {
    const typed = [];
    let n = 0;
    const { session, sky: s, observation } = await setup(t, { native: { async call(_w, op, args) {
      if (op !== 'physical') throw notApplicable('no background');
      if (++n === 2) throw Object.assign(Error('Window is disabled (a modal dialog may be open)'), { refused: true });
      typed.push(args.text); return { mechanism: 'SendInput unicode text' }; } } });
    const text = 'a'.repeat(60) + 'b';
    await assert.rejects(session.act(observation, { kind: 'typeText', focus: { automationId: 'input' }, text }), error => {
      // Issue inconnue (jamais un refus avant entrée) : la cause porte l'état partiel.
      assert.match(error.message, /outcome is unknown/);
      assert.equal(error.cause.afterInput, true);
      assert.equal(error.cause.refused, false);
      assert.equal(error.cause.typed?.chunks, 1);
      return true;
    });
    assert.equal(typed.length, 1);
    assert.equal(s.calls.length, 0);
  }
});

test('fallback:false forbids physical input even when no background technique applies (nothing sent)', async t => {
  const { session, sky: s, observation } = await setup(t, { native: { async call() { throw notApplicable('No background technique'); } } });
  await assert.rejects(session.act(observation, { kind: 'click', selector: go, fallback: false }), /fallback:false/);
  assert.equal(s.calls.length, 0);
  assert.equal(session.metrics().at(-1).status, 'refused');
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

test('a DevTools title cleanup that failed is terminal: no physical wheel follows; a Sky image never takes the DevTools path', async t => {
  // Preuve C de la relecture de Codex du 22/10 : la page est peut-être modifiée (titre de test resté) ; le helper refuse
  // (ActionRefusedException) et aucune autre technique ne suit.
  const cleanupFailed = () => Object.assign(Error('Test title « nexus-x » may remain on the page: cleanup failed on two connections; no wheel was sent and no other technique may follow'), { refused: true });
  const shot = { path: 'x.png', width: 400, height: 300, method: 'printwindow', scale: 1, ms: 5, frame: { left: 100, top: 50, width: 400, height: 300 } };
  {
    const ops = [];
    const { session, sky: s } = await setup(t, { native: { async capture() { return shot; }, async call(_w, op) { ops.push(op); throw cleanupFailed(); } } });
    s.scroll = async input => { s.calls.push(['scroll', input]); };
    const obs = await session.observe({ mode: 'both', capture: 'native' });
    await assert.rejects(session.act(obs, { kind: 'scroll', screenshotId: obs.images[0].id, point: { x: 10, y: 20 }, scrollY: 120, scrollX: 0 }), /may remain on the page/);
    assert.deepEqual(ops, ['point']);
    assert.equal(s.calls.length, 0);
    assert.equal(session.metrics().at(-1).status, 'refused');
  }
  {
    // Image Sky (entrée physique permise) : molette physique directe, jamais la preuve DevTools (aucun titre posé).
    const ops = [];
    const { session, sky: s } = await setup(t, { native: { async call(_w, op) { ops.push(op); throw cleanupFailed(); } } });
    s.scroll = async input => { s.calls.push(['scroll', input]); };
    const obs = await session.observe({ mode: 'both' });
    await session.act(obs, { kind: 'scroll', screenshotId: obs.screenshots[0].id, point: { x: 10, y: 20 }, scrollY: 120, scrollX: 0 });
    assert.deepEqual(ops, []);
    assert.equal(s.calls.length, 1);
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

test('auto reads native state when a nonempty Sky tree stays stale after background input', async t => {
  let value = 'initial', saves = 0;
  const inputs = [];
  const { session, sky: s, observation, tokens } = await setup(t, { native: {
    async inspect(window) {
      const tree = `0 window Test\n\t1 edit Input Value: ${value} ID: input\n\t2 button Go ID: go\n\t3 text Status Value: ${saves ? 'Done' : 'Ready'} ID: status`;
      return { window, revision: digest('native-live-state'), accessibility: { tree },
        elements: parseTree(tree).map(e => ({ ...e, runtimeId: [9, e.index] })) };
    },
    async call(_, op, args) {
      inputs.push(op);
      if (op === 'setValue') value = args.value;
      if (op === 'click') saves++;
      return { technique: 'background:messages', effect: 'applied', foregroundTaken: false };
    },
  } });
  assert.equal(observation.source, 'native-uia');
  const result = await session.actBatch(observation, [
    { kind: 'setValue', selector: { automationId: 'input' }, value: 'Bonjour é Ω',
      expect: { selector: { automationId: 'input' }, field: 'value', equals: 'Bonjour é Ω' } },
    { kind: 'click', selector: go, expect: expectDone },
  ]);
  assert.equal(result.status, 'completed', JSON.stringify(result.steps));
  assert.deepEqual(result.steps.map(step => step.status), ['verified', 'verified']);
  assert.equal(result.observation.source, 'native-uia');
  assert.deepEqual(inputs, ['setValue', 'click']);
  assert.equal(saves, 1);
  assert.equal(s.done, false); // Sky remains stale; it did not supply the proof.
  assert.equal(s.states ?? 0, 0);
  assert.equal(s.calls.length, 0);
  assert.equal(tokens(), 0);
});

test('explicit Sky stays selected through input and verification; bind restores the native default', async t => {
  const { sky: s, root } = await setup(t);
  const native = nativeTree(s, { async call() { s.done = true; return { technique: 'background:uia', effect: 'applied' }; } });
  const session = new WindowsSession(s, { stateRoot: root, native, emergencyStop: stopIn(root) });
  t.after(() => session.close());
  await session.bind({ id: 10 });
  assert.equal((await session.observe()).source, 'native-uia');
  const skyObservation = await session.observe({ backend: 'sky' });
  assert.equal(skyObservation.source, 'sky');
  const result = await session.act(skyObservation, { kind: 'click', selector: go, expect: expectDone });
  assert.equal(result.status, 'verified');
  assert.equal(result.observation.source, 'sky');
  const current = await session.observe();
  assert.equal(current.source, 'sky');
  assert.equal((await session.observe({ backend: 'native' })).source, 'native-uia');
  await assert.rejects(session.act(current, { kind: 'click', selector: go }), /Stale/);
  await session.observe({ backend: 'sky' });
  await session.bind({ id: 10 });
  assert.equal((await session.observe()).source, 'native-uia');
});

test('native auto uses Sky only for images and does not inspect native state in image-only mode', async t => {
  const { sky: s, root } = await setup(t);
  const native = nativeTree(s);
  const skyReads = [];
  s.get_window_state = (read => async input => { skyReads.push(input); return read(input); })(s.get_window_state.bind(s));
  let reads = 0;
  native.inspect = (inspect => async window => { reads++; return inspect(window); })(native.inspect.bind(native));
  const session = new WindowsSession(s, { stateRoot: root, native, emergencyStop: stopIn(root) });
  t.after(() => session.close());
  await session.bind({ id: 10 });
  const both = await session.observe({ mode: 'both' });
  assert.equal(both.source, 'native-uia');
  assert.equal(reads, 1);
  assert.equal(skyReads.length, 1);
  assert.equal(skyReads[0].include_text, false);
  assert.equal(skyReads[0].include_screenshot, true);
  await session.observe({ mode: 'image' });
  assert.equal(reads, 1);
  assert.equal(skyReads.length, 2);
  assert.equal(skyReads[1].include_text, false);
  assert.equal(skyReads[1].include_screenshot, true);
});

test('a right or double click on a native target sends its identity to the helper, never an old centre', async t => {
  // Relecture de Codex du 22/10 12:22 (P1-2) : le helper relit la cible sous le jeton, après la mise au premier plan.
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-codex-bg-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const s = sky();
  s.get_window_state = (orig => async input => ({ ...(await orig(input)), accessibility: null }))(s.get_window_state.bind(s));
  const sent = [];
  const native = nativeTree(sky(), {
    async call(_, op, args) {
      sent.push([op, args]);
      if (op !== 'physical') throw notApplicable('No background technique');
      return { mechanism: 'SendInput right click x1' };
    },
  });
  native.withForeground = async (_purpose, action) => action({ held: () => true });
  const session = new WindowsSession(s, { stateRoot: root, native, emergencyStop: stopIn(root) });
  await session.bind({ id: 10 });
  const obs = await session.observe();
  assert.equal(obs.source, 'native-uia');
  const r = await session.act(obs, { kind: 'click', selector: go, button: 'right' });
  assert.equal(r.technique, 'physical:native');
  const [op, args] = sent.at(-1);
  assert.equal(op, 'physical');
  assert.equal(args.action, 'click');
  assert.equal(args.button, 'right');
  assert.deepEqual(args.selector, go);
  assert.ok(Array.isArray(args.runtimeId) && Array.isArray(args.ancestry));
  assert.equal(args.x, undefined); // aucun centre ancien : le helper le recalcule
  assert.equal(s.calls.length, 0);
  // Relecture de Codex du 22/10 13:57 : vraie entrée non applicable → jamais réduit à un Invoke UIA au premier plan.
  sent.length = 0;
  native.call = async function (_, op, args) { sent.push([op, args]); throw notApplicable('Accessibility identity unavailable'); };
  await assert.rejects(session.act(await session.observe(), { kind: 'click', selector: go, button: 'right' }), /nothing was sent/);
  assert.ok(sent.every(([, a]) => a.mode !== 'foreground'));
  assert.equal(s.calls.length, 0);
});

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

test('physical input reactivates its target inside the lease before sending a click', async t => {
  let held=false;const order=[];
  const {session,sky:s,observation}=await setup(t,{native:{async withForeground(_,run){held=true;try{return await run()}finally{held=false}}}});
  s.activate_window=async ({window})=>{assert.equal(held,true);assert.equal(window.id,10);order.push('activate')};
  const originalClick=s.click.bind(s);s.click=async input=>{assert.equal(held,true);order.push('click');return originalClick(input)};
  await session.act(observation,{kind:'click',selector:go,expect:expectDone});
  assert.deepEqual(order,['activate','click']);assert.equal(held,false);
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

test('a posted gesture that made the target take the foreground reports the give-back up to the result', async t => {
  // Relecture de Codex (21/10) : le helper rendait foregroundReturned, la session le jetait (résultat et lot).
  const { session, sky: s, observation } = await setup(t, { native: {
    async call() { s.done = true; return { ok: true, technique: 'background:messages', mechanism: 'posted left click', effect: 'sent', foregroundTaken: true, foregroundReturned: 'restored' }; },
  } });
  const r = await session.act(observation, { kind: 'click', selector: go, expect: expectDone });
  assert.equal(r.status, 'verified');
  assert.equal(r.foregroundTaken, true);
  assert.equal(r.foregroundReturned, 'restored');
});

test('the lease release says "keep" when Julien takes the mouse during physical input', async t => {
  // Relecture de Codex (21/10) : le helper remettait l'ancienne fenêtre devant alors que Julien venait de cliquer dans
  // la cible pendant le bail ; seule la présence de la session distingue sa saisie des injections de l'agent.
  const { c, monotonic } = clock();
  const presence = new Presence({ monotonic });
  presence.setSource('raw-input');
  c.now += 5000;
  let kept = null;
  const { session, sky: s, observation } = await setup(t, { presence, pause: { quietMs: 400 }, native: {
    async call() { throw notApplicable('no background technique'); },
    async withForeground(_, action, options) { try { return await action(); } finally { kept = options.keep?.() ?? null; } },
  } });
  s.click = async input => { s.calls.push(['click', input]); c.now += 10; presence.input(); s.done = true; };
  await session.act(observation, { kind: 'click', selector: go, expect: expectDone });
  assert.equal(kept, true);
});

test('the token transport says keep, and a helper lost during the action makes the outcome unknown', async t => {
  // Relecture de Codex (21/10) : la perte du helper n'était contrôlée qu'avant l'action ; elle continuait sans verrou.
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-codex-token-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = fileURLToPath(new URL('./fixtures/token-helper.mjs', import.meta.url));
  const native = new NativeUIA(process.execPath, { tokenArgs: [fixture], emergencyStop: stopIn(root) });
  const states = [];
  await native.withForeground('fixture', async () => {}, { window: { id: 77, app: 'x' }, keep: () => true, onRelease: s => states.push(s) });
  assert.deepEqual(states, ['kept-by-julien']);
  const dying = new NativeUIA(process.execPath, { tokenArgs: [fixture, '--exit-after', '20'], emergencyStop: stopIn(root) });
  let heldAfter = null;
  await assert.rejects(dying.withForeground('fixture', async lease => { await new Promise(r => setTimeout(r, 150)); heldAfter = lease.held(); return 'continued'; }), /outcome unknown/);
  assert.equal(heldAfter, false);
});

test('an interaction ended right after Julien clicked keeps his choice (no wait for the periodic check)', async t => {
  // Relecture de Codex (21/10) : keep ne dépendait que de la raison « julien-active », posée par le contrôle périodique.
  const { c, monotonic } = clock();
  const presence = new Presence({ monotonic });
  presence.setSource('raw-input');
  c.now += 5000;
  let kept = null;
  const { session } = await setup(t, { presence, pause: { quietMs: 400 }, native: {
    async withForeground(_, action, options) { try { return await action(); } finally { kept = options.keep?.() ?? null; } },
  } });
  await session.beginInteraction();
  c.now += 10;
  presence.input();
  await session.endInteraction();
  assert.equal(kept, true);
});

test('a token helper lost during the activation sends nothing', async t => {
  // Relecture de Codex (21/10) : la touche partait sans jeton après l'activation ; dans une interaction, l'action
  // perdue rendait « verified » jusqu'à la fin de l'interaction.
  const fixture = fileURLToPath(new URL('./fixtures/token-helper.mjs', import.meta.url));
  const { root, session, sky: s, observation } = await setup(t, { native: { async call() { throw notApplicable('none'); } } });
  const dying = new NativeUIA(process.execPath, { tokenArgs: [fixture, '--exit-after', '20'], emergencyStop: stopIn(root) });
  const lone = new WindowsSession(s, { stateRoot: root, native: { withForeground: dying.withForeground.bind(dying), call: async () => { throw notApplicable('none'); } }, emergencyStop: stopIn(root) });
  await lone.bind({ id: 10 });
  const seen = await lone.observe();
  s.activate_window = async () => { await new Promise(r => setTimeout(r, 150)); };
  await assert.rejects(lone.act(seen, { kind: 'key', key: 'a' }));
  assert.equal(s.calls.filter(c => c[0] === 'key').length, 0);
  void session; void observation;
});

test('in an interaction whose token helper died, nothing is sent and no action reports success', async t => {
  // Relecture de Codex (21/10) : touche « verified » et setValue en fond envoyés après la perte du helper du bail.
  const fixture = fileURLToPath(new URL('./fixtures/token-helper.mjs', import.meta.url));
  const { root, sky: s } = await setup(t);
  const dying = new NativeUIA(process.execPath, { tokenArgs: [fixture, '--exit-after', '50'], emergencyStop: stopIn(root) });
  const calls = [];
  const session = new WindowsSession(s, { stateRoot: root, emergencyStop: stopIn(root),
    native: { withForeground: dying.withForeground.bind(dying), call: async (w, op) => { if (op !== 'activate') calls.push(op); return { technique: 'background:messages', effect: 'sent' }; } } });
  await session.bind({ id: 10 });
  await session.observe();
  const observation = await session.beginInteraction({ durationMs: 2000 });
  await new Promise(r => setTimeout(r, 150));
  await assert.rejects(session.act(observation, { kind: 'key', key: 'Escape', expect: expectDone }));
  assert.equal(s.calls.filter(c => c[0] === 'key').length, 0);
  assert.deepEqual(calls, []);
  await session.endInteraction().catch(() => {});
});

test('a batch never takes a new lease after its interaction expired, and a token lost during a background call is unknown', async t => {
  // Relecture de Codex (21/10) : l'étape suivante d'un lot reprenait un jeton neuf ; un setValue en fond pendant lequel
  // le helper mourait rendait « verified ».
  const fixture = fileURLToPath(new URL('./fixtures/token-helper.mjs', import.meta.url));
  const { root, sky: s } = await setup(t);
  let leases = 0;
  const live = new NativeUIA(process.execPath, { tokenArgs: [fixture], emergencyStop: stopIn(root) });
  const session = new WindowsSession(s, { stateRoot: root, emergencyStop: stopIn(root),
    native: { withForeground: (...a) => { leases++; return live.withForeground(...a); }, call: async () => { throw notApplicable('none'); } } });
  await session.bind({ id: 10 });
  await session.observe();
  const read = s.get_window_state.bind(s);
  let slow = false;
  s.get_window_state = async input => { if (slow) await new Promise(r => setTimeout(r, 400)); return read(input); };
  // Première étape envoyée et vérifiée ; sa relecture est lente et le bail (300 ms) expire pendant elle.
  s.press_key = async input => { s.calls.push(['key', input.key]); s.done = !s.done; slow = true; };
  let observation = await session.beginInteraction({ durationMs: 300 });
  const batch = await session.actBatch(observation, [
    { kind: 'key', key: 'a', expect: expectDone },
    { kind: 'key', key: 'b', expect: { ...expectDone, equals: 'Ready' } },
  ]);
  assert.equal(batch.steps[0].status, 'verified');
  assert.equal(batch.status, 'stopped');
  assert.equal(batch.stoppedAt, 1);
  assert.equal(leases, 1);
  assert.deepEqual(s.calls.filter(c => c[0] === 'key').map(c => c[1]), ['a']);
  s.get_window_state = read;

  const dying = new NativeUIA(process.execPath, { tokenArgs: [fixture, '--exit-after', '50'], emergencyStop: stopIn(root) });
  const lost = new WindowsSession(s, { stateRoot: root, emergencyStop: stopIn(root),
    native: { withForeground: dying.withForeground.bind(dying),
      // Mise au premier plan native du bail (« activate ») : immédiate ; seule l'action d'arrière-plan est lente.
      call: async (_w, op) => { if (op === 'activate') return { effect: 'applied' }; await new Promise(r => setTimeout(r, 150)); s.done = true; return { technique: 'background:uia', effect: 'applied' }; } } });
  await lost.bind({ id: 10 });
  await lost.observe();
  s.done = false;
  observation = await lost.beginInteraction({ durationMs: 2000 });
  await assert.rejects(lost.act(observation, { kind: 'click', selector: go, expect: expectDone }), /unknown/);
  await lost.endInteraction().catch(() => {});
});

test('an interaction that ends normally during the refresh keeps a partial typing result, not an unknown one', async t => {
  // Relecture de Codex (21/10) : la libération normale du bail passait pour une perte du helper (held() faux).
  const fixture = fileURLToPath(new URL('./fixtures/token-helper.mjs', import.meta.url));
  const { root, sky: s } = await setup(t);
  const live = new NativeUIA(process.execPath, { tokenArgs: [fixture], emergencyStop: stopIn(root) });
  const session = new WindowsSession(s, { stateRoot: root, emergencyStop: stopIn(root),
    native: { withForeground: live.withForeground.bind(live), call: async () => { throw notApplicable('none'); } } });
  await session.bind({ id: 10 });
  await session.observe();
  const read = s.get_window_state.bind(s);
  let typed = false;
  s.get_window_state = async input => { if (typed) await new Promise(r => setTimeout(r, 80)); return read(input); };
  s.type_text = async input => { s.calls.push(['type', input.text]); typed = true; await new Promise(r => setTimeout(r, 80)); };
  const observation = await session.beginInteraction({ durationMs: 100 });
  const r = await session.act(observation, { kind: 'typeText', focus: { automationId: 'input' }, text: 'abcdef' });
  assert.equal(r.status, 'interrupted');
  assert.ok(r.typed.chunks >= 1 && r.typed.chunks < 6);
});

test('a helper lost during a background call stays lost when the interaction then expires', async t => {
  // Relecture de Codex (21/10) : la clôture du bail repassait held() à vrai après une perte réelle (« verified »).
  const fixture = fileURLToPath(new URL('./fixtures/token-helper.mjs', import.meta.url));
  const { root, sky: s } = await setup(t);
  const dying = new NativeUIA(process.execPath, { tokenArgs: [fixture, '--exit-after', '50'], emergencyStop: stopIn(root) });
  const session = new WindowsSession(s, { stateRoot: root, emergencyStop: stopIn(root),
    native: { withForeground: dying.withForeground.bind(dying),
      // Mise au premier plan native du bail (« activate ») : immédiate ; seule l'action d'arrière-plan est lente.
      call: async (_w, op) => { if (op === 'activate') return { effect: 'applied' }; await new Promise(r => setTimeout(r, 150)); s.done = true; return { technique: 'background:uia', effect: 'applied' }; } } });
  await session.bind({ id: 10 });
  await session.observe();
  s.done = false;
  const observation = await session.beginInteraction({ durationMs: 100 });
  await assert.rejects(session.act(observation, { kind: 'click', selector: go, expect: expectDone }), /unknown/);
  await session.endInteraction().catch(() => {});
});

test('a helper that dies while the Node loop is busy is a lost token, never a success', async t => {
  // Relecture de Codex (21/10) : la fermeture notifiée après l'action passait pour une libération normale. Seul l'accusé
  // « released » du helper prouve une libération normale.
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-codex-token-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = fileURLToPath(new URL('./fixtures/token-helper.mjs', import.meta.url));
  const dying = new NativeUIA(process.execPath, { tokenArgs: [fixture, '--exit-after', '20'], emergencyStop: stopIn(root) });
  const busy = ms => { const end = Date.now() + ms; while (Date.now() < end) { /* boucle occupée */ } };
  await assert.rejects(dying.withForeground('fixture', async () => { await new Promise(r => setTimeout(r, 0)); busy(150); return 'accepted'; }), /outcome unknown/);
  const live = new NativeUIA(process.execPath, { tokenArgs: [fixture], emergencyStop: stopIn(root) });
  assert.equal(await live.withForeground('fixture', async () => { busy(50); return 'accepted'; }), 'accepted');
});

test('in an open interaction, a helper that died while the Node loop was busy makes the action unknown at once', async t => {
  // Relecture de Codex (21/10) : bail ouvert, « close » pas encore traité : l'action rendait « verified ».
  const fixture = fileURLToPath(new URL('./fixtures/token-helper.mjs', import.meta.url));
  const { root, sky: s } = await setup(t);
  const dying = new NativeUIA(process.execPath, { tokenArgs: [fixture, '--exit-after', '20'], emergencyStop: stopIn(root) });
  const session = new WindowsSession(s, { stateRoot: root, emergencyStop: stopIn(root),
    native: { withForeground: dying.withForeground.bind(dying), call: async () => { throw notApplicable('none'); } } });
  await session.bind({ id: 10 });
  await session.observe();
  const busy = ms => { const end = Date.now() + ms; while (Date.now() < end) { /* boucle occupée */ } };
  s.press_key = async input => { s.calls.push(['key', input.key]); busy(150); s.done = true; };
  const observation = await session.beginInteraction({ durationMs: 2000 });
  await assert.rejects(session.act(observation, { kind: 'key', key: 'a', expect: expectDone }), /unknown/);
  await session.endInteraction().catch(() => {});
});
