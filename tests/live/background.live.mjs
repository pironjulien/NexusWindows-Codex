// Validation réelle (tester-computer-use.ps1 -LiveInstallation, test.ps1 -Full). Le test crée ses propres fenêtres
// (fixture WinForms, Win32 natif, WPF), affichées sans activation au fond de l'empilement, et ne touche qu'à elles.
// Chaque action d'arrière-plan doit réussir avec effet relu ET compté par l'application, sans vol du premier plan ni
// déplacement du curseur. Ce qui prend le premier plan n'est lancé que si Julien est inactif depuis 120 s ; sinon le
// sous-test est « sauté », jamais compté réussi. Les fenêtres, captures et preuves sont retirées à la fin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WindowsSession } from '../../lib/session.mjs';
import { NativeUIA } from '../../lib/native.mjs';
import { EmergencyStop } from '../../lib/stop.mjs';

const executable = process.env.NEXUS_LIVE_EXE;
const fixture = process.env.NEXUS_LIVE_FIXTURE;
const reports = process.env.NEXUS_LIVE_REPORTS;
const IDLE_REQUIRED_MS = 120000;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Fournisseur « Sky » de laboratoire : inventaire et identité des fenêtres de la fixture par le helper, aucun arbre ni
// image (la session passe donc par UIA natif) et AUCUNE entrée physique : toute tentative est comptée et échoue.
class LabSky {
  target = 'windows'; physical = [];
  constructor(native, pid) { this.native = native; this.pid = pid; }
  async list_windows() { return (await this.native.listWindows(this.pid)).windows.map(({ id, app, title }) => ({ id, app, title })); }
  async get_window({ id, app }) {
    const found = (await this.list_windows()).find(w => w.id === id && (app === undefined || w.app === app));
    if (!found) throw new Error('Window is gone');
    return found;
  }
  async get_window_state({ window }) { return { window, accessibility: null, screenshots: [] }; }
  #refuse(kind) { this.physical.push(kind); throw new Error('Physical Sky input is not available in the live laboratory'); }
  async click() { this.#refuse('click'); }
  async type_text() { this.#refuse('type_text'); }
  async press_key() { this.#refuse('press_key'); }
  async set_value() { this.#refuse('set_value'); }
  async scroll() { this.#refuse('scroll'); }
  async drag() { this.#refuse('drag'); }
  async perform_secondary_action() { this.#refuse('perform_secondary_action'); }
  async activate_window() { this.#refuse('activate_window'); }
}

test('live background validation on self-created covered windows', { skip: !executable || !fixture ? 'NEXUS_LIVE_EXE / NEXUS_LIVE_FIXTURE absents' : false, timeout: 240000 }, async t => {
  const work = await mkdtemp(path.join(os.tmpdir(), 'nexus-codex-live-'));
  const evidence = path.join(work, 'evidence');
  const probeNative = new NativeUIA(executable);
  const idleAtStart = (await probeNative.probe()).idleMs; // avant toute action : aucune injection de ce test
  const child = spawn(fixture, [evidence], { windowsHide: false, stdio: ['pipe', 'ignore', 'ignore'] });
  const exited = new Promise(resolve => child.once('close', resolve));
  const stop = new EmergencyStop({ directory: process.env.NEXUS_SHARED_HOME ?? path.join(work, 'shared') });
  const measures = [];
  let session, labNative, sessionNative;
  try {
    let ready;
    for (let i = 0; i < 150 && !ready; i++) {
      try { ready = JSON.parse(await readFile(path.join(evidence, 'ready.json'), 'utf8')); } catch { await delay(100); }
    }
    assert.ok(ready, 'fixture ready');
    const fixtureWindows = new Set([ready.winforms, ready.win32, ready.wpf]);
    const state = async () => JSON.parse(await readFile(path.join(evidence, 'state.json'), 'utf8').catch(() => '{}'));
    stop.startGuard(executable);
    for (let i = 0; i < 50 && !stop.presence.available; i++) await delay(100);
    labNative = new NativeUIA(executable);
    sessionNative = new NativeUIA(executable, { emergencyStop: stop });
    const sky = new LabSky(labNative, ready.pid);
    session = new WindowsSession(sky, { stateRoot: path.join(work, 'state'), native: sessionNative, emergencyStop: stop });

    // Action d'arrière-plan vérifiée : postcondition, technique, premier plan et curseur intacts.
    const background = async (label, observation, request, { technique = /^background:/ } = {}) => {
      const before = await probeNative.probe();
      const result = await session.act(observation, request);
      const after = await probeNative.probe();
      assert.equal(result.status, 'verified', `${label}: ${result.status}`);
      assert.match(result.technique, technique, label);
      assert.equal(result.foregroundTaken, false, `${label}: foreground taken`);
      assert.equal(fixtureWindows.has(after.foreground) && !fixtureWindows.has(before.foreground), false, `${label}: a fixture window became foreground`);
      // Julien a pu bouger la souris pendant l'action : le curseur n'est jugé que s'il n'y a eu aucune entrée.
      const julienInput = after.idleMs < result.durationMs + 50;
      if (!julienInput) assert.deepEqual(after.cursor, before.cursor, `${label}: cursor moved`);
      measures.push({ label, technique: result.technique, mechanism: result.mechanism, durationMs: result.durationMs, cursorChecked: !julienInput });
      return result;
    };
    const text = (automationId, equals) => ({ selector: { automationId }, field: 'name', equals });

    await t.test('presence: the guard reports Raw Input (physical input only)', () => {
      assert.equal(stop.presence.source, 'raw-input');
    });

    await t.test('WinForms: Value, Toggle, Invoke, CB/LB_SETCURSEL in background', async () => {
      await session.bind({ id: ready.winforms });
      let obs = await session.observe();
      assert.equal(obs.source, 'native-uia');
      obs = (await background('WinForms setValue', obs, { kind: 'setValue', selector: { automationId: 'nom', role: 'edit' }, value: 'Bonjour é Ω',
        expect: { selector: { automationId: 'nom' }, field: 'value', equals: 'Bonjour é Ω' } })).observation;
      obs = (await background('WinForms checkbox', obs, { kind: 'click', selector: { automationId: 'option' }, expect: { selector: { automationId: 'option' }, field: 'checked', equals: true } })).observation;
      obs = (await background('WinForms button', obs, { kind: 'click', selector: { automationId: 'enregistrer' }, expect: text('etat', 'Enregistré 1') })).observation;
      obs = (await background('WinForms combo', obs, { kind: 'select', selector: { automationId: 'couleur' }, option: 'Vert', expect: text('etat', 'Couleur Vert') })).observation;
      await background('WinForms list', obs, { kind: 'select', selector: { automationId: 'fruits' }, option: 'Poire', expect: text('etat', 'Fruit Poire') });
      const s = await state();
      assert.equal(s['winforms.text'], 'Bonjour é Ω');
      assert.equal(s['winforms.checked'], true);
      assert.equal(s['winforms.checkChanged'], 1);
      assert.equal(s['winforms.saves'], 1);
      assert.equal(s['winforms.colorChanged'], 1);
      assert.equal(s['winforms.fruitChanged'], 1);
    });

    await t.test('multi-window: an owned dialog is followed, then left when it closes', async () => {
      let obs = await session.observe();
      const opened = await background('WinForms dialog open', obs, { kind: 'click', selector: { automationId: 'dialogue' }, expect: { selector: { automationId: 'fermer' }, exists: true } });
      const dialog = (await state())['winforms.dialog'];
      assert.equal(opened.windowChange?.reason, 'opened');
      assert.equal(opened.observation.window.id, dialog);
      fixtureWindows.add(dialog);
      const closed = await background('WinForms dialog close', opened.observation, { kind: 'click', selector: { automationId: 'fermer' }, expect: { selector: { automationId: 'dialogue' }, exists: true } });
      assert.equal(closed.windowChange?.reason, 'closed');
      assert.equal(closed.observation.window.id, ready.winforms);
      const s = await state();
      assert.equal(s['winforms.dialogOpened'], 1);
      assert.equal(s['winforms.dialogClosed'], 1);
    });

    await t.test('Win32: BN_CLICKED, BM_SETCHECK, EM_REPLACESEL, CB/LB_SETCURSEL, WM_COMMAND menu', async () => {
      await session.bind({ id: ready.win32 });
      let obs = await session.observe();
      obs = (await background('Win32 button', obs, { kind: 'click', selector: { name: 'Valider', role: 'button' }, expect: text('106', 'Valider 1') }, { technique: /^background:messages$/ })).observation;
      obs = (await background('Win32 checkbox', obs, { kind: 'click', selector: { name: 'Activer', role: 'checkbox' }, expect: { selector: { automationId: '102' }, field: 'checked', equals: true } }, { technique: /^background:messages$/ })).observation;
      obs = (await background('Win32 setValue', obs, { kind: 'setValue', selector: { automationId: '103', role: 'edit' }, value: 'Texte 32', expect: { selector: { automationId: '103' }, field: 'value', equals: 'Texte 32' } }, { technique: /^background:messages$/ })).observation;
      obs = (await background('Win32 typeText', obs, { kind: 'typeText', focus: { automationId: '103', role: 'edit' }, text: ' suite', expect: { selector: { automationId: '103' }, field: 'value', equals: 'Texte 32 suite' } }, { technique: /^background:messages$/ })).observation;
      obs = (await background('Win32 combo', obs, { kind: 'select', selector: { automationId: '104', role: 'combobox' }, option: 'Bravo', expect: text('106', 'Choix Bravo') }, { technique: /^background:messages$/ })).observation;
      obs = (await background('Win32 list item', obs, { kind: 'click', selector: { name: 'Trois', role: 'listitem' }, expect: text('106', 'Liste Trois') }, { technique: /^background:messages$/ })).observation;
      obs = (await background('Win32 menu', obs, { kind: 'menu', path: 'Fichier > Compter', expect: text('106', 'Compter 1') }, { technique: /^background:messages$/ })).observation;
      await assert.rejects(session.act(obs, { kind: 'menu', path: 'Fichier > Désactivé' }), error => error.refused === true && /disabled/.test(error.message));
      const s = await state();
      assert.equal(s['win32.valider'], 1);
      assert.equal(s['win32.activer'], 1);
      assert.equal(s['win32.checked'], true);
      assert.ok(s['win32.editChanged'] >= 2);
      assert.equal(s['win32.comboChanged'], 1);
      assert.equal(s['win32.listChanged'], 1);
      assert.equal(s['win32.menu'], 1);
      assert.equal(s['win32.disabledMenu'], undefined);
    });

    await t.test('batch: stops at the first unmet step, the next step is never sent', async () => {
      const obs = await session.observe();
      const started = Date.now();
      const batch = await session.actBatch(obs, [
        { kind: 'click', selector: { name: 'Valider', role: 'button' }, expect: text('106', 'Valider 2') },
        { kind: 'setValue', selector: { automationId: '103', role: 'edit' }, value: 'x', timeoutMs: 300, expect: { selector: { automationId: '103' }, field: 'value', equals: 'impossible' } },
        { kind: 'click', selector: { name: 'Valider', role: 'button' }, expect: text('106', 'Valider 3') },
      ]);
      measures.push({ label: 'Win32 batch (2 of 3 steps sent)', technique: batch.steps.map(s => s.technique).join(' + '), durationMs: Date.now() - started });
      assert.equal(batch.status, 'stopped');
      assert.equal(batch.stoppedAt, 1);
      assert.deepEqual(batch.steps.map(s => s.status), ['verified', 'unmet']);
      assert.equal((await state())['win32.valider'], 2);
    });

    await t.test('capture: covered Win32 window, PrintWindow, not blank, without foreground', async () => {
      const before = await probeNative.probe();
      const obs = await session.observe({ mode: 'image', capture: 'native' });
      const after = await probeNative.probe();
      assert.equal(obs.imageFallback, null);
      assert.equal(obs.images.length, 1);
      const image = obs.images[0];
      assert.match(image.method, /^printwindow/);
      assert.ok(image.width > 100 && image.height > 100);
      assert.ok((await stat(image.path)).size > 1000);
      assert.ok(image.path.startsWith(path.join(work, 'state', 'captures')));
      assert.equal(fixtureWindows.has(after.foreground), false);
      assert.equal(after.foreground === before.foreground || !fixtureWindows.has(after.foreground), true);
      measures.push({ label: 'Capture covered Win32 window', technique: image.method, durationMs: image.ms });
    });

    await t.test('WPF: COM UI Automation with AutoSetFocus = FALSE', async () => {
      await session.bind({ id: ready.wpf });
      let obs = await session.observe();
      obs = (await background('WPF button', obs, { kind: 'click', selector: { automationId: 'valider-wpf' }, expect: text('etat-wpf', 'Validé 1') }, { technique: /^background:uia$/ })).observation;
      obs = (await background('WPF checkbox', obs, { kind: 'click', selector: { automationId: 'option-wpf' }, expect: { selector: { automationId: 'option-wpf' }, field: 'checked', equals: true } }, { technique: /^background:uia$/ })).observation;
      await background('WPF setValue', obs, { kind: 'setValue', selector: { automationId: 'editeur' }, value: 'WPF ok', expect: { selector: { automationId: 'editeur' }, field: 'value', equals: 'WPF ok' } }, { technique: /^background:uia$/ });
      const s = await state();
      assert.equal(s['wpf.clicks'], 1);
      assert.equal(s['wpf.checked'], 1);
      assert.equal(s['wpf.text'], 'WPF ok');
    });

    await t.test('no physical Sky input was ever attempted by the background scenarios', () => {
      assert.deepEqual(sky.physical, []);
    });

    // Repli qui prend le premier plan : seulement si Julien est inactif depuis 120 s (mesuré avant le test et maintenant).
    const idleNow = (await probeNative.probe()).idleMs;
    const physicalAllowed = idleAtStart >= IDLE_REQUIRED_MS && stop.presence.idleMs() >= 5000;
    await t.test('physical fallback (foreground UIA under the shared token)', {
      skip: physicalAllowed ? false : `sauté : Julien actif (inactif depuis ${Math.round(idleAtStart / 1000)} s au départ, ${Math.round(idleNow / 1000)} s maintenant ; 120 s requises)`,
    }, async () => {
      await session.bind({ id: ready.winforms });
      const obs = await session.observe();
      const result = await session.act(obs, { kind: 'click', selector: { automationId: 'nom', role: 'edit' }, expect: { selector: { automationId: 'nom' }, field: 'focused', equals: true } });
      assert.equal(result.status, 'verified');
      assert.equal(result.technique, 'foreground:uia');
      assert.equal(result.attempts[0].outcome, 'not-applicable');
      measures.push({ label: 'Foreground fallback (SetFocus)', technique: result.technique, durationMs: result.durationMs, foregroundTaken: result.foregroundTaken });
    });
  } finally {
    await session?.close().catch(() => {});
    labNative?.close(); sessionNative?.close(); probeNative.close();
    stop.close();
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 5000);
    await exited; clearTimeout(timer);
    await rm(work, { recursive: true, force: true });
    if (reports && measures.length) {
      await mkdir(reports, { recursive: true });
      await writeFile(path.join(reports, `live-background-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify({ schema: 1, idleAtStartMs: idleAtStart, measures }, null, 2));
    }
    for (const m of measures) console.log(`MESURE ${m.label} | ${m.technique} | ${m.mechanism ?? ''} | ${m.durationMs} ms${m.cursorChecked === false ? ' | curseur non jugé (entrée de Julien)' : ''}`);
  }
});
