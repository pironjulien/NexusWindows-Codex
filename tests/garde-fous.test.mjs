// Garde-fous : politique commune (copie embarquée identique), échec fermé, et confirmation étanche dans la session
// (clic par sélecteur ou en coordonnées, touches, saut de ligne, menu, action secondaire, lot, routine).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as gardeFous from '../lib/garde-fous.mjs';
import { WindowsSession } from '../lib/session.mjs';

test('the embedded copy is identical to the shared NexusHarness policy', { skip: existsSync(gardeFous.SHARED_POLICY) ? false : 'dossier shared voisin absent (version publique)' }, () => {
  assert.equal(readFileSync(gardeFous.EMBEDDED_POLICY, 'utf8'), readFileSync(gardeFous.SHARED_POLICY, 'utf8'));
});

test('the policy has a codex entry: own app, sign-in screens and password managers blocked; consoles free', () => {
  const data = JSON.parse(readFileSync(gardeFous.EMBEDDED_POLICY, 'utf8'));
  const blocks = data.agents.codex.map(c => data.blocage_dur[c]);
  const processes = blocks.flatMap(b => b.processus ?? []);
  for (const p of ['codex.exe', 'chatgpt.exe', 'consent.exe', 'lockapp.exe', 'logonui.exe', 'credentialuibroker.exe']) assert.ok(processes.includes(p), p);
  const prefixes = blocks.flatMap(b => b.prefixes_processus ?? []);
  for (const p of ['keepass', 'bitwarden', '1password', 'dashlane', 'nordpass', 'roboform', 'lastpass']) assert.ok(prefixes.includes(p), p);
  for (const p of ['windowsterminal.exe', 'openconsole.exe', 'conhost.exe', 'sechealthui.exe', 'powershell_ise.exe']) assert.equal(processes.includes(p), false, p);
  assert.ok(gardeFous.load(gardeFous.EMBEDDED_POLICY).confirm);
});

test('missing or invalid policy fails closed', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nexus-gf-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.throws(() => gardeFous.load(path.join(dir, 'absent.json')), e => e.refused && /illisible/.test(e.message));
  const data = JSON.parse(readFileSync(gardeFous.EMBEDDED_POLICY, 'utf8'));
  data.confirmation.motifs.push('(non ferme');
  await writeFile(path.join(dir, 'casse.json'), JSON.stringify(data));
  assert.throws(() => gardeFous.load(path.join(dir, 'casse.json')), e => e.refused && /invalide/.test(e.message));
  data.confirmation.motifs.pop(); data.agents.codex.push('absente');
  await writeFile(path.join(dir, 'inconnu.json'), JSON.stringify(data));
  assert.throws(() => gardeFous.load(path.join(dir, 'inconnu.json')), /invalide/);
  const saved = process.env.NEXUS_GARDE_FOUS;
  process.env.NEXUS_GARDE_FOUS = path.join(dir, 'absent.json');
  try { assert.equal(gardeFous.policyPath(), path.join(dir, 'absent.json')); } // jamais de repli silencieux
  finally { if (saved === undefined) delete process.env.NEXUS_GARDE_FOUS; else process.env.NEXUS_GARDE_FOUS = saved; }
});

