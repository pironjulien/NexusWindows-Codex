import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WindowsSession } from '../lib/session.mjs';
import { ApplicationMemory } from '../lib/memory.mjs';
import { parseTree, uniqueElement, structureHash, checkExpectation, digest } from '../lib/tree.mjs';

const button = { automationId: 'go', role: 'button' };
const expectDone = { selector: { automationId: 'status' }, field: 'value', equals: 'Done' };

test('activation captures its target before returning the foreground', async () => {
  const window={id:7,app:'fixture',title:'Test'};let held=false,captured=false,returned=false;
  const sky={target:'windows',async list_windows(){return [window]},async get_window(){return window},
    async activate_window(){assert.equal(held,true)},
    async get_window_state(){assert.equal(held,true);captured=true;return {window,accessibility:{tree:'0 window Test'},screenshots:[]}}};
  const native={async withForeground(purpose,run){held=true;try{return await run()}finally{held=false;returned=true}}};
  const session=new WindowsSession(sky,{native});
  try{await session.bind({id:7});const observation=await session.activate();assert.equal(captured,true);assert.equal(returned,true);assert.equal(observation.window.id,7)}finally{await session.close()}
});
test('foreground contention prevents physical input and reports a deferred outcome', async t => {
  const { session, sky, observation } = await setup(t, { native: {
    async withForeground() { throw Object.assign(Error('Other agent holds foreground; action deferred'), { deferred: true }); },
  } });
  await assert.rejects(session.act(observation, { kind: 'click', selector: button }), /action deferred/);
  assert.equal(sky.calls.length, 0);
  assert.equal(session.metrics()[0].status, 'deferred');
});

test('a bounded interaction keeps transient menus under one foreground lease', async t => {
  let held = false, leases = 0;
  const { session, sky } = await setup(t, { backend: 'sky', native: {
    async withForeground(_, run, options) { leases++; held = true; try { return await run(); } finally { held = false; options.onRelease?.('restored'); } },
    inspect: boundsInspect,
  } });
  let activations = 0;
  sky.activate_window = async () => { assert.equal(held, true); activations++; };
  sky.click = async input => { assert.equal(held, true); sky.calls.push(input); sky.done = !sky.done; };
  let observation = await session.beginInteraction();
  assert.equal(held, true);
  let result = await session.act(observation, { kind: 'click', screenshotId: 'shot-1', point: { x: 10, y: 10 }, refresh: 'both', expect: expectDone });
  assert.equal(result.status, 'verified');
  assert.equal(result.foregroundReturned, 'interaction-held');
  observation = result.observation;
  result = await session.act(observation, { kind: 'click', screenshotId: 'shot-1', point: { x: 20, y: 20 }, expect: { ...expectDone, equals: 'Ready' } });
  assert.equal(result.status, 'verified');
  assert.equal(leases, 1);
  assert.equal(activations, 1);
  const ended = await session.endInteraction();
  assert.equal(held, false);
  assert.equal(ended.foregroundReturned, 'restored');
  assert.equal(sky.calls.length, 2);
  await assert.rejects(session.act(result.observation, { kind: 'key', key: 'a' }), /observation/i);
});

test('an interaction expires and invalidates its old coordinates without input', async t => {
  let held = false;
  const { session, sky } = await setup(t, { native: {
    async withForeground(_, run) { held = true; try { return await run(); } finally { held = false; } },
  } });
  const observation = await session.beginInteraction({ durationMs: 100 });
  await new Promise(resolve => setTimeout(resolve, 140));
  assert.equal(held, false);
  assert.deepEqual(await session.endInteraction(), { status: 'inactive' });
  await assert.rejects(session.act(observation, { kind: 'click', screenshotId: 'shot-1', point: { x: 10, y: 10 } }), /observation/i);
  assert.equal(sky.calls.length, 0);
});

test('Julien taking input back ends the interaction and releases its lease', async t => {
  let active = false, held = false;
  const stop = { assertClear() {}, guardExpected: true, presence: {
    available: true, source: 'raw-input', idleMs: () => 10000, now: () => 10, since: () => active,
    async waitForPause() { return { waitedMs: 0 }; },
  } };
  const { session, sky } = await setup(t, { emergencyStop: stop, native: {
    async withForeground(_, run) { held = true; try { return await run(); } finally { held = false; } },
  } });
  const observation = await session.beginInteraction();active = true;
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(held, false);
  await assert.rejects(session.act(observation, { kind: 'key', key: 'a' }), /observation/i);
  assert.equal(sky.calls.length, 0);
});

test('the emergency stop also releases an idle foreground interaction', async t => {
  let stopped = false, held = false;
  const stop = { assertClear() { if (stopped) throw Object.assign(Error('stop requested'), { emergencyStop: true }); } };
  const { session, sky } = await setup(t, { emergencyStop: stop, native: {
    async withForeground(_, run) { held = true; try { return await run(); } finally { held = false; } },
  } });
  await session.beginInteraction();stopped = true;
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(held, false);
  assert.equal(sky.calls.length, 0);
});

test('unknown input releases an interaction without replaying the action', async t => {
  let held = false;
  const { session, sky } = await setup(t, { backend: 'sky', native: {
    async withForeground(_, run) { held = true; try { return await run(); } finally { held = false; } },
    inspect: boundsInspect,
  } });
  const observation = await session.beginInteraction();sky.failInput = true;
  await assert.rejects(session.act(observation, { kind: 'click', screenshotId: 'shot-1', point: { x: 10, y: 10 } }), /unknown/i);
  assert.equal(held, false);
  assert.equal(sky.calls.length, 1);
});

test('an interaction cannot change its bound window or weaken its duration bound', async t => {
  const { session } = await setup(t);
  await assert.rejects(session.beginInteraction({ durationMs: 30001 }), /durationMs/);
  await session.beginInteraction();
  await assert.rejects(session.bind({ id: 10 }), /interaction/i);
  await assert.rejects(session.beginInteraction(), /interaction/i);
  await session.close();
});

