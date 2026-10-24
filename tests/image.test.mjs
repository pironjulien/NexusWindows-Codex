// Règle image commune (24/10) : capture native réduite, point de l'image ramené au cadre écran.
import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeScreen, screenPoints } from '../lib/garde-fous.mjs';

const shot = { id: 'native-1', width: 1394, height: 824, frame: { left: 49, top: 40, width: 2182, height: 1291 }, native: true };

test('un point de l image réduite vise le pixel écran correspondant', () => {
  assert.deepEqual(nativeScreen(shot, { x: 0, y: 0 }), { x: 49, y: 40 });
  assert.deepEqual(nativeScreen(shot, { x: 697, y: 412 }), { x: 49 + Math.round(697.5 * 2182 / 1394 - 0.5), y: 40 + Math.round(412.5 * 1291 / 824 - 0.5) });
  const last = nativeScreen(shot, { x: 1393, y: 823 });
  assert.ok(last.x <= 49 + 2181 && last.y <= 40 + 1290); // jamais hors du cadre
});

test('image à la taille du cadre : point inchangé (comportement d avant)', () => {
  const same = { ...shot, width: 2182, height: 1291 };
  assert.deepEqual(nativeScreen(same, { x: 100, y: 50 }), { x: 149, y: 90 });
});

test('les garde-fous contrôlent EXACTEMENT le pixel injecté (frontière de deux zones, capture réduite)', () => {
  // Scénario de Codex : cadre 800x600, image 400x300, point (149,50) → pixel (299,101), dans « Envoyer » [299,100,80,30].
  const small = { id: 'native-2', width: 400, height: 300, frame: { left: 0, top: 0, width: 800, height: 600 }, native: true, originX: 0, originY: 0 };
  const injected = nativeScreen(small, { x: 149, y: 50 });
  assert.deepEqual(injected, { x: 299, y: 101 });
  const points = screenPoints({ x: 149, y: 50 }, small, null);
  assert.deepEqual(points[0], [injected.x, injected.y]);
});

test('arrêt d urgence après une entrée partie (inputStarted) : issue inconnue, jamais « rien envoyé »', async () => {
  const { stopRefusal } = await import('../lib/native.mjs');
  const after = stopRefusal('Emergency stop is active', 'EmergencyStopException', true);
  assert.equal(after.afterInput, true);
  assert.equal(after.deferred, false);
  const before = stopRefusal('Emergency stop is active', 'EmergencyStopException', false);
  assert.equal(before.deferred, true);
  assert.equal(before.afterInput, undefined);
});

test('zone de zoom : pixels de l image native → zone écran, même conversion que les points', async () => {
  const { regionToScreen } = await import('../lib/mcp.mjs');
  const small = { width: 400, height: 300, frame: { left: 10, top: 20, width: 800, height: 600 } };
  assert.deepEqual(regionToScreen(small, [99, 49, 0, 0]), [10, 20, 200, 100]); // coins dans le désordre acceptés
  assert.deepEqual(regionToScreen(small, [390, 290, 450, 350]), [790, 600, 20, 20]); // borné au cadre
  assert.throws(() => regionToScreen(undefined, [0, 0, 10, 10]), /native image of this window/);
  assert.throws(() => regionToScreen(small, [500, 5, 600, 9]), /empty/);
});

