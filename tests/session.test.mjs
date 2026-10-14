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
async function setup(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-codex-cu-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sky = provider();
  const session = new WindowsSession(sky, { stateRoot: root, ...options });
  await session.bind({ id: 10 });
  return { root, sky, session, observation: await session.observe() };
}

test('localized tree preserves metadata and supports ancestor disambiguation', () => {
  const tree = parseTree('0 fenêtre Test\n\t1 Groupe ID: left\n\t\t2 Bouton Save ID: save\n\t3 Groupe ID: right\n\t\t4 Bouton Save ID: save\n\t5 zone de liste déroulante (collapsed) Choix Value: A ID: choice Secondary Actions: Expand, Collapse');
  assert.equal(uniqueElement(tree, { name: 'Save', ancestor: { automationId: 'right' } }).index, 4);
  assert.equal(tree[5].role, 'combobox');
  assert.equal(tree[5].value, 'A');
  assert.deepEqual(tree[5].actions, ['Expand', 'Collapse']);
  assert.throws(() => uniqueElement(tree, { name: 'Save' }), /exactly one/);
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
  const { session, sky, observation } = await setup(t);
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

test('native extension supplies missing UIA and retains the fast route in the session', async t => {
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
  await session.bind({ id: 10 });
  const obs = await session.observe();
  assert.equal(obs.source, 'native-uia');
  const r = await session.act(obs, { kind: 'click', selector: button, expect: expectDone });
  assert.equal(r.verified, true); assert.equal(skyCaptures, 1); assert.equal(nativeCaptures, 3);
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
  await session.bind({ id: 10 });
  const obs = await session.observe();
  await assert.rejects(session.act(obs, { kind: 'click', selector: button }), /unknown/);
  assert.equal(sky.calls.length, 0);
});

test('native read failure sends no input', async t => {
  const { sky } = await setup(t);
  sky.get_window_state = async input => ({ window: input.window, accessibility: null, screenshots: [] });
  const session = new WindowsSession(sky, { native: { async inspect() { throw Error('identity mismatch'); } } });
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
  await session.bind({ id: 10 });
  const old = await session.observe();
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
  await session.bind({ id: 10 });
  const obs = await session.observe({ backend: 'native' });
  native.generation++;
  await assert.rejects(session.act(obs, { kind: 'click', selector: button }), /context changed/);
  assert.equal(native.calls.length, 0);
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
  await session.bind({ id: 10 });
  const obs = await session.observe();
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
  const { session, sky } = await setup(t);
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