test('foreground lease surrounds activation, input and Sky semantic values, but not reads', async t => {
  let held = false, acquisitions = 0;
  const { session, sky, observation } = await setup(t, { native: {
    async withForeground(_, action) { acquisitions++; held = true; try { return await action(); } finally { held = false; } },
  } });
  assert.equal(acquisitions, 0);
  sky.click = async () => { assert.equal(held, true); sky.done = true; };
  await session.act(observation, { kind: 'click', selector: button });
  assert.equal(held, false);
  const obs = await session.observe();
  assert.equal(acquisitions, 1);
  // set_value de Sky passe par UI Automation géré, qui peut donner le focus : sous le jeton (revue du 16/10).
  sky.set_value = async input => { assert.equal(held, true); sky.calls.push(input); };
  await session.act(obs, { kind: 'setValue', selector: { automationId: 'input' }, value: 'semantic' });
  assert.equal(acquisitions, 2);
  sky.activate_window = async () => assert.equal(held, true);
  await session.activate();
  assert.equal(acquisitions, 3);
});
function provider() {
  return {
    target: 'windows', calls: [], index: 2, done: false, failInput: false, failRefresh: false,
    extra: '', focus: 3,
    windows: [{ id: 10, app: 'test!App', title: 'Test' }],
    async list_windows() { return this.windows; },
    async get_window({ id }) { return this.windows.find(w => w.id === id); },
    async activate_window() {},
    async get_window_state({ window, include_text, include_screenshot }) {
      if (this.failRefresh && this.calls.length) throw Error('capture disconnected');
      return {
        window,
        accessibility: include_text ? {
          tree: `Window: Test\n\t0 fenêtre Test\n\t\t1 Groupe ID: main\n\t\t\t${this.index} Bouton Go ID: go\n\t\t\t3 édition Input ID: input\n\t\t\t4 Texte Status Value: ${this.done ? 'Done' : 'Ready'} ID: status${this.extra}`,
          focused_element: `${this.focus} édition Input ID: input`,
        } : null,
        screenshots: include_screenshot ? [{ id: 'shot-1', width: 800, height: 600, url: 'private-pixels' }] : [],
      };
    },
    async click(input) { this.calls.push(input); if (this.failInput) throw Error('transport lost'); this.done = !this.unchanged; },
    async type_text(input) { this.calls.push(input); this.done = true; },
    async set_value(input) { this.calls.push(input); this.done = true; },
    async press_key(input) { this.calls.push(input); this.done = true; },
  };
}
// Lecture native factice d'une fenêtre avec son rectangle : un geste en coordonnées est jugé sur l'élément sous le point
// (garde-fous) ; sans aucun rectangle, il est refusé. Ce mock ne fournit pas les états des contrôles : les tests qui
// l'utilisent gardent explicitement Sky pour cette lecture.
const boundsInspect = async () => ({ elements: [{ index: 0, depth: 0, role: 'window', name: 'Test', ancestors: [], bounds: [-10000, -10000, 20000, 20000] }] });
async function setup(t, { backend, ...options } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-codex-cu-'));
  const sky = provider();
  const session = new WindowsSession(sky, { stateRoot: root, native: { withForeground: async (_, action) => action() }, ...options });
  t.after(async () => {
    try { await session.close(); } finally { await rm(root, { recursive: true, force: true }); }
  });
  await session.bind({ id: 10 });
  return { root, sky, session, observation: await session.observe({ backend }) };
}

test('localized tree preserves metadata and supports ancestor disambiguation', () => {
  const tree = parseTree('0 fenêtre Test\n\t1 Groupe ID: left\n\t\t2 Bouton Save ID: save\n\t3 Groupe ID: right\n\t\t4 Bouton Save ID: save\n\t5 zone de liste déroulante (collapsed) Choix Value: A ID: choice Secondary Actions: Expand, Collapse');
  assert.equal(uniqueElement(tree, { name: 'Save', ancestor: { automationId: 'right' } }).index, 4);
  assert.equal(tree[5].role, 'combobox');
  assert.equal(tree[5].value, 'A');
  assert.deepEqual(tree[5].actions, ['Expand', 'Collapse']);
  assert.throws(() => uniqueElement(tree, { name: 'Save' }), /exactly one/);
  // Menu attesté par son HWND (ancestor.window, relecture de Codex du 22/10 07:59) : la commande homonyme d'un autre menu
  // n'est jamais choisie ; `window` n'est permis que dans l'ancêtre.
  const menus = [{ index: 0, role: 'menu', name: '', nativeWindow: 200, ancestors: [] }, { index: 1, role: 'menuitem', name: 'Copier', ancestors: [0] },
    { index: 2, role: 'menu', name: '', nativeWindow: 300, ancestors: [] }, { index: 3, role: 'menuitem', name: 'Copier', ancestors: [2] }];
  assert.equal(uniqueElement(menus, { role: 'menuitem', name: 'Copier', ancestor: { window: 300 } }).index, 3);
  assert.throws(() => uniqueElement(menus, { role: 'menuitem', name: 'Copier', ancestor: { window: 400 } }), /found 0/);
  assert.throws(() => uniqueElement(menus, { role: 'menuitem', name: 'Copier', window: 300 }), /Unknown selector field/);
});
test('structure ignores dynamic values and index renumbering but detects button changes', () => {
  const a = parseTree('0 fenêtre A\n\t2 Bouton Go ID: go\n\t3 Texte Value: SECRET');
  const b = parseTree('0 fenêtre B\n\t8 Bouton Go ID: go\n\t9 Texte Value: OTHER');
  assert.equal(structureHash(a), structureHash(b));
  assert.notEqual(structureHash(a), structureHash(parseTree('0 fenêtre B\n\t8 Bouton Delete ID: go')));
});
test('duplicate accessibility indices are rejected', () => {
  assert.throws(() => parseTree('1 button A\n1 button B'), /Duplicate/);
});

test('actual French Win32 Sky roles and combined flags retain names and safety states', () => {
  const tree = parseTree('0 fenêtre Labo\n\t1 Modifier (settable, string) Nom ID: 1\n\t2 zone de liste modifiable (settable, string) Couleur ID: 5\n\t3 barre de défilement (disabled, settable, float) Vertical Value: 0\n\t4 élément de liste (selectable, selected) Charlie\n\t5 case à cocher (checked, focused) Option');
  assert.equal(uniqueElement(tree, { role: 'edit', name: 'Nom' }).automationId, '1');
  assert.equal(uniqueElement(tree, { role: 'combobox', name: 'Couleur' }).automationId, '5');
  assert.throws(() => uniqueElement(tree, { role: 'scrollbar' }), /disabled/);
  assert.equal(tree[4].name, 'Charlie');
  assert.equal(tree[4].selected, true);
  assert.equal(tree[5].checked, true);
});

test('state parsing preserves literal parentheses and unknown label text', () => {
  const tree = parseTree('0 button Save (archived)\n1 edit (settable, string) Report (selected)');
  assert.equal(tree[0].name, 'Save (archived)');
  assert.equal(tree[1].name, 'Report (selected)');
  assert.equal(tree[1].selected, null);
});

test('missing checkbox, selection or value evidence cannot verify a negative postcondition', () => {
  const tree = parseTree('0 check box Option ID: option\n1 list item (selectable) Item ID: item\n2 edit Name ID: name\n3 check box (unchecked) Off ID: off');
  assert.equal(checkExpectation(tree, { selector: { automationId: 'option' }, field: 'checked', equals: false }), false);
  assert.equal(checkExpectation(tree, { selector: { automationId: 'item' }, field: 'selected', equals: false }), false);
  assert.equal(checkExpectation(tree, { selector: { automationId: 'name' }, field: 'value', equals: '' }), false);
  assert.equal(checkExpectation(tree, { selector: { automationId: 'name' }, field: 'description', equals: '' }), false);
  assert.equal(checkExpectation(tree, { selector: { automationId: 'off' }, field: 'checked', equals: false }), true);
});
test('bind rejects ambiguous windows and clears an earlier binding', async t => {
  const { session, sky } = await setup(t);
  sky.windows.push({ id: 11, app: 'test!App', title: 'Test' });
  await assert.rejects(session.bind({ app: 'test!App' }), /unique/);
  await assert.rejects(session.observe(), /Bind/);
});
test('semantic action uses the fresh index and verifies an actual transition', async t => {
  const { session, sky, observation } = await setup(t);
  sky.index = 8;
  const result = await session.act(observation, { kind: 'click', selector: button, expect: expectDone });
  assert.equal(sky.calls[0].element_index, 8);
  assert.equal(result.status, 'verified');
  await assert.rejects(session.act(observation, { kind: 'click', selector: button }), /Stale/);
});