test('pas d image en double : même image et même cadre non jointe, mode image la joint toujours, zoom à part', async () => {
  const { WindowsTools } = await import('../lib/mcp.mjs');
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const dir = await mkdtemp(path.join(tmpdir(), 'nexus-img-'));
  const file = path.join(dir, 'a.webp');
  await writeFile(file, 'RIFFwebp-a');
  const frame = { left: 0, top: 0, width: 800, height: 600 };
  let n = 0, zoomAsked = null;
  const session = {
    async windows() { return [{ id: 7, app: 'process:C:/a.exe', title: 'A' }]; },
    async bind(w) { return { ...w }; },
    async observe(options) {
      zoomAsked = options.zoom;
      const image = { id: `native-${++n}`, path: file, width: 400, height: 300, frame: options.zoom ? { left: 0, top: 0, width: 100, height: 100 } : frame, ...(options.zoom ? { zoom: true } : {}) };
      return { window: { id: 7, title: 'A', app: 'process:C:/a.exe' }, elements: [], images: [image], source: 'native-uia' };
    },
  };
  const tools = new WindowsTools(session);
  const images = content => content.filter(c => c.type === 'image').length;
  assert.equal(images(await tools.call('look', { window: 7, mode: 'both' })), 1);
  const again = await tools.call('look', { window: 7, mode: 'both' });
  assert.equal(images(again), 0);
  assert.match(again.at(-1).text, /native-2 unchanged since native-1.*screenshotId native-2/);
  assert.equal(images(await tools.call('look', { window: 7, mode: 'image' })), 1);
  const zoomed = await tools.call('look', { window: 7, region: [0, 0, 49, 49] }); // mode text → both
  assert.deepEqual(zoomAsked, [0, 0, 100, 100]);
  assert.equal(images(zoomed), 1);
  await writeFile(file, 'RIFFwebp-b'); // écran changé
  assert.equal(images(await tools.call('look', { window: 7, mode: 'both' })), 1);
});

test('le repère des régions suit aussi l image complète renvoyée par act (refresh)', async () => {
  const { WindowsTools } = await import('../lib/mcp.mjs');
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const dir = await mkdtemp(path.join(tmpdir(), 'nexus-img-'));
  const file = path.join(dir, 'a.webp');
  await writeFile(file, 'RIFFwebp');
  let zoomAsked = null;
  const win = { id: 9, title: 'B', app: 'process:C:/b.exe' };
  const image = (id, frame, width, height) => ({ id, path: file, width, height, frame });
  const session = {
    async windows() { return [{ ...win }]; },
    async bind(w) { return { ...w }; },
    async observe(options) {
      zoomAsked = options.zoom;
      return { window: win, elements: [], images: [image('native-1', { left: 0, top: 0, width: 800, height: 600 }, 400, 300)], source: 'native-uia' };
    },
    async act() {
      const moved = image('native-2', { left: 100, top: 50, width: 500, height: 400 }, 500, 400); // déplacée, agrandie
      return { status: 'verified', observation: { window: win, elements: [], images: [moved], source: 'native-uia' } };
    },
  };
  const tools = new WindowsTools(session);
  await tools.call('look', { window: 9, mode: 'both' });
  await tools.call('act', { steps: [{ kind: 'key', key: 'F5', refresh: 'both' }] });
  await tools.call('look', { window: 9, region: [10, 10, 49, 49] });
  assert.deepEqual(zoomAsked, [110, 60, 40, 40]); // repère de native-2, pas de native-1
});

test('une image illisible jamais jointe ne remplace pas le repère des régions', async () => {
  const { WindowsTools } = await import('../lib/mcp.mjs');
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const dir = await mkdtemp(path.join(tmpdir(), 'nexus-img-'));
  const file = path.join(dir, 'a.webp');
  await writeFile(file, 'RIFFwebp');
  let zoomAsked = null;
  const win = { id: 11, title: 'C', app: 'process:C:/c.exe' };
  const session = {
    async windows() { return [{ ...win }]; },
    async bind(w) { return { ...w }; },
    async observe(options) {
      zoomAsked = options.zoom;
      return { window: win, elements: [], images: [{ id: 'native-1', path: file, width: 400, height: 300, frame: { left: 0, top: 0, width: 800, height: 600 } }], source: 'native-uia' };
    },
    async act() {
      const purged = { id: 'native-2', path: path.join(dir, 'purgée.webp'), width: 400, height: 320, frame: { left: 100, top: 50, width: 1000, height: 800 } };
      return { status: 'verified', observation: { window: win, elements: [], images: [purged], source: 'native-uia' } };
    },
  };
  const tools = new WindowsTools(session);
  await tools.call('look', { window: 11, mode: 'both' });
  const acted = await tools.call('act', { steps: [{ kind: 'key', key: 'F5', refresh: 'image' }] });
  assert.equal(acted.filter(c => c.type === 'image').length, 0);
  await tools.call('look', { window: 11, region: [10, 10, 49, 49] });
  assert.deepEqual(zoomAsked, [20, 20, 80, 80]); // repère de native-1, la dernière image réellement reçue
});
