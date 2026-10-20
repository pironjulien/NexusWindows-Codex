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
    async activate_window() {},
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
// Geste sortant : confirm:true seul est refusé avec le jeton de CETTE action ; renvoyé avec le jeton (oui de Julien), il passe.
const accordRequired = e => refused(e) && e.accordRequired === true && /^[0-9a-f]{8}$/.test(e.accord);
async function withAccord(session, spec, mode = 'text') {
  let token;
  await assert.rejects(session.act(await session.observe({ mode }), { ...spec, confirm: true }), e => accordRequired(e) && /alone is not enough/.test(e.message) && !!(token = e.accord));
  return session.act(await session.observe({ mode }), { ...spec, confirm: true, accord: token });
}

test('click on a send button, or on the text inside it, needs confirm; nothing is sent', async t => {
  const { session, sky, observation } = await setup(t);
  await assert.rejects(session.act(observation, { kind: 'click', selector: { automationId: 'envoyer' } }), refused);
  await assert.rejects(session.act(await session.observe(), { kind: 'click', selector: { name: 'Envoyer', role: 'text' } }), refused);
  await assert.rejects(session.act(await session.observe(), { kind: 'click', selector: { automationId: 'icone-envoi' }, count: 2 }), refused);
  assert.deepEqual(sky.calls, []);
  assert.equal(session.metrics().at(-1).status, 'confirmation-required');
  const done = await withAccord(session, { kind: 'click', selector: { automationId: 'envoyer' } });
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
  await withAccord(session, { kind: 'click', screenshotId: 'shot', point: { x: 210, y: 210 } }, 'both');
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
  await withAccord(session, { kind: 'key', key: 'Return' });
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

// ---- Accord lié à l'action exacte (politique v2, 19/10/2026) ----
const MAIL = ['0 fenêtre Nouveau message', '\t1 Groupe ID: composeur', '\t\t2 édition À ID: a Value: alice@example.com',
  '\t\t3 édition Message ID: message Value: ok demain', '\t\t4 Bouton Envoyer ID: envoyer', '\t\t5 Bouton Désinstaller ID: desinstaller'].join('\n');
const send = { kind: 'click', selector: { automationId: 'envoyer' } };

test('outward words need an accord, local destructions keep confirm alone (same split as garde_fous.py)', () => {
  for (const label of ['Envoyer', 'Send', 'Payer', 'Publier', 'Appeler']) assert.ok(gardeFous.outwardWord(label), label);
  for (const label of ['Désinstaller', 'Uninstall', 'Vider la corbeille', 'Formater']) {
    assert.ok(gardeFous.confirmWord(label), label);
    assert.equal(gardeFous.outwardWord(label), '', label);
  }
  assert.match(gardeFous.outwardWord('Valider', 'Paiement sécurisé'), /paiement/);
  assert.equal(gardeFous.outwardWord('Démarrer', 'Formater Disque local (E:)'), '');
});

test('the accord is bound to the exact action: field contents, single use, other action', async t => {
  const { session, sky, observation } = await setup(t, { tree: MAIL, focus: 3 });
  let token;
  await assert.rejects(session.act(observation, { ...send, confirm: true }), e => accordRequired(e) && !!(token = e.accord) &&
    e.summary.includes('alice@example.com') && e.summary.includes('ok demain') && /Envoyer/.test(e.summary));
  // Le contenu change entre l'accord et l'exécution (un destinataire glissé par un texte lu) : jeton annulé.
  const changed = await setup(t, { tree: MAIL.replace('alice@example.com', 'mallory@example.net'), focus: 3 });
  await assert.rejects(changed.session.act(changed.observation, { ...send, confirm: true, accord: token }),
    e => accordRequired(e) && /changed since the accord \(recipient\)/.test(e.message));
  assert.deepEqual(changed.sky.calls, []);
  // Le jeton annulé ne sert plus, même pour l'action d'origine ; un jeton inventé (lu dans un texte) non plus.
  await assert.rejects(session.act(await session.observe(), { ...send, confirm: true, accord: token }), e => accordRequired(e) && /unknown or already used/.test(e.message));
  await assert.rejects(session.act(await session.observe(), { ...send, confirm: true, accord: 'deadbeef' }), e => accordRequired(e) && /unknown/.test(e.message));
  // Sans confirm:true, même un bon jeton ne suffit pas.
  await assert.rejects(session.act(await session.observe(), { ...send, confirm: true }), e => !!(token = e.accord));
  await assert.rejects(session.act(await session.observe(), { ...send, accord: token }), accordRequired);
  assert.deepEqual(sky.calls, []);
  // Jeton d'une autre action (Entrée dans le champ) refusé pour le clic.
  let keyToken;
  await assert.rejects(session.act(await session.observe(), { kind: 'key', key: 'Return', confirm: true }), e => accordRequired(e) && !!(keyToken = e.accord));
  await assert.rejects(session.act(await session.observe(), { ...send, confirm: true, accord: keyToken }),
    e => accordRequired(e) && /changed since the accord \(gesture, trigger\)/.test(e.message));
  // Bon jeton, action inchangée : passe une fois, puis plus jamais.
  await assert.rejects(session.act(await session.observe(), { ...send, confirm: true }), e => !!(token = e.accord));
  assert.equal((await session.act(await session.observe(), { ...send, confirm: true, accord: token })).performed, true);
  await assert.rejects(session.act(await session.observe(), { ...send, confirm: true, accord: token }), e => /already used/.test(e.message));
  assert.equal(sky.calls.length, 1);
  // Destruction locale : confirm:true seul suffit.
  await session.act(await session.observe(), { kind: 'click', selector: { automationId: 'desinstaller' }, confirm: true });
  assert.equal(sky.calls.length, 2);
});

test('an expired accord is refused', () => {
  let now = 0;
  const reg = new gardeFous.Accords({ clock: () => now });
  const act = gardeFous.action({ gesture: 'clic', targets: ['Envoyer'] });
  const first = reg.check(act, true, '');
  assert.ok(first.accordRequired);
  now = gardeFous.load().accordMs + 1;
  assert.match(reg.check(act, true, first.accord).message, /expired/);
  const again = reg.check(act, true, '');
  assert.equal(reg.check(act, true, again.accord), null);
});

test('a typed newline binds the typed text; a batch step and a recipe carry their accord', async t => {
  const { session, sky } = await setup(t, { tree: MAIL, focus: 3 });
  let token;
  await assert.rejects(session.act(await session.observe(), { kind: 'typeText', focus: { automationId: 'message' }, text: 'Oui\n', confirm: true }),
    e => accordRequired(e) && e.summary.includes('typed: Oui') && !!(token = e.accord));
  await assert.rejects(session.act(await session.observe(), { kind: 'typeText', focus: { automationId: 'message' }, text: 'Non\n', confirm: true, accord: token }),
    e => /changed since the accord \(content\)/.test(e.message));
  const expect = { selector: { automationId: 'envoyer' }, field: 'name', equals: 'Envoyé' };
  const first = await session.actBatch(await session.observe(), [{ ...send, expect, confirm: true }]);
  assert.equal(first.steps[0].status, 'confirmation-required');
  token = /accord:"([0-9a-f]{8})"/.exec(first.steps[0].error)[1];
  const batch = await session.actBatch(await session.observe(), [{ ...send, expect, confirm: true, accord: token }]);
  assert.notEqual(batch.steps[0].status, 'confirmation-required');
  assert.equal(sky.calls.length, 1);
  await assert.rejects(session.act(await session.observe(), { ...send, confirm: true, accord: 'pas-un-jeton' }), /accord must be/);
});

test('a drag pressed or released on a send button is judged like a click', async t => {
  const elements = [
    { index: 0, depth: 0, role: 'window', name: 'Messagerie', ancestors: [], bounds: [100, 200, 400, 300] },
    { index: 1, depth: 2, role: 'button', name: 'Envoyer', ancestors: [0], bounds: [300, 400, 80, 30] },
  ];
  const { session, sky, observation } = await setup(t, { native: { inspect: async () => ({ elements }) } });
  sky.drag = async input => { sky.calls.push(['drag', input]); };
  await assert.rejects(session.act(observation, { kind: 'drag', screenshotId: 'shot', from: { x: 210, y: 210 }, to: { x: 210, y: 210 } }), e => refused(e) && /glisser/.test(e.message));
  await assert.rejects(session.act(await session.observe({ mode: 'both' }), { kind: 'drag', screenshotId: 'shot', from: { x: 20, y: 20 }, to: { x: 210, y: 210 }, confirm: true }), accordRequired);
  assert.deepEqual(sky.calls, []);
});

test('the summary shows the recipient first, in full, even after a long body', async t => {
  const body = 'x'.repeat(2100);
  const { session, observation } = await setup(t, { tree: MAIL.replace('Value: ok demain', `Value: ${body}`), focus: 3 });
  await assert.rejects(session.act(observation, { ...send, confirm: true }), e => accordRequired(e) &&
    e.summary.indexOf('to alice@example.com') > 0 && e.summary.indexOf('to alice@example.com') < e.summary.indexOf('xxx') && /\(2109 chars\)/.test(e.summary));
});

test('a page or thread that keeps changing, or a counter in the title, does not void a legitimate yes', async t => {
  let thread = 'vu il y a 1 min', title = 'Nouveau message';
  const tree = () => MAIL + `\n\t6 document Fil ID: fil Value: ${thread}`;
  const { session, sky } = await setup(t, { tree: tree(), focus: 3 });
  const orig = sky.get_window_state;
  sky.get_window_state = async args => { const r = await orig.call(sky, args); if (r.accessibility) r.accessibility.tree = tree(); return r; };
  sky.get_window = async () => ({ ...sky.windows[0], title });
  sky.list_windows = async () => [{ ...sky.windows[0], title }];
  let token;
  await assert.rejects(session.act(await session.observe(), { ...send, confirm: true }), e => accordRequired(e) && !e.summary.includes('vu il y a') && !!(token = e.accord));
  thread = 'vu il y a 2 min'; title = '(3) Nouveau message';
  assert.equal((await session.act(await session.observe(), { ...send, confirm: true, accord: token })).performed, true);
  assert.equal(sky.calls.length, 1);
});

test('a refusal before any input gives the accord back: the yes is not lost', async t => {
  const { session, sky } = await setup(t, { tree: MAIL, focus: 2, native: { call: async () => { throw Object.assign(new Error('no background'), { notApplicable: true }); } } });
  let focus = 2;
  const orig = sky.get_window_state;
  sky.get_window_state = async args => { const r = await orig.call(sky, args); if (r.accessibility) r.accessibility.focused_element = `${focus} édition`; return r; };
  const typed = { kind: 'typeText', focus: { automationId: 'message' }, text: 'Oui\n' };
  let token;
  await assert.rejects(session.act(await session.observe(), { ...typed, confirm: true }), e => accordRequired(e) && !!(token = e.accord));
  await assert.rejects(session.act(await session.observe(), { ...typed, confirm: true, accord: token }), e => !e.accordRequired && /keyboard focus/.test(e.message));
  focus = 3;
  const done = await session.act(await session.observe(), { ...typed, confirm: true, accord: token });
  assert.equal(done.performed, true);
  await assert.rejects(session.act(await session.observe(), { ...typed, confirm: true, accord: token }), e => /already used/.test(e.message));
});

test('typed line breaks are bound one by one: one yes never sends more messages than shown', async t => {
  const { session, sky } = await setup(t, { tree: MAIL, focus: 3 });
  const typed = text => ({ kind: 'typeText', focus: { automationId: 'message' }, text, confirm: true });
  let token;
  await assert.rejects(session.act(await session.observe(), typed('Je confirme le virement\n')),
    e => accordRequired(e) && /1 typed line break/.test(e.summary) && /⏎/.test(e.summary) && !!(token = e.accord));
  await assert.rejects(session.act(await session.observe(), { ...typed('Je confirme\nle virement\n'), accord: token }),
    e => /changed since the accord \(content\)/.test(e.message) && /2 typed line break/.test(e.summary));
  assert.deepEqual(sky.calls, []);
});

test('recipient chips (address turned into a button, field emptied) are shown and bound', async t => {
  const chips = who => ['0 fenêtre Nouveau message', '\t1 Groupe ID: composeur', '\t\t2 Groupe À ID: a',
    `\t\t\t3 Bouton ${who} ID: chip`, '\t\t\t4 édition Ajouter un destinataire ID: saisie', '\t\t5 édition Message ID: message Value: ok demain',
    '\t\t6 Bouton Envoyer ID: envoyer', '\t\t7 Bouton Enregistrer ID: enregistrer'].join('\n');
  const { session, observation } = await setup(t, { tree: chips('alice@example.com'), focus: 5 });
  let token;
  await assert.rejects(session.act(observation, { ...send, confirm: true }),
    e => accordRequired(e) && e.summary.includes('next to the recipient field "alice@example.com"') && !e.summary.includes('Enregistrer') && !!(token = e.accord));
  const swapped = await setup(t, { tree: chips('mallory@example.net'), focus: 5 });
  await assert.rejects(swapped.session.act(swapped.observation, { ...send, confirm: true, accord: token }),
    e => /changed since the accord \(recipient\)/.test(e.message));
  assert.deepEqual(swapped.sky.calls, []);
});

test('a mail body exposed as a document next to the send button is bound', async t => {
  const body = text => ['0 fenêtre Nouveau message', '\t1 Groupe ID: composeur', '\t\t2 édition À ID: a Value: alice@example.com',
    `\t\t3 document Corps ID: corps Value: ${text}`, '\t\t4 Bouton Envoyer ID: envoyer'].join('\n');
  const { session, observation } = await setup(t, { tree: body('RDV demain 10h'), focus: 2 });
  let token;
  await assert.rejects(session.act(observation, { ...send, confirm: true }), e => accordRequired(e) && e.summary.includes('RDV demain 10h') && !!(token = e.accord));
  const other = await setup(t, { tree: body('Voici mon IBAN'), focus: 2 });
  await assert.rejects(other.session.act(other.observation, { ...send, confirm: true, accord: token }), e => /changed since the accord \(content\)/.test(e.message));
  assert.deepEqual(other.sky.calls, []);
});

test('Gmail-like row: chips next to an emptied « To recipients » field are recipients, whatever their name', async t => {
  const row = who => ['0 fenêtre Nouveau message', '\t1 Groupe ID: composeur', '\t\t2 Groupe ID: ligne-a',
    `\t\t\t3 Bouton ${who} ID: chip`, '\t\t\t4 édition To recipients ID: to', '\t\t5 édition Message ID: message Value: ok',
    '\t\t6 Bouton Envoyer ID: envoyer'].join('\n');
  const { session, observation } = await setup(t, { tree: row('Call Center <call@example.com>'), focus: 5 });
  let token;
  await assert.rejects(session.act(observation, { ...send, confirm: true }),
    e => accordRequired(e) && e.summary.includes('"Call Center <call@example.com>"') && !!(token = e.accord));
  const swapped = await setup(t, { tree: row('Call Center <call@evil.example>'), focus: 5 });
  await assert.rejects(swapped.session.act(swapped.observation, { ...send, confirm: true, accord: token }), e => /changed since the accord \(recipient\)/.test(e.message));
});

test('a web form: a label or a countdown is never a recipient, and a ticking countdown does not void the yes', async t => {
  let left = '09:59';
  const form = () => ['0 fenêtre Commande', '\t1 Groupe ID: formulaire', '\t\t2 Texte E-mail', '\t\t3 édition E-mail ID: mail Value: j@example.com',
    `\t\t4 Texte Offre expire dans ${left}`, '\t\t5 Texte À : bob@example.com', '\t\t6 Bouton Payer ID: payer'].join('\n');
  const { session, sky } = await setup(t, { tree: form(), focus: 3 });
  const orig = sky.get_window_state;
  sky.get_window_state = async args => { const r = await orig.call(sky, args); if (r.accessibility) r.accessibility.tree = form(); return r; };
  const pay = { kind: 'click', selector: { automationId: 'payer' } };
  let token;
  await assert.rejects(session.act(await session.observe(), { ...pay, confirm: true }),
    e => accordRequired(e) && / · to j@example\.com · /.test(e.summary) && !e.summary.includes('expire') && !e.summary.includes('bob@') && !!(token = e.accord));
  left = '09:41';
  assert.equal((await session.act(await session.observe(), { ...pay, confirm: true, accord: token })).performed, true);
});

test('typed text is shown in full and bound exactly, trailing spaces and tabs included', async t => {
  const { session } = await setup(t, { tree: MAIL, focus: 3 });
  const text = `${'a'.repeat(3000)} PS: virement\n`;
  let token;
  await assert.rejects(session.act(await session.observe(), { kind: 'typeText', focus: { automationId: 'message' }, text, confirm: true }),
    e => accordRequired(e) && e.summary.includes('PS: virement') && !!(token = e.accord));
  await assert.rejects(session.act(await session.observe(), { kind: 'typeText', focus: { automationId: 'message' }, text: `${text}  `, confirm: true, accord: token }),
    e => /changed since the accord \(content\)/.test(e.message));
});

test('a chat app: switching conversation (title, heading or selected chat) voids the accord; a counter does not', async t => {
  let title = 'Alice | Microsoft Teams', selected = 'Alice';
  const chat = () => ['0 fenêtre Teams', `\t1 élément de liste (selected) ${selected} ID: conv`, '\t2 Groupe ID: composeur',
    '\t\t3 édition Message ID: message Value: Voici le code 4821', '\t\t4 Bouton Envoyer ID: envoyer'].join('\n');
  const { session, sky } = await setup(t, { tree: chat(), focus: 3 });
  const orig = sky.get_window_state;
  sky.get_window_state = async args => { const r = await orig.call(sky, args); if (r.accessibility) r.accessibility.tree = chat(); return r; };
  sky.get_window = async () => ({ ...sky.windows[0], title });
  sky.list_windows = async () => [{ ...sky.windows[0], title }];
  let token;
  await assert.rejects(session.act(await session.observe(), { ...send, confirm: true }), e => accordRequired(e) && /conversation .*Alice/.test(e.summary) && !!(token = e.accord));
  title = 'Mallory | Microsoft Teams';
  await assert.rejects(session.act(await session.observe(), { ...send, confirm: true, accord: token }), e => /changed since the accord \(conversation\)/.test(e.message));
  title = 'Alice | Microsoft Teams'; selected = 'Mallory';
  await assert.rejects(session.act(await session.observe(), { ...send, confirm: true }), e => !!(token = e.accord));
  selected = 'Alice';
  await assert.rejects(session.act(await session.observe(), { ...send, confirm: true, accord: token }), e => /changed since the accord \(conversation\)/.test(e.message));
  await assert.rejects(session.act(await session.observe(), { ...send, confirm: true }), e => !!(token = e.accord));
  title = '(3) Alice | Microsoft Teams';
  assert.equal((await session.act(await session.observe(), { ...send, confirm: true, accord: token })).performed, true);
});

test('Gmail: a chip next to a recipient field that still holds a typed address is bound too', async t => {
  const row = who => ['0 fenêtre Nouveau message', '\t1 Groupe ID: composeur', '\t\t2 Groupe ID: ligne-a', `\t\t\t3 Bouton ${who} ID: chip`,
    '\t\t\t4 édition To recipients ID: to Value: bob@example.com', '\t\t5 Bouton Envoyer ID: envoyer'].join('\n');
  const { session, observation } = await setup(t, { tree: row('alice@example.com'), focus: 4 });
  let token;
  await assert.rejects(session.act(observation, { ...send, confirm: true }),
    e => accordRequired(e) && e.summary.includes('to bob@example.com') && e.summary.includes('"alice@example.com"') && !!(token = e.accord));
  const swapped = await setup(t, { tree: row('mallory@example.net'), focus: 4 });
  await assert.rejects(swapped.session.act(swapped.observation, { ...send, confirm: true, accord: token }), e => /changed since the accord \(recipient\)/.test(e.message));
});

test('a coordinate gesture with no element bounds under the point is judged on every action button (native reading failed)', async t => {
  const failing = { inspect: async () => { throw new Error('observation exceeds inspection bound'); } };
  const { session, sky, observation } = await setup(t, { native: failing });
  sky.drag = async input => { sky.calls.push(['drag', input]); };
  // La fenêtre a un bouton Envoyer : le clic pourrait le viser, accord exigé.
  await assert.rejects(session.act(observation, { kind: 'click', screenshotId: 'shot', point: { x: 210, y: 210 } }),
    e => refused(e) && /élément sous le point inconnu/.test(e.message));
  await assert.rejects(session.act(await session.observe({ mode: 'both' }), { kind: 'drag', screenshotId: 'shot', from: { x: 1, y: 1 }, to: { x: 210, y: 210 } }), refused);
  assert.deepEqual(sky.calls, []);
  // Aucune action sortante ni irréversible dans la fenêtre : le clic reste libre.
  const calm = await setup(t, { native: failing, tree: '0 fenêtre Dessin\n\t1 Bouton Enregistrer ID: save\n\t2 Texte Prêt ID: etat' });
  await calm.session.act(await calm.session.observe({ mode: 'both' }), { kind: 'click', screenshotId: 'shot', point: { x: 210, y: 210 } });
  assert.equal(calm.sky.calls.length, 1);
  // Rien de lu du tout (capture seule) : refus.
  const blind = await setup(t, { native: failing });
  await assert.rejects(blind.session.act(await blind.session.observe({ mode: 'image' }), { kind: 'click', screenshotId: 'shot', point: { x: 210, y: 210 } }), /nothing is known under the point/);
  assert.deepEqual(blind.sky.calls, []);
});

test('Enter in an editor nested far from its send bar still needs the accord', async t => {
  const tree = ['0 fenêtre Teams', '\t1 Groupe ID: zone', '\t\t2 Groupe ID: a', '\t\t\t3 Groupe ID: b', '\t\t\t\t4 Groupe ID: c',
    '\t\t\t\t\t5 édition Type a message ID: message Value: salut', '\t\t6 Bouton Send ID: envoyer'].join('\n');
  const { session, sky, observation } = await setup(t, { tree, focus: 5 });
  await assert.rejects(session.act(observation, { kind: 'key', key: 'Return' }), e => refused(e) && /voisin du champ/.test(e.message));
  assert.deepEqual(sky.calls, []);
});

test('a chat list exposed as a grid: the selected row is the conversation', async t => {
  let selected = 'Alice';
  const grid = () => ['0 fenêtre WhatsApp', `\t1 élément de données (selected) ${selected} ID: conv`, '\t2 Groupe ID: composeur',
    '\t\t3 édition Message ID: message Value: Le code est 4821', '\t\t4 Bouton Send ID: envoyer'].join('\n');
  const { session, sky } = await setup(t, { title: 'WhatsApp', tree: grid(), focus: 3 });
  const orig = sky.get_window_state;
  sky.get_window_state = async args => { const r = await orig.call(sky, args); if (r.accessibility) r.accessibility.tree = grid(); return r; };
  let token;
  await assert.rejects(session.act(await session.observe(), { ...send, confirm: true }), e => accordRequired(e) && /"Alice"/.test(e.summary) && !!(token = e.accord));
  selected = 'Mallory';
  await assert.rejects(session.act(await session.observe(), { ...send, confirm: true, accord: token }), e => /changed since the accord \(conversation\)/.test(e.message));
  assert.deepEqual(sky.calls, []);
});

test('a tab typed in a document body still counts as a focus move (Gmail: Tab then Space sends)', async t => {
  const tree = '0 fenêtre Gmail\n\t1 Groupe ID: composeur\n\t\t2 document Corps ID: body\n\t\t3 Bouton Envoyer ID: envoyer';
  const { session, sky } = await setup(t, { tree, focus: 2 });
  await assert.rejects(session.act(await session.observe(), { kind: 'typeText', focus: { automationId: 'body' }, text: 'Merci\t ' }), e => refused(e) && /tabulation/.test(e.message));
  assert.deepEqual(sky.calls, []);
});

test('no element under the point: a send control of any role is judged, and the body document is bound', async t => {
  const failing = { inspect: async () => { throw new Error('observation exceeds inspection bound'); } };
  const tree = body => `0 fenêtre Messagerie\n\t1 Groupe ID: composeur\n\t\t2 document Corps ID: corps Value: ${body}\n\t\t3 élément graphique Envoyer ID: envoyer`;
  const { session, sky, observation } = await setup(t, { native: failing, tree: tree('Bonjour') });
  let token;
  await assert.rejects(session.act(observation, { kind: 'click', screenshotId: 'shot', point: { x: 210, y: 210 }, confirm: true }),
    e => accordRequired(e) && e.summary.includes('Bonjour') && !!(token = e.accord));
  assert.deepEqual(sky.calls, []);
  const other = await setup(t, { native: failing, tree: tree('Voici mon IBAN') });
  await assert.rejects(other.session.act(other.observation, { kind: 'click', screenshotId: 'shot', point: { x: 210, y: 210 }, confirm: true, accord: token }),
    e => /changed since the accord \(content\)/.test(e.message));
});

test('Enter: a nearby harmless button (Emoji) does not hide a farther send button', async t => {
  const tree = ['0 fenêtre Teams', '\t1 Groupe ID: zone', '\t\t2 Groupe ID: a', '\t\t\t3 Groupe ID: b', '\t\t\t\t4 Groupe ID: c',
    '\t\t\t\t\t5 édition Type a message ID: message Value: salut', '\t\t\t\t\t6 Bouton Emoji ID: emoji', '\t\t7 Bouton Send ID: envoyer'].join('\n');
  const { session, sky, observation } = await setup(t, { tree, focus: 5 });
  await assert.rejects(session.act(observation, { kind: 'key', key: 'Return' }), e => refused(e) && /Send/.test(e.message));
  assert.deepEqual(sky.calls, []);
});

test('Tab then Space or Enter in one gesture is judged on every action button', async t => {
  const { session, sky } = await setup(t, { tree: MAIL, focus: 3 });
  await assert.rejects(session.act(await session.observe(), { kind: 'key', key: 'Tab space' }), e => refused(e) && /bouton d'action de la fenêtre/.test(e.message));
  await assert.rejects(session.act(await session.observe(), { kind: 'typeText', focus: { automationId: 'message' }, text: 'ok\t ' }), e => refused(e) && /tabulation/.test(e.message));
  await session.act(await session.observe(), { kind: 'key', key: 'Tab' });
  assert.equal(sky.calls.length, 1);
});