test('Sky indexed click refreshes screenshot geometry required by Windows input', async t => {
  const { session, sky, observation } = await setup(t);
  const capture = sky.get_window_state.bind(sky);
  const click = sky.click.bind(sky);
  let geometryAvailable = false;
  sky.get_window_state = async input => {
    geometryAvailable = input.include_screenshot;
    return capture(input);
  };
  sky.click = async input => {
    if (!geometryAvailable) throw new Error('coordinate input geometry is unavailable');
    return click(input);
  };
  const result = await session.act(observation, { kind: 'click', selector: button, expect: expectDone });
  assert.equal(result.status, 'verified');
  assert.equal(sky.calls.length, 1);
});
test('a copied observation is not an action capability', async t => {
  const { session, observation } = await setup(t);
  await assert.rejects(session.act(structuredClone(observation), { kind: 'click', selector: button }), /foreign/);
  assert.throws(() => { observation.window.id = 12; }, TypeError);
});
test('new observation invalidates old indices even with identical content', async t => {
  const { session, observation } = await setup(t);
  await session.observe();
  await assert.rejects(session.act(observation, { kind: 'click', selector: button }), /Stale/);
});
test('another session observing the same provider invalidates prior observations', async t => {
  const { session, sky, observation } = await setup(t);
  const other = new WindowsSession(sky);
  t.after(() => other.close());
  await other.bind({ id: 10 }); await other.observe();
  await assert.rejects(session.act(observation, { kind: 'click', selector: button }), /Stale/);
});
test('expired observations send no input', async t => {
  const { session, sky, observation } = await setup(t, { maxAgeMs: 1 });
  await new Promise(resolve => setTimeout(resolve, 5));
  await assert.rejects(session.act(observation, { kind: 'click', selector: button }), /expired/);
  assert.equal(sky.calls.length, 0);
});
test('new ambiguity prevents any input', async t => {
  const { session, sky, observation } = await setup(t);
  sky.extra = '\n\t\t\t8 Bouton Go ID: go';
  await assert.rejects(session.act(observation, { kind: 'click', selector: button }), /exactly one/);
  assert.equal(sky.calls.length, 0);
});
test('changed control context stops before input', async t => {
  const { session, sky, observation } = await setup(t);
  const original = sky.get_window_state;
  sky.get_window_state = async function (input) {
    const state = await original.call(this, input);
    state.accessibility.tree = state.accessibility.tree.replace('Groupe ID: main', 'Groupe ID: another');
    return state;
  };
  await assert.rejects(session.act(observation, { kind: 'click', selector: button }), /context changed/);
  assert.equal(sky.calls.length, 0);
});
test('unknown input outcome is never replayed or reusable', async t => {
  const { session, sky, observation } = await setup(t);
  sky.failInput = true;
  await assert.rejects(session.act(observation, { kind: 'click', selector: button }), /outcome is unknown/);
  assert.equal(sky.calls.length, 1);
  await assert.rejects(session.act(observation, { kind: 'click', selector: button }), /Stale/);
});
test('failed post-action capture does not become success', async t => {
  const { session, sky, observation } = await setup(t);
  sky.failRefresh = true;
  await assert.rejects(session.act(observation, { kind: 'click', selector: button, expect: expectDone }), /unknown/);
  assert.equal(session.metrics()[0].status, 'unknown');
});
test('unmet postcondition never triggers a second input or learning', async t => {
  const { session, sky, observation } = await setup(t);
  sky.unchanged = true;
  const r = await session.act(observation, { kind: 'click', selector: button, expect: expectDone, timeoutMs: 0 });
  assert.equal(r.status, 'unmet'); assert.equal(sky.calls.length, 1);
  await assert.rejects(session.remember('go', r, { staticUI: true }), /verified transition/);
});
test('already satisfied condition does not claim a successful action', async t => {
  const { session, sky } = await setup(t);
  sky.done = true;
  const r = await session.act(await session.observe(), { kind: 'click', selector: button, expect: expectDone });
  assert.equal(r.performed, false); assert.equal(r.verified, false); assert.equal(sky.calls.length, 0);
});
test('coordinates require the inspected screenshot and valid bounds', async t => {
  const { session, sky, observation } = await setup(t, { backend: 'sky', native: { withForeground: async (_, action) => action(), inspect: boundsInspect } });
  await assert.rejects(session.act(observation, { kind: 'click', point: { x: 20, y: 20 }, screenshotId: 'made-up' }), /screenshotId/);
  const image = await session.observe({ mode: 'image' });
  assert.equal(JSON.stringify(image).includes('private-pixels'), false);
  await assert.rejects(session.act(image, { kind: 'click', point: { x: 900, y: 20 }, screenshotId: 'shot-1' }), /outside/);
  const r = await session.act(image, { kind: 'click', point: { x: 20, y: 20 }, screenshotId: 'shot-1', expect: expectDone });
  assert.equal(r.verified, true); assert.equal(sky.calls[0].screenshotId, 'shot-1');
});
test('typing refuses incorrect focus', async t => {
  const { session, sky, observation } = await setup(t);
  sky.focus = 2;
  await assert.rejects(session.act(observation, { kind: 'typeText', focus: { automationId: 'input' }, text: 'secret' }), /keyboard focus/);
  assert.equal(sky.calls.length, 0);
});
test('typed content stays out of metrics and cannot be learned', async t => {
  const { session, root, observation } = await setup(t);
  const r = await session.act(observation, { kind: 'typeText', focus: { automationId: 'input' }, text: 'secret-line-1\nsecret-line-2', expect: expectDone });
  assert.equal(r.verified, true);
  await assert.rejects(session.remember('type', r, { staticUI: true }), /never coordinates/);
  const report = await readFile(await session.saveMetrics(), 'utf8');
  assert.equal(report.includes('secret'), false); assert.equal(report.includes('Input'), false);
  assert.ok(root);
});
test('remember accepts only verified evidence and revalidates changed UI', async t => {
  const { session, sky, observation } = await setup(t);
  await assert.rejects(session.remember('go', { verified: true }, { staticUI: true }), /verified transition/);
  const r = await session.act(observation, { kind: 'click', selector: button, expect: expectDone });
  await assert.rejects(session.remember('go', r), /static UI/);
  await session.remember('go', r, { staticUI: true });
  sky.done = false;
  let obs = await session.observe();
  assert.equal((await session.inspectRecipe('go', obs)).status, 'ready');
  assert.equal((await session.runRecipe(obs, 'go')).verified, true);
  sky.extra = '\n\t\t\t9 Bouton New Control ID: new';
  obs = await session.observe();
  assert.equal((await session.inspectRecipe('go', obs)).status, 'changed');
  await assert.rejects(session.runRecipe(obs, 'go'), /changed/);
});
test('malformed memory stops instead of becoming instructions or a default success', async t => {
  const { session, root, observation } = await setup(t);
  const r = await session.act(observation, { kind: 'click', selector: button, expect: expectDone });
  await session.remember('go', r, { staticUI: true });
  const memory = new ApplicationMemory(root);
  await writeFile(memory.file('test!App', 'go'), '{broken');
  await assert.rejects(session.inspectRecipe('go', r.observation), SyntaxError);
  assert.throws(() => memory.file('test!App', '../escape'), /Invalid/);
});
test('concurrent desktop actions are rejected before additional input', async t => {
  const { session, sky, observation } = await setup(t);
  let release;
  sky.click = async function (input) { this.calls.push(input); await new Promise(r => { release = r; }); this.done = true; };
  const first = session.act(observation, { kind: 'click', selector: button });
  while (!release) await new Promise(r => setImmediate(r));
  await assert.rejects(session.observe(), /Another Windows/);
  release(); await first; assert.equal(sky.calls.length, 1);
});

