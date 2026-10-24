// Numéros [N] sur l'image (shared/images.md point 5, avis de Codex du 24/10) : sélection des éléments, arbre lu une seule
// fois AVANT la capture, âge de l'observation depuis cette lecture, refus expliqués. Fournisseurs factices.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WindowsSession } from '../lib/session.mjs';
import { EmergencyStop } from '../lib/stop.mjs';
import { markCandidates } from '../lib/tree.mjs';
import { WindowsTools } from '../lib/mcp.mjs';

const el = (index, role, name, bounds, extra = {}) => ({ index, role, name, bounds, ancestors: index ? [0] : [], flags: [], nativeWindow: 0, ...extra });
const tree = [
  { ...el(0, 'window', 'Test', [0, 0, 800, 600]), nativeWindow: 4242 },
  el(1, 'button', '', [10, 10, 20, 20]), // icône sans nom : numérotée en auto
  el(2, 'button', 'OK', [40, 10, 60, 20]), // nommée : seulement en all
  el(3, 'edit', '  ', [10, 40, 200, 20]), // nom fait d'espaces : sans nom
  el(4, 'pane', '', [0, 0, 800, 600]), // conteneur décoratif : jamais en auto
  el(5, 'button', '', [0, 0, 0, 0]), // sans rectangle
  el(6, 'button', '', [10, 70, 20, 20], { flags: ['offscreen'] }),
  { ...el(7, 'menu', '', [900, 100, 120, 200]), nativeWindow: 777 }, // menu surgissant : sa fenêtre
  { ...el(8, 'menuitem', '', [905, 105, 110, 20]), ancestors: [0, 7] },
];

test('auto : contrôles sans nom avec rectangle, index exact, porteur le plus proche', () => {
  assert.deepEqual(markCandidates(tree, 'auto'), [
    { index: 1, bounds: [10, 10, 20, 20], scope: 4242 },
    { index: 3, bounds: [10, 40, 200, 20], scope: 4242 },
    { index: 8, bounds: [905, 105, 110, 20], scope: 777 },
  ]);
});

test('all : tous les éléments à rectangle hors racine et hors écran', () => {
  assert.deepEqual(markCandidates(tree, 'all').map(m => m.index), [1, 2, 3, 4, 7, 8]);
  assert.equal(markCandidates(tree, 'all').capped, undefined);
});

test('plafond de 400 : les éléments en trop sont comptés, jamais perdus en silence', () => {
  const many = [tree[0], ...Array.from({ length: 401 }, (_, i) => el(i + 1, 'button', '', [i, 0, 5, 5]))];
  const kept = markCandidates(many, 'auto');
  assert.equal(kept.length, 400);
  assert.equal(kept.capped, 1);
  assert.equal(JSON.stringify(kept).includes('capped'), false);
});

function sky() {
  const window = { id: 10, app: 'test!App', title: 'Test' };
  return {
    target: 'windows', windows: [window],
    async list_windows() { return this.windows; },
    async get_window({ id }) { return this.windows.find(x => x.id === id); },
    async get_window_state({ window: w }) { return { window: w, accessibility: { tree: '0 window Test' }, screenshots: [] }; },
  };
}

async function setup(t, native) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-codex-marks-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const session = new WindowsSession(sky(), { stateRoot: root, native: { async withForeground(_, a) { return a(); }, ...native }, emergencyStop: new EmergencyStop({ directory: root, watch: false }) });
  await session.bind({ id: 10 });
  return session;
}
const frame = { left: 0, top: 0, width: 800, height: 600 };
const inspected = { accessibility: { tree: '0 window Test\n  1 button', focused_element: null }, elements: tree, revision: 'r', frame };

test('marks : arbre lu une seule fois AVANT la capture, rectangles et cadre transmis, âge depuis la lecture', async t => {
  const order = [];
  let sent = null, inspectAt = 0;
  const session = await setup(t, {
    async inspect() { order.push('inspect'); inspectAt = Date.now(); await new Promise(r => setTimeout(r, 30)); return inspected; },
    async capture(_w, _d, _z, marks) { order.push('capture'); sent = marks; return { path: 'x.webp', width: 400, height: 300, frame, marks: { drawn: [1, 3], omitted: [], foreign: [8], outside: 0 } }; },
  });
  const obs = await session.observe({ mode: 'both', backend: 'native', capture: 'native', marks: 'auto' });
  assert.deepEqual(order, ['inspect', 'capture']);
  assert.deepEqual(sent.marks.map(m => m.index), [1, 3, 8]);
  assert.deepEqual(sent.treeFrame, frame);
  assert.ok(obs.capturedAt <= inspectAt, 'âge compté depuis le début de la lecture de l arbre');
  assert.deepEqual(obs.images[0].marks.drawn, [1, 3]);
  assert.equal(obs.source, 'native-uia');
});

test('marks none (défaut) : ordre et appel de capture inchangés', async t => {
  const order = [];
  let sent = 'unset';
  const session = await setup(t, {
    async inspect() { order.push('inspect'); return inspected; },
    async capture(_w, _d, _z, marks) { order.push('capture'); sent = marks; return { path: 'x.webp', width: 400, height: 300, frame }; },
  });
  const obs = await session.observe({ mode: 'both', backend: 'native', capture: 'native' });
  assert.deepEqual(order, ['capture', 'inspect']);
  assert.equal(sent, null);
  assert.equal(obs.images[0].marks, undefined);
  assert.equal(obs.marksNote, undefined);
});

test('marks sans mode both, ou sans image native : rien dessiné, la raison est dite', async t => {
  const session = await setup(t, {
    async inspect() { return inspected; },
    async capture() { return { path: null, width: 0, height: 0, frame, blank: true }; },
  });
  const textOnly = await session.observe({ mode: 'text', backend: 'native', capture: 'native', marks: 'auto' });
  assert.match(textOnly.marksNote, /mode both/);
  const blank = await session.observe({ mode: 'both', backend: 'native', capture: 'native', marks: 'all' });
  assert.match(blank.marksNote, /no native image/);
  await assert.rejects(session.observe({ mode: 'both', marks: 'some' }), /marks must be/);
});

test('look : marks transmis, compte rendu des numéros joint à l image', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nexus-marks-'));
  const file = path.join(dir, 'a.webp');
  await writeFile(file, 'RIFFwebp');
  let asked = null;
  const tools = new WindowsTools({
    async windows() { return [{ id: 7, app: 'process:C:/a.exe', title: 'A' }]; },
    async bind(w) { return { ...w }; },
    async observe(options) {
      asked = options.marks;
      return { window: { id: 7, title: 'A', app: 'process:C:/a.exe' }, elements: [], source: 'native-uia',
        images: [{ id: 'native-1', path: file, width: 400, height: 300, frame, marks: { drawn: [1, 3], omitted: [9], foreign: [8], outside: 2 } }] };
    },
  });
  const content = await tools.call('look', { window: 7, mode: 'both', marks: 'auto' });
  assert.equal(asked, 'auto');
  assert.match(content.at(-1).text, /native-1: numbers = tree line indexes, drawn for 2.*room: 9.*other windows.*: 8.*2 outside/);
  await assert.rejects(tools.call('look', { window: 7, region: [500, 400, 600, 500] }), /region is empty/); // look refusé…
  await assert.rejects(tools.call('act', { steps: [{ kind: 'key', key: 'F5' }] }), /Look at the window first/); // …plus d'ancienne observation
  await tools.call('look', { window: 7, mode: 'both' });
  assert.equal(asked, undefined);
  await rm(dir, { recursive: true, force: true });
});