test('words to confirm, free words and window-title contexts (same rules as garde_fous.py)', () => {
  for (const label of ['Envoyer', 'Payer', 'Publier', 'Poster', 'Supprimer définitivement', 'Vider la corbeille', 'Formater',
    'Désinstaller', 'Réinitialiser ce PC', 'Résilier', 'Supprimer mon compte', 'Rendre le dépôt public', 'Make this repository public',
    'Place your order', 'Send', 'Uninstall', 'ENVOYER LE MESSAGE']) assert.ok(gardeFous.confirmWord(label), label);
  for (const label of ['Éléments envoyés', 'Supprimer', 'Réinitialiser les filtres', 'Déployer', 'Formater le document', 'Enregistrer', 'Valider', 'OK'])
    assert.equal(gardeFous.confirmWord(label), '', label);
  assert.match(gardeFous.confirmWord('Valider', 'Paiement sécurisé'), /valider \(fenêtre de paiement/);
  assert.match(gardeFous.confirmWord('Démarrer', 'Formater Disque local (E:)'), /formatage/);
  assert.equal(gardeFous.confirmWord('Valider', 'Paramètres'), '');
});

test('key chords map to what they can trigger', () => {
  assert.deepEqual(gardeFous.keyKinds('Return'), ['submit']);
  assert.deepEqual(gardeFous.keyKinds('enter'), ['submit']);
  assert.deepEqual(gardeFous.keyKinds('ctrl+Return'), ['send']);
  assert.deepEqual(gardeFous.keyKinds('space'), ['press']);
  assert.deepEqual(gardeFous.keyKinds('alt+E'), ['alt+e']);
  assert.deepEqual(gardeFous.keyKinds('shift+Return'), []);
  assert.deepEqual(gardeFous.keyKinds('ctrl+a'), []);
  assert.deepEqual(gardeFous.keyKinds('Tab'), []);
});

// ---- Session : fournisseur Sky factice, arbre configurable ----
const TREE = [
  '0 fenêtre Messagerie',
  '\t1 Groupe ID: composeur',
  '\t\t2 édition Message ID: message',
  '\t\t3 Bouton Envoyer ID: envoyer Secondary Actions: Invoke',
  '\t\t4 Bouton ID: icone-envoi',
  '\t\t\t5 Texte Envoyer',
  '\t\t6 Bouton Enregistrer ID: enregistrer',
  '\t7 Liste Dossiers ID: dossiers',
  '\t\t8 élément de liste Éléments envoyés ID: envoyes',
  '\t9 élément de menu (collapsed) Envoyer vers ID: envoyer-vers',
  '\t10 Texte Prêt ID: etat',
].join('\n');
function provider({ title = 'Messagerie', tree = TREE, focus = 2 } = {}) {
  return {
    target: 'windows', calls: [],
    windows: [{ id: 10, app: 'test!Mail', title }],
    async list_windows() { return this.windows; },
    async get_window({ id }) { return this.windows.find(w => w.id === id); },
    async get_window_state({ window, include_text, include_screenshot }) {
      return { window, accessibility: include_text ? { tree, focused_element: `${focus} édition Message ID: message` } : null,
        screenshots: include_screenshot ? [{ id: 'shot', width: 400, height: 300, originX: 100, originY: 200 }] : [] };
    },
    async click(input) { this.calls.push(['click', input]); },
    async type_text(input) { this.calls.push(['type', input]); },
    async press_key(input) { this.calls.push(['key', input]); },
    async perform_secondary_action(input) { this.calls.push(['secondary', input]); },
  };
}
async function setup(t, { native = {}, ...sky } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-gf-session-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = provider(sky);
  const session = new WindowsSession(fake, { stateRoot: root, native: { withForeground: async (_, action) => action(), ...native } });
  await session.bind({ id: 10 });
  return { sky: fake, session, observation: await session.observe({ mode: 'both' }) };
}
const refused = e => e.confirmationRequired === true && e.refused === true && e.beforeInput === true && /confirm:true/.test(e.message);

test('click on a send button, or on the text inside it, needs confirm; nothing is sent', async t => {
  const { session, sky, observation } = await setup(t);
  await assert.rejects(session.act(observation, { kind: 'click', selector: { automationId: 'envoyer' } }), refused);
  await assert.rejects(session.act(await session.observe(), { kind: 'click', selector: { name: 'Envoyer', role: 'text' } }), refused);
  await assert.rejects(session.act(await session.observe(), { kind: 'click', selector: { automationId: 'icone-envoi' }, count: 2 }), refused);
  assert.deepEqual(sky.calls, []);
  assert.equal(session.metrics().at(-1).status, 'confirmation-required');
  const done = await session.act(await session.observe(), { kind: 'click', selector: { automationId: 'envoyer' }, confirm: true });
  assert.equal(done.performed, true);
  assert.equal(sky.calls.length, 1);
});

test('non-action roles and submenus stay free; right click stays free', async t => {
  const { session, sky, observation } = await setup(t);
  await session.act(observation, { kind: 'click', selector: { automationId: 'envoyes' } });
  await session.act(await session.observe(), { kind: 'click', selector: { automationId: 'envoyer-vers' } });
  await session.act(await session.observe(), { kind: 'click', selector: { automationId: 'enregistrer' } });
  await session.act(await session.observe(), { kind: 'click', selector: { automationId: 'envoyer' }, button: 'right' });
  assert.equal(sky.calls.length, 4);
});

test('coordinate click is judged on the element under the point (native tree with bounds)', async t => {
  const elements = [
    { index: 0, depth: 0, role: 'window', name: 'Messagerie', ancestors: [], bounds: [100, 200, 400, 300] },
    { index: 1, depth: 2, role: 'button', name: 'Envoyer', ancestors: [0], bounds: [300, 400, 80, 30] },
    { index: 2, depth: 2, role: 'button', name: 'Enregistrer', ancestors: [0], bounds: [120, 400, 80, 30] },
  ];
  const { session, sky, observation } = await setup(t, { native: { inspect: async () => ({ elements }) } });
  await assert.rejects(session.act(observation, { kind: 'click', screenshotId: 'shot', point: { x: 210, y: 210 } }), e => refused(e) && /coordonnées/.test(e.message));
  assert.deepEqual(sky.calls, []);
  await session.act(await session.observe({ mode: 'both' }), { kind: 'click', screenshotId: 'shot', point: { x: 50, y: 210 } });
  await session.act(await session.observe({ mode: 'both' }), { kind: 'click', screenshotId: 'shot', point: { x: 210, y: 210 }, confirm: true });
  assert.equal(sky.calls.length, 2);
});

test('Enter, Ctrl+Enter, Space, Alt+letter and a typed newline are judged on what they would trigger', async t => {
  const { session, sky, observation } = await setup(t);
  // Entrée dans le champ : bouton d'action voisin « Envoyer » (même groupe).
  await assert.rejects(session.act(observation, { kind: 'key', key: 'Return' }), e => refused(e) && /voisin du champ/.test(e.message));
  await assert.rejects(session.act(await session.observe(), { kind: 'key', key: 'ctrl+Return' }), refused);
  await assert.rejects(session.act(await session.observe(), { kind: 'typeText', focus: { automationId: 'message' }, text: 'Bonjour\n' }), e => refused(e) && /saut de ligne/.test(e.message));
  assert.deepEqual(sky.calls, []);
  // Texte sans saut de ligne, Tab, Ctrl+A : libres.
  await session.act(await session.observe(), { kind: 'typeText', focus: { automationId: 'message' }, text: 'Bonjour' });
  await session.act(await session.observe(), { kind: 'key', key: 'Tab' });
  await session.act(await session.observe(), { kind: 'key', key: 'Return', confirm: true });
  assert.deepEqual([...new Set(sky.calls.map(c => c[0]))], ['type', 'key']);
  assert.deepEqual(sky.calls.filter(c => c[0] === 'key').map(c => c[1].key), ['Tab', 'Return']);
});

test('native details: default button, focused button (Space) and Alt access key', async t => {
  const base = [
    { index: 0, depth: 0, role: 'window', name: 'Boîte', ancestors: [] },
    { index: 1, depth: 2, role: 'edit', name: 'Objet', ancestors: [0], focused: false },
    { index: 2, depth: 2, role: 'button', name: 'Envoyer', ancestors: [0], accessKey: 'Alt+E', isDefault: false, focused: false },
    { index: 3, depth: 2, role: 'button', name: 'Fermer', ancestors: [0], accessKey: 'Alt+F' },
  ];
  let elements = base;
  const { session, sky, observation } = await setup(t, { native: { inspect: async () => ({ elements }) } });
  await assert.rejects(session.act(observation, { kind: 'key', key: 'alt+e' }), e => refused(e) && /raccourci/.test(e.message));
  await session.act(await session.observe(), { kind: 'key', key: 'alt+f' });
  elements = base.map(e => e.index === 2 ? { ...e, isDefault: true } : e.index === 1 ? { ...e, focused: true } : e);
  await assert.rejects(session.act(await session.observe(), { kind: 'key', key: 'Return' }), e => refused(e) && /par défaut/.test(e.message));
  // WPF : bouton par défaut exposé par l'AccessKey « retour chariot », lettre soulignée seulement dans le texte « _Envoyer ».
  elements = [base[0], { ...base[1], focused: true }, { ...base[2], accessKey: String.fromCharCode(13), children: undefined },
    { index: 4, depth: 4, role: 'text', name: '_Envoyer', ancestors: [0, 2] }, base[3]];
  await assert.rejects(session.act(await session.observe(), { kind: 'key', key: 'Return' }), e => refused(e) && /par défaut/.test(e.message));
  await assert.rejects(session.act(await session.observe(), { kind: 'key', key: 'alt+e' }), e => refused(e) && /lettre soulignée/.test(e.message));
  // Fenêtre inactive (aucun focus connu) : Entrée et Espace jugés sur tous les boutons d'action de la fenêtre.
  elements = base;
  await assert.rejects(session.act(await session.observe(), { kind: 'key', key: 'Return' }), e => refused(e) && /bouton d'action de la fenêtre/.test(e.message));
  elements = base.map(e => e.index === 2 ? { ...e, focused: true } : e);
  await assert.rejects(session.act(await session.observe(), { kind: 'key', key: 'space' }), e => refused(e) && /élément visé/.test(e.message));
  assert.equal(sky.calls.length, 1);
});

test('a generic verb needs confirm only in a payment or formatting window', async t => {
  const tree = '0 fenêtre Paiement\n\t1 Bouton Valider ID: valider';
  const { session, sky, observation } = await setup(t, { title: 'Paiement sécurisé', tree, focus: 1 });
  await assert.rejects(session.act(observation, { kind: 'click', selector: { automationId: 'valider' } }), e => refused(e) && /paiement/.test(e.message));
  assert.deepEqual(sky.calls, []);
  const free = await setup(t, { title: 'Paramètres', tree, focus: 1 });
  await free.session.act(free.observation, { kind: 'click', selector: { automationId: 'valider' } });
  assert.equal(free.sky.calls.length, 1);
});

test('menu command and secondary actions: the triggered item is judged, Expand stays free', async t => {
  const { session, sky, observation } = await setup(t, { native: { call: async () => ({ technique: 'background:messages', effect: 'sent' }) } });
  await assert.rejects(session.act(observation, { kind: 'menu', path: 'Fichier > Envoyer' }), refused);
  await assert.rejects(session.act(await session.observe(), { kind: 'secondary', selector: { automationId: 'envoyer' }, action: 'Invoke' }), refused);
  assert.deepEqual(sky.calls, []);
  await session.act(await session.observe(), { kind: 'menu', path: 'Fichier > Enregistrer' });
});

test('a batch stops on confirmation-required before sending the step; a recipe is never an order', async t => {
  const { session, sky, observation } = await setup(t);
  const expect = { selector: { automationId: 'etat' }, field: 'name', equals: 'Envoyé' };
  const batch = await session.actBatch(observation, [{ kind: 'click', selector: { automationId: 'envoyer' }, expect }]);
  assert.equal(batch.status, 'stopped');
  assert.equal(batch.steps[0].status, 'confirmation-required');
  assert.deepEqual(sky.calls, []);
  await assert.rejects(session.act(await session.observe(), { kind: 'click', selector: { automationId: 'envoyer' }, confirm: 'yes' }), /confirm must be boolean/);
});