test('native extension supplies UIA directly and retains the fast route in the session', async t => {
  const { sky, root } = await setup(t);
  const original = sky.get_window_state.bind(sky);
  let skyCaptures = 0, nativeCaptures = 0;
  sky.get_window_state = async input => { skyCaptures++; return { window: input.window, accessibility: null, screenshots: [] }; };
  const native = {
    async inspect(window) {
      nativeCaptures++;
      const state = await original({ window, include_text: true });
      return { ...state, revision: digest('native-revision'), elements: parseTree(state.accessibility.tree).map(e => ({ ...e, runtimeId: [42, e.index] })) };
    },
    async call(window, operation, args) {
      assert.equal(operation, 'click'); assert.deepEqual(args.runtimeId, [42, 2]);
      assert.equal(args.element_index, undefined); sky.done = true;
    },
  };
  const session = new WindowsSession(sky, { stateRoot: root, native });
  t.after(() => session.close());
  await session.bind({ id: 10 });
  const obs = await session.observe();
  assert.equal(obs.source, 'native-uia');
  const r = await session.act(obs, { kind: 'click', selector: button, expect: expectDone });
  // Observation toute fraîche : pas de seconde lecture complète avant l'entrée (le helper relit la cible et ses ancêtres).
  assert.equal(r.verified, true); assert.equal(skyCaptures, 0); assert.equal(nativeCaptures, 2);
  await session.remember('native-go', r, { staticUI: true });
  sky.done = false;
  let current = await session.observe();
  assert.equal((await session.inspectRecipe('native-go', current)).status, 'ready');
  const oldInspect = native.inspect;
  native.inspect = async w => ({ ...await oldInspect(w), revision: digest('updated-app') });
  current = await session.observe();
  assert.equal((await session.inspectRecipe('native-go', current)).status, 'changed');
});

test('unsupported native action is an unknown outcome and cannot trigger a blind Sky fallback', async t => {
  const { sky, root } = await setup(t);
  const original = sky.get_window_state.bind(sky);
  sky.get_window_state = async input => ({ window: input.window, accessibility: null, screenshots: [] });
  const native = {
    async inspect(window) {
      const state = await original({ window, include_text: true });
      return { ...state, revision: digest('native-revision'), elements: parseTree(state.accessibility.tree).map(e => ({ ...e, runtimeId: [42, e.index] })) };
    },
    async call() { throw Error('native unsupported'); },
  };
  const session = new WindowsSession(sky, { stateRoot: root, native });
  t.after(() => session.close());
  await session.bind({ id: 10 });
  const obs = await session.observe();
  await assert.rejects(session.act(obs, { kind: 'click', selector: button }), /unknown/);
  assert.equal(sky.calls.length, 0);
});

test('native read failure sends no input', async t => {
  const { sky } = await setup(t);
  sky.get_window_state = async input => ({ window: input.window, accessibility: null, screenshots: [] });
  const session = new WindowsSession(sky, { native: { async inspect() { throw Error('identity mismatch'); } } });
  t.after(() => session.close());
  await session.bind({ id: 10 });
  await assert.rejects(session.observe(), /identity mismatch/);
  assert.equal(sky.calls.length, 0);
});

test('Sky focus metadata supports a precise focus postcondition', async t => {
  const { session, observation } = await setup(t);
  assert.equal(observation.elements.find(e => e.automationId === 'input').focused, true);
  const r = await session.act(observation, { kind: 'click', selector: { automationId: 'input' }, expect: { selector: { automationId: 'input' }, field: 'focused', equals: true } });
  assert.equal(r.status, 'already-satisfied');
});

test('a stale screenshot cannot be used after another observation', async t => {
  const { session, sky } = await setup(t);
  const obs = await session.observe({ mode: 'image' });
  await session.observe();
  await assert.rejects(session.act(obs, { kind: 'click', point: { x: 20, y: 20 }, screenshotId: 'shot-1' }), /Stale/);
  assert.equal(sky.calls.length, 0);
});

function nativeProvider(sky) {
  const capture = sky.get_window_state.bind(sky);
  return {
    generation: 1, calls: [],
    async inspect(window) {
      const state = await capture({ window, include_text: true });
      return { ...state, revision: digest('native-revision'), elements: parseTree(state.accessibility.tree)
        .map(e => ({ ...e, runtimeId: [this.generation, e.index] })) };
    },
    async call(...args) { this.calls.push(args); sky.done = true; },
  };
}
test('explicit native observation can replace a nonempty but incomplete Sky tree', async t => {
  const { sky } = await setup(t);
  const native = nativeProvider(sky);
  const session = new WindowsSession(sky, { native });
  t.after(() => session.close());
  await session.bind({ id: 10 });
  const old = await session.observe({ backend: 'sky' });
  const current = await session.observe({ backend: 'native' });
  assert.equal(old.source, 'sky'); assert.equal(current.source, 'native-uia');
  await assert.rejects(session.act(old, { kind: 'click', selector: button }), /Stale/);
  assert.equal((await session.act(current, { kind: 'click', selector: button, expect: expectDone })).verified, true);
  assert.equal(native.calls.length, 1); assert.equal(sky.calls.length, 0);
  assert.equal((await session.observe({ backend: 'sky' })).source, 'sky');
});
test('replacement native control with identical labels is rejected before input', async t => {
  const { sky } = await setup(t);
  const native = nativeProvider(sky);
  const session = new WindowsSession(sky, { native });
  t.after(() => session.close());
  await session.bind({ id: 10 });
  const obs = await session.observe({ backend: 'native' });
  native.generation++;
  await new Promise(resolve => setTimeout(resolve, 200)); // au-delà de la fraîcheur : relue par la session avant l'entrée
  await assert.rejects(session.act(obs, { kind: 'click', selector: button }), /context changed/);
  assert.equal(native.calls.length, 0);
});
test('a fresh native observation hands the helper the exact identity and ancestry to re-read before input', async t => {
  const { sky } = await setup(t);
  const native = nativeProvider(sky);
  const session = new WindowsSession(sky, { native });
  t.after(() => session.close());
  await session.bind({ id: 10 });
  const obs = await session.observe({ backend: 'native' });
  await session.act(obs, { kind: 'click', selector: button, expect: expectDone });
  const [, op, args] = native.calls[0];
  assert.equal(op, 'click');
  assert.deepEqual(args.runtimeId, [1, 2]);
  assert.deepEqual(args.ancestry, [
    { role: 'window', automationId: '', name: 'Test', runtimeId: [1, 0] },
    { role: 'group', automationId: 'main', name: '', runtimeId: [1, 1] },
  ]);
});
test('the own window of an observed ancestor (open context menu) is handed to the helper as the command scope', async t => {
  // Plan de Codex du 22/10 : la commande d'un menu contextuel ouvert est résolue dans CETTE surgissante.
  const { sky } = await setup(t);
  const native = nativeProvider(sky);
  const inspect = native.inspect.bind(native);
  native.inspect = async (...input) => {
    const state = await inspect(...input);
    state.elements = state.elements.map(e => e.automationId === 'main' ? { ...e, nativeWindow: 4242 } : e);
    return state;
  };
  const session = new WindowsSession(sky, { native });
  t.after(() => session.close());
  await session.bind({ id: 10 });
  const obs = await session.observe({ backend: 'native' });
  await session.act(obs, { kind: 'click', selector: button, expect: expectDone });
  const [, , args] = native.calls[0];
  assert.deepEqual(args.ancestry[1], { role: 'group', automationId: 'main', name: '', runtimeId: [1, 1], nativeWindow: 4242 });
  assert.equal(args.ancestry[0].nativeWindow, undefined);
});
test('typing cannot follow a homonymous field moved to another ancestor', async t => {
  const { session, sky, observation } = await setup(t);
  const capture = sky.get_window_state.bind(sky);
  sky.get_window_state = async input => {
    const state = await capture(input);
    state.accessibility.tree = state.accessibility.tree.replace('Groupe ID: main', 'Groupe ID: other');
    return state;
  };
  await assert.rejects(session.act(observation, { kind: 'typeText', focus: { automationId: 'input' }, text: 'test' }), /context changed/);
  assert.equal(sky.calls.length, 0);
});
test('an automatic provider change requires inspection before acting', async t => {
  const { sky } = await setup(t);
  const native = nativeProvider(sky);
  const session = new WindowsSession(sky, { native });
  t.after(() => session.close());
  await session.bind({ id: 10 });
  const obs = await session.observe({ backend: 'sky' });
  sky.get_window_state = async input => ({ window: input.window, accessibility: null, screenshots: [] });
  await assert.rejects(session.act(obs, { kind: 'click', selector: button }), /provider changed/);
  assert.equal(native.calls.length, 0); assert.equal(sky.calls.length, 0);
});
test('native password targets are refused and closing a session invalidates its observation', async t => {
  const { sky } = await setup(t);
  const native = nativeProvider(sky);
  const inspect = native.inspect.bind(native);
  let closed = false;
  native.close = () => { closed = true; };
  native.inspect = async window => {
    const state = await inspect(window);
    state.elements.find(e => e.automationId === 'input').password = true;
    return state;
  };
  const session = new WindowsSession(sky, { native });
  t.after(() => session.close());
  await session.bind({ id: 10 });
  const obs = await session.observe({ backend: 'native' });
  await assert.rejects(session.act(obs, { kind: 'setValue', selector: { automationId: 'input' }, value: 'test' }), /Password/);
  assert.equal(native.calls.length, 0);
  await session.close(); assert.equal(closed, true);
  await assert.rejects(session.act(obs, { kind: 'click', selector: button }), /Stale/);
});

test('extraneous coordinates cannot bypass fresh typing focus validation', async t => {
  const { session, sky } = await setup(t);
  const obs = await session.observe({ mode: 'both' });
  sky.focus = 2;
  await assert.rejects(session.act(obs, {
    kind: 'typeText', focus: { automationId: 'input' }, text: 'test',
    point: { x: 20, y: 20 }, screenshotId: 'shot-1',
  }), /field|coordinate/i);
  assert.equal(sky.calls.length, 0);
});

test('coordinate objects cannot override the bound window or inspected screenshot', async t => {
  const { session, sky } = await setup(t);
  const obs = await session.observe({ mode: 'image' });
  for (const injected of [{ window: { id: 999, app: 'other' } }, { screenshotId: 'uninspected' }, { element_index: 99 }]) {
    await assert.rejects(session.act(obs, {
      kind: 'click', point: { x: 20, y: 20, ...injected }, screenshotId: 'shot-1',
    }), /point|coordinate/i);
  }
  assert.equal(sky.calls.length, 0);
});

test('an empty accessibility tree is not evidence of absence', () => {
  assert.equal(checkExpectation([], { selector: button, exists: false }), false);
  assert.equal(checkExpectation(parseTree('0 window Test'), { selector: button, exists: false }), true);
});

test('a truncated document can prove a substring but never exact equality', () => {
  const elements = [{ ...parseTree('0 document Editor ID: editor')[0], value: 'prefix', valueTruncated: true }];
  const expect = { selector: { automationId: 'editor' }, field: 'value' };
  assert.equal(checkExpectation(elements, { ...expect, equals: 'prefix' }), false);
  assert.equal(checkExpectation(elements, { ...expect, includes: 'prefix' }), true);
});

test('image-only observation cannot short-circuit a requested disappearance', async t => {
  const { session, sky } = await setup(t, { backend: 'sky', native: { withForeground: async (_, action) => action(), inspect: boundsInspect } });
  const obs = await session.observe({ mode: 'image' });
  const result = await session.act(obs, {
    kind: 'click', point: { x: 20, y: 20 }, screenshotId: 'shot-1',
    expect: { selector: button, exists: false }, timeoutMs: 0,
  });
  assert.equal(result.status, 'unmet');
  assert.equal(result.performed, true);
  assert.equal(sky.calls.length, 1);
});

test('image refresh includes semantic evidence before verifying absence', async t => {
  const { session, sky, observation } = await setup(t);
  const result = await session.act(observation, {
    kind: 'click', selector: button, expect: { selector: button, exists: false }, refresh: 'image', timeoutMs: 0,
  });
  assert.equal(result.status, 'unmet');
  assert.equal(result.observation.mode, 'both');
  assert.equal(sky.calls.length, 1);
});

test('lost accessibility after input never verifies disappearance or creates a recipe', async t => {
  const { session, sky, observation } = await setup(t);
  const capture = sky.get_window_state.bind(sky);
  sky.get_window_state = async input => sky.calls.length
    ? { window: input.window, accessibility: null, screenshots: [] } : capture(input);
  const result = await session.act(observation, {
    kind: 'click', selector: button, expect: { selector: button, exists: false }, timeoutMs: 0,
  });
  assert.equal(result.verified, false);
  assert.equal(result.status, 'unmet');
  await assert.rejects(session.remember('disappear', result, { staticUI: true }), /verified transition/);
  assert.equal(sky.calls.length, 1);
});

test('Windows key aliases are rejected before invoking physical input', async t => {
  const { session, sky, observation } = await setup(t);
  for (const key of ['Super_L+r', 'Meta_R+r', 'Win_L+r', 'Control_L+Super_R+e']) {
    await assert.rejects(session.act(observation, { kind: 'key', key }), /Windows-key/);
  }
  assert.equal(sky.calls.length, 0);
});

test('during an interaction a key is never posted by the helper: physical input under the lease already held', async t => {
  // Relecture de Codex (21/10) : le helper (autre processus) attendait 8 s le jeton que la session tenait déjà.
  let held = false;
  const ops = [];
  const { session, sky } = await setup(t, { backend: 'sky', native: {
    async withForeground(_, run, options) { held = true; try { return await run(); } finally { held = false; options.onRelease?.('restored'); } },
    async call(window, op) { ops.push(op); throw Object.assign(Error('not applicable'), { notApplicable: true }); },
    inspect: boundsInspect,
  } });
  sky.press_key = async input => { assert.equal(held, true); sky.calls.push(['key', input]); };
  const observation = await session.beginInteraction();
  await session.act(observation, { kind: 'key', key: 'Escape' });
  assert.equal(ops.includes('key'), false);
  assert.equal(sky.calls.at(-1)[0], 'key');
  await session.endInteraction();
});

test('an interaction that expires while the action is being prepared sends nothing and takes no new lease', async t => {
  // Relecture de Codex (21/10) : expirée pendant #markSeen, l'interaction s'effaçait et l'action fondée sur elle prenait
  // un NOUVEAU bail pour envoyer la touche.
  let leases = 0, delay = 0;
  const { session, sky } = await setup(t, { backend: 'sky', native: {
    async withForeground(_, run, options) { leases++; try { return await run(); } finally { options.onRelease?.('restored'); } },
    async related() { if (delay) await new Promise(r => setTimeout(r, delay)); return { windows: [] }; },
    inspect: boundsInspect,
  } });
  sky.press_key = async input => { sky.calls.push(['key', input]); };
  const observation = await session.beginInteraction({ durationMs: 100 });
  delay = 180;
  await assert.rejects(session.act(observation, { kind: 'key', key: 'Escape' }));
  assert.equal(sky.calls.filter(c => c[0] === 'key').length, 0);
  assert.equal(leases, 1);
});

test('an interaction that expires during the pre-input refresh sends nothing and takes no new lease', async t => {
  // Relecture de Codex (21/10) : le bail était figé après la relecture ; expiré pendant elle, un nouveau bail envoyait.
  let leases = 0;
  const { session, sky } = await setup(t, { backend: 'sky', native: {
    async withForeground(_, run, options) { leases++; try { return await run(); } finally { options.onRelease?.('restored'); } },
    inspect: boundsInspect,
  } });
  const observation = await session.beginInteraction({ durationMs: 100 });
  const read = sky.get_window_state.bind(sky);
  sky.get_window_state = async input => { await new Promise(r => setTimeout(r, 180)); return read(input); };
  await assert.rejects(session.act(observation, { kind: 'click', selector: button }));
  assert.equal(sky.calls.length, 0);
  assert.equal(leases, 1);
});


test('an interaction expired during the refresh posts nothing in background either', async t => {
  // Relecture de Codex (21/10) : la touche devenait un geste posté par le helper, qui reprenait un nouveau jeton.
  const calls = [];
  const { session, sky } = await setup(t, { backend: 'sky', native: {
    async withForeground(_, run, options) { try { return await run(); } finally { options.onRelease?.('restored'); } },
    async call(window, op, args) { calls.push(op); return { technique: 'background:messages', effect: 'sent' }; },
    inspect: boundsInspect,
  } });
  const observation = await session.beginInteraction({ durationMs: 100 });
  const read = sky.get_window_state.bind(sky);
  sky.get_window_state = async input => { await new Promise(r => setTimeout(r, 180)); return read(input); };
  await assert.rejects(session.act(observation, { kind: 'key', key: 'a' }));
  assert.deepEqual(calls.filter(op => op === 'key'), []);
  assert.equal(sky.calls.length, 0);
});

test('typing stops at the next grapheme when the interaction expires', async t => {
  const { session, sky } = await setup(t, { backend: 'sky', native: {
    async withForeground(_, run, options) { try { return await run(); } finally { options.onRelease?.('restored'); } },
    inspect: boundsInspect,
  } });
  sky.type_text = async input => { sky.calls.push(['type', input.text]); await new Promise(r => setTimeout(r, 80)); };
  const observation = await session.beginInteraction({ durationMs: 100 });
  const r = await session.act(observation, { kind: 'typeText', focus: { automationId: 'input' }, text: 'abcdef' });
  assert.equal(r.status, 'interrupted');
  assert.ok(sky.calls.filter(c => c[0] === 'type').length < 6);
});

test('a name-only selector skips a homonymous static label when exactly one control remains', () => {
  // Banc commun du 21/10 : « Éditeur » désignait le libellé et l'éditeur riche Chromium (« found 2 »).
  const tree = [
    { index: 0, role: 'text', name: 'Éditeur', ancestors: [] },
    { index: 1, role: 'edit', name: 'Éditeur', ancestors: [] },
    { index: 2, role: 'text', name: 'Seul', ancestors: [] },
    { index: 3, role: 'button', name: 'Double', ancestors: [] },
    { index: 4, role: 'edit', name: 'Double', ancestors: [] },
  ];
  assert.equal(uniqueElement(tree, { name: 'Éditeur' }).index, 1);
  assert.equal(uniqueElement(tree, { name: 'Seul' }).index, 2); // un libellé seul reste désignable
  assert.throws(() => uniqueElement(tree, { name: 'Double' }), /found 2/); // deux contrôles : ambigu
  assert.throws(() => uniqueElement(tree, { name: 'Éditeur', role: 'text' }) && uniqueElement([tree[0], { ...tree[0], index: 9 }], { name: 'Éditeur' }), /found 2/);
});

test('target, prior judgement and postcondition resolve a name-only selector the same way (no inverted checkbox)', async t => {
  // Relecture de Codex du 22/10 : texte « Option » + case « Option » cochée, clic avec expect checked:true : la cible
  // était la case mais le jugement comptait deux éléments ; la case déjà cochée était décochée.
  const tree = [{ index: 0, role: 'text', name: 'Option', ancestors: [] }, { index: 1, role: 'checkbox', name: 'Option', checked: true, ancestors: [] }];
  assert.equal(checkExpectation(tree, { selector: { name: 'Option' }, field: 'checked', equals: true }), true);
  assert.equal(uniqueElement(tree, { name: 'Option' }).index, 1);
});

test('a bound window closed by the action is reported closed, not unknown', async t => {
  // Passe 2 du 22/10 : Alt+F4 ou le bouton Fermer rendaient « issue inconnue » (recapture du HWND détruit). Le helper
  // relit l'existence (alive|gone|other) ; seul « gone »/« other » termine, sans recapture.
  let closed = false;
  const { session, sky, observation } = await setup(t, { backend: 'sky', native: {
    async withForeground(_, run) { return run(); },
    async related() { return { windows: [] }; },
    async alive() { return { state: closed ? 'gone' : 'alive' }; },
    inspect: boundsInspect,
  } });
  sky.click = async input => { sky.calls.push(input); closed = true; };
  const read = sky.get_window.bind(sky);
  sky.get_window = async input => { if (closed) throw Error('window not found'); return read(input); };
  const result = await session.act(observation, { kind: 'click', selector: button });
  assert.equal(result.status, 'observed');
  assert.deepEqual(result.windowChange, { reason: 'closed', from: 10, to: null });
  assert.equal(result.observation.closed, true);
  assert.equal(sky.calls.length, 1);
});

test('an unreadable existence never counts as closed', async t => {
  let closed = false;
  const { session, sky, observation } = await setup(t, { backend: 'sky', native: {
    async withForeground(_, run) { return run(); },
    async related() { return { windows: [] }; },
    async alive() { if (closed) throw Error('helper lost'); return { state: 'alive' }; },
    inspect: boundsInspect,
  } });
  sky.click = async input => { sky.calls.push(input); closed = true; };
  const read = sky.get_window.bind(sky);
  sky.get_window = async input => { if (closed) throw Error('window not found'); return read(input); };
  await assert.rejects(session.act(observation, { kind: 'click', selector: button }), /outcome is unknown/);
});

// Boîte modale absente de Sky (Enregistrer sous du Bloc-notes WinUI, de Paint ; passe 2 du 22/10) : suivie seulement si
// le helper l'atteste possédée par une fenêtre suivie ET du même processus ; lue et pilotée par le helper seul.
function modalNative(sky, { pid = 7, boundPid = 7 } = {}) {
  const state = { open: false, ops: [] };
  const dialogTree = '0 fenêtre Enregistrer sous\n\t1 édition Nom du fichier ID: name\n\t2 Bouton Enregistrer ID: save';
  return {
    state,
    async withForeground(_, run) { return run(); },
    async related() {
      return { boundPid, boundEnabled: !state.open,
        windows: state.open ? [{ id: 20, pid, ownerChain: [10], className: '#32770', title: 'Enregistrer sous', enabled: true, popup: false, z: 1 }] : [] };
    },
    async alive(window) { return { state: window.id === 20 && !state.open ? 'gone' : 'alive' }; },
    async inspect(window) {
      if (window.id === 20) return { accessibility: { tree: dialogTree }, elements: parseTree(dialogTree), revision: digest('dialog') };
      const s = await sky.get_window_state({ window, include_text: true });
      return { ...s, elements: parseTree(s.accessibility.tree), revision: digest('main') };
    },
    async call(window, op, args) {
      state.ops.push([window.id, op, args?.selector?.automationId ?? null]);
      if (window.id === 10 && op === 'click') state.open = true;
      if (window.id === 20 && op === 'click') state.open = false;
      return { technique: 'background:uia', effect: 'sent' };
    },
  };
}

test('a modal dialog Sky does not list is followed when the helper attests owner and process', async t => {
  const sky = provider();
  const native = modalNative(sky);
  const session = new WindowsSession(sky, { native });
  t.after(() => session.close());
  await session.bind({ id: 10 });
  const first = await session.observe({ backend: 'native' });
  const opened = await session.act(first, { kind: 'click', selector: button });
  assert.equal(opened.windowChange?.reason, 'opened');
  assert.equal(opened.windowChange?.to, 20);
  assert.equal(opened.observation.window.nativeOnly, true);
  assert.equal(opened.observation.source, 'native-uia');
  assert.ok(opened.observation.elements.some(e => e.automationId === 'save'));
  const before = sky.calls.length;
  const saved = await session.act(opened.observation, { kind: 'click', selector: { automationId: 'save', role: 'button' } });
  assert.equal(saved.windowChange?.reason, 'closed');
  assert.deepEqual(native.state.ops.map(o => o.slice(0, 2)), [[10, 'click'], [20, 'click']]);
  assert.equal(sky.calls.length, before); // aucune entrée Sky
  assert.equal(saved.windowChange.to, 10); // retour à la fenêtre liée, que Sky liste
  assert.equal(saved.observation.window.nativeOnly, undefined);
});

test('a dialog of another process is never followed without Sky', async t => {
  const sky = provider();
  const native = modalNative(sky, { pid: 99 });
  const session = new WindowsSession(sky, { native });
  t.after(() => session.close());
  await session.bind({ id: 10 });
  const first = await session.observe({ backend: 'native' });
  const result = await session.act(first, { kind: 'click', selector: button });
  assert.equal(result.windowChange, null);
  assert.equal(result.observation.window.id, 10);
});

async function onDialog(t, options = {}) {
  const sky = provider();
  const native = Object.assign(modalNative(sky), options);
  const session = new WindowsSession(sky, { native });
  t.after(() => session.close());
  await session.bind({ id: 10 });
  const opened = await session.act(await session.observe({ backend: 'native' }), { kind: 'click', selector: button });
  assert.equal(opened.observation.window.nativeOnly, true);
  return { sky, native, session, opened };
}

test('a dialog whose process changes after adoption is refused', async t => {
  const { native, session } = await onDialog(t);
  const related = native.related.bind(native);
  native.related = async () => { const r = await related(); r.windows.forEach(w => { w.pid = 99; }); return r; };
  await assert.rejects(session.observe({ backend: 'native' }), /identity changed/);
});

test('a hidden but living dialog is not popped as closed', async t => {
  const { native, session } = await onDialog(t);
  native.related = async () => ({ boundPid: 7, boundEnabled: false, windows: [] }); // masquée : absente de la liste visible
  native.alive = async () => ({ state: 'alive' });
  const obs = await session.observe({ backend: 'native' });
  assert.equal(obs.window.id, 20);
  assert.equal(obs.windowChange, null);
});

test('a dialog action that closes the whole application is reported closed', async t => {
  const { native, session, opened } = await onDialog(t);
  const sent = native.state.ops.length;
  native.call = async (window, op) => { native.state.ops.push([window.id, op]); native.state.appGone = true; return { technique: 'background:uia', effect: 'sent' }; };
  native.related = async () => { if (native.state.appGone) throw Error('window gone'); return { boundPid: 7, windows: [] }; };
  native.alive = async () => ({ state: native.state.appGone ? 'gone' : 'alive' });
  const result = await session.act(opened.observation, { kind: 'click', selector: { automationId: 'save', role: 'button' } });
  assert.deepEqual(result.windowChange, { reason: 'closed', from: 10, to: null });
  assert.equal(result.observation.closed, true);
  assert.equal(native.state.ops.length, sent + 1);
});

test('a window that closes during the expectation wait is reported closed, not unknown', async t => {
  let reads = 0, clicked = false;
  const { session, sky, observation } = await setup(t, { backend: 'sky', native: {
    async withForeground(_, run) { return run(); },
    async related() { return { windows: [] }; },
    async alive() { return { state: clicked && reads >= 2 ? 'gone' : 'alive' }; },
    inspect: boundsInspect,
  } });
  sky.click = async input => { sky.calls.push(input); clicked = true; };
  const state = sky.get_window_state.bind(sky);
  sky.get_window_state = async input => { if (clicked && ++reads >= 2) throw Error('window not found'); return state(input); };
  const result = await session.act(observation, { kind: 'click', selector: button, expect: { selector: { automationId: 'status' }, field: 'value', equals: 'Never' } });
  assert.equal(result.windowChange?.reason, 'closed');
  assert.equal(sky.calls.length, 1);
});

test('on a dialog Sky does not list, the native foreground UIA click is still tried before refusing', async t => {
  const { native, session, opened, sky } = await onDialog(t);
  const modes = [];
  native.call = async (window, op, args) => {
    modes.push([window.id, op, args?.mode ?? 'background']);
    if (args?.mode !== 'foreground') throw Object.assign(new Error('not applicable in background'), { notApplicable: true });
    return { value: { technique: 'foreground:uia', effect: 'sent' } };
  };
  const before = sky.calls.length;
  await session.act(opened.observation, { kind: 'click', selector: { automationId: 'name', role: 'edit' } });
  assert.deepEqual(modes.filter(m => m[1] === 'click'), [[20, 'click', 'background'], [20, 'click', 'foreground']]);
  assert.equal(sky.calls.length, before);
});

test('a dialog owned through an untracked intermediate window keeps its direct owner and its anchor apart', async t => {
  const sky = provider();
  const native = modalNative(sky);
  const related = native.related.bind(native);
  native.related = async () => { const r = await related(); r.windows.forEach(w => { w.ownerChain = [30, 10]; }); return r; };
  const session = new WindowsSession(sky, { native });
  t.after(() => session.close());
  await session.bind({ id: 10 });
  const opened = await session.act(await session.observe({ backend: 'native' }), { kind: 'click', selector: button });
  assert.equal(opened.observation.window.owner, 30);
  assert.equal(opened.observation.window.anchor, 10);
  assert.equal((await session.observe({ backend: 'native' })).window.id, 20); // revalidation sans faux refus
});

test('a dialog that vanishes during its capture hands back its owner with proof, without replay', async t => {
  const { native, session, opened } = await onDialog(t);
  const inspect = native.inspect.bind(native);
  native.call = async (window, op) => { native.state.ops.push([window.id, op]); return { technique: 'background:uia', effect: 'sent' }; };
  native.inspect = async window => {
    if (window.id === 20) { native.state.open = false; throw Error('window vanished'); }
    return inspect(window);
  };
  const sent = native.state.ops.length;
  const result = await session.act(opened.observation, { kind: 'click', selector: { automationId: 'save', role: 'button' } });
  assert.equal(result.windowChange?.reason, 'closed');
  assert.equal(result.observation.window.id, 10);
  assert.equal(native.state.ops.length, sent + 1);
});

test('the root closing during the recovery recapture is reported closed, not unknown', async t => {
  const { native, session, opened } = await onDialog(t);
  native.call = async (window, op) => { native.state.ops.push([window.id, op]); return { technique: 'background:uia', effect: 'sent' }; };
  native.inspect = async window => {
    if (window.id === 20) { native.state.open = false; throw Error('dialog vanished'); }
    native.state.appGone = true; throw Error('root vanished'); // racine détruite pendant la recapture
  };
  const alive = native.alive.bind(native);
  native.alive = async window => (native.state.appGone && window.id === 10 ? { state: 'gone' } : alive(window));
  const result = await session.act(opened.observation, { kind: 'click', selector: { automationId: 'save', role: 'button' } });
  assert.deepEqual(result.windowChange, { reason: 'closed', from: 10, to: null });
});

test('a Settings page opens through the helper only, and any other address is refused before launch', async t => {
  const opened = [];
  const { session, sky } = await setup(t, { backend: 'sky', native: {
    async withForeground(_, run) { return run(); },
    async openSettings(uri) { opened.push(uri); return { window: 10, title: 'Paramètres', foregroundReturned: 'restored' }; },
    inspect: boundsInspect,
  } });
  const result = await session.openSettings('ms-settings:display');
  assert.equal(result.status, 'opened');
  assert.equal(result.window.id, 10);
  assert.equal(result.foregroundReturned, 'restored');
  for (const uri of ['tel:0600000000', 'ms-settings:display&x', 'https://example.com', 'ms-settings:display;calc']) {
    await assert.rejects(session.openSettings(uri), /Only ms-settings/);
  }
  assert.deepEqual(opened, ['ms-settings:display']);
  assert.equal(sky.calls.length, 0);
});

test('a Settings page opened hidden can be bound only through openSettings, then is read by the helper alone', async t => {
  const sky = provider();
  const tree = '0 fenêtre Paramètres\n\t1 Texte Échelle Value: 125 % ID: scale';
  const native = {
    async withForeground(_, run) { return run(); },
    async openSettings() { return { window: 77, app: 'windows.immersivecontrolpanel!microsoft.windows.immersivecontrolpanel', pid: 5, title: 'Paramètres', hidden: true, foregroundReturned: 'none' }; },
    async alive(window) { return { state: window.id === 77 && window.pid === 5 ? 'alive' : 'gone' }; },
    async related() { return { boundPid: 5, windows: [] }; },
    async inspect(window) { assert.equal(window.id, 77); return { accessibility: { tree }, elements: parseTree(tree), revision: digest('settings') }; },
  };
  const session = new WindowsSession(sky, { native });
  t.after(() => session.close());
  await assert.rejects(session.bindOpenedSettings(), /No hidden Settings window/);
  const opened = await session.openSettings('ms-settings:display');
  assert.deepEqual([opened.status, opened.window, opened.hidden, opened.bindable], ['opened', null, true, 'bindOpenedSettings']);
  const win = await session.bindOpenedSettings();
  assert.equal(win.nativeOnly, true);
  const obs = await session.observe();
  assert.equal(obs.source, 'native-uia');
  assert.equal(obs.elements.find(e => e.automationId === 'scale')?.value, '125 %');
  await assert.rejects(session.observe({ backend: 'sky' }), /Sky does not list/);
  await assert.rejects(session.bindOpenedSettings(), /No hidden Settings window/); // usage unique
  assert.equal(sky.calls.length, 0);
});

test('opening Settings invalidates earlier observations and a stale opening can never be bound', async t => {
  let reply = { window: 77, app: 'settings!app', pid: 5, title: 'Paramètres', hidden: true };
  const { session, observation } = await setup(t, { backend: 'sky', native: {
    async withForeground(_, run) { return run(); },
    async openSettings() { return reply; },
    async alive() { return { state: 'alive' }; },
    async related() { return { boundPid: 5, windows: [] }; },
    inspect: boundsInspect,
  } });
  await session.openSettings('ms-settings:display');
  await assert.rejects(session.act(observation, { kind: 'click', selector: button }), /Stale/);
  reply = { window: 0 }; // seconde ouverture sans fenêtre trouvée
  assert.equal((await session.openSettings('ms-settings:display')).status, 'unknown');
  await assert.rejects(session.bindOpenedSettings(), /No hidden Settings window/);
});

test('opening Settings is refused during a foreground interaction', async t => {
  let calls = 0;
  const { session } = await setup(t, { backend: 'sky', native: {
    async withForeground(_, run, options) { try { return await run({ held: () => true }); } finally { options?.onRelease?.('restored'); } },
    async call() { return { technique: 'foreground:activate' }; },
    async openSettings() { calls++; return { window: 0 }; },
    inspect: boundsInspect,
  } });
  await session.beginInteraction();
  await assert.rejects(session.openSettings('ms-settings:display'), /End the foreground interaction/);
  await session.endInteraction();
  assert.equal(calls, 0);
});

test('an Explorer window is taken to a folder by the helper, never by Sky keys', async t => {
  const calls = [];
  const { session, sky } = await setup(t, { backend: 'sky', native: {
    async withForeground(_, run) { return run(); },
    async call(window, op, args) { calls.push([window.id, op, args.path]); return { effect: 'verified', path: 'C:/TEMP/X' }; },
    inspect: boundsInspect,
  } });
  const result = await session.openFolder('C:/Temp/x');
  assert.deepEqual(result, { status: 'verified', effect: 'verified', path: 'C:/TEMP/X' });
  assert.deepEqual(calls, [[10, 'navigateFolder', 'C:/Temp/x']]);
  assert.equal(sky.calls.length, 0);
});
