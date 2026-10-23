// Postconditions qui ne prouvent rien, listes déroulantes et surgissantes (banc réel du 16/10/2026). Fournisseurs
// factices : aucune entrée de bureau réelle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WindowsSession } from '../lib/session.mjs';
import { EmergencyStop } from '../lib/stop.mjs';
import { parseTree, checkExpectation, digest } from '../lib/tree.mjs';

// Formulaire du banc : bouton Valider, case Accepter, liste déroulante Formule (options exposées sous elle) et étiquette
// de résultat. L'état vit dans `state` ; le helper factice l'applique.
function form(state) {
  const combo = `${state.expanded ? '(expanded)' : '(collapsed)'} Formule${state.value ? ' Value: ' + state.value : ''} ID: formule Secondary Actions: ${state.expanded ? 'Collapse' : 'Expand'}`;
  return [
    '0 window Banc',
    `\t1 button Valider ID: valider`,
    `\t2 check box ${state.checked ? '(checked)' : '(unchecked)'} Accepter ID: accepter`,
    `\t3 combo box ${combo}`,
    `\t\t4 list Formule`,
    ...['Alpha', 'Bravo', 'Charlie'].map((o, i) => `\t\t\t${5 + i} list item ${state.value === o ? '(selected) ' : ''}${o}`),
    `\t8 text Résultat Value: ${state.result} ID: resultat`,
  ].join('\n');
}
async function setup(t, { related } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-codex-post-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = { checked: false, expanded: false, value: '', result: 'vide', sends: 0 };
  const calls = [];
  const sky = {
    target: 'windows', windows: [{ id: 10, app: 'test!Banc', title: 'Banc' }], physical: [],
    async list_windows() { return this.windows; },
    async get_window({ id }) { return this.windows.find(w => w.id === id); },
    async get_window_state({ window, include_text }) {
      return { window, accessibility: include_text ? { tree: form(state), focused_element: '' } : null, screenshots: [] };
    },
    async click(input) { this.physical.push(input); },
  };
  const native = {
    async withForeground(_, action) { return action(); },
    ...(related ? { related } : {}),
    async call(_, op, args) {
      calls.push({ op, args });
      if (op === 'click' && args.selector.automationId === 'valider') { state.sends++; state.result = `Formule=${state.value};Envois=${state.sends}`; }
      if (op === 'click' && args.selector.automationId === 'accepter') state.checked = !state.checked;
      if (op === 'click' && args.selector.role === 'listitem') { state.value = args.selector.name; state.expanded = false; }
      if (op === 'secondary') state.expanded = args.action === 'Expand';
      if (op === 'select') { state.value = args.option; state.expanded = false; }
      return { technique: 'background:messages', effect: 'sent' };
    },
  };
  const session = new WindowsSession(sky, { stateRoot: root, native, emergencyStop: new EmergencyStop({ directory: root, watch: false }) });
  await session.bind({ id: 10 });
  return { session, state, calls, sky, observation: await session.observe() };
}
const valider = { automationId: 'valider', role: 'button' };
const formule = { automationId: 'formule', role: 'combobox' };
const refusedBeforeInput = pattern => error => error.beforeInput === true && pattern.test(error.message);

test('a postcondition that only says the clicked button exists is refused before any input', async t => {
  const { session, calls, observation } = await setup(t);
  await assert.rejects(session.act(observation, { kind: 'click', selector: valider, expect: { selector: valider, exists: true } }),
    refusedBeforeInput(/only restates the target \(its existence\)/));
  // Autre sélecteur résolu sur la même cible : même refus, à la résolution.
  await assert.rejects(session.act(await session.observe(), { kind: 'click', selector: valider, expect: { selector: { name: 'Valider' }, exists: true } }),
    refusedBeforeInput(/its existence/));
  assert.equal(calls.length, 0);
});

test('a batch refuses a trivial postcondition at validation, before its first step', async t => {
  const { session, calls, state, observation } = await setup(t);
  await assert.rejects(session.actBatch(observation, [
    { kind: 'click', selector: { automationId: 'accepter' }, expect: { selector: { automationId: 'accepter' }, field: 'checked', equals: true } },
    { kind: 'click', selector: valider, expect: { selector: valider, exists: true } },
  ]), /Step 1: Postcondition only restates the target/);
  assert.equal(calls.length, 0);
  assert.equal(state.checked, false);
});

test('a postcondition on the same command in ANOTHER attested menu is not a restatement of the target', async t => {
  // Relecture de Codex du 22/10 08:07 : la clé de sélecteur ignorait ancestor.window.
  const { session, calls, observation } = await setup(t);
  const copier = window => ({ role: 'menuitem', name: 'Copier', ancestor: { window } });
  await assert.rejects(session.actBatch(observation, [{ kind: 'click', selector: copier(200), expect: { selector: copier(200), exists: true } }]),
    /only restates the target/);
  // Autre menu : pas une redite ; la suite (cible absente de ce formulaire) est jugée normalement, sans aucune entrée.
  const other = await session.actBatch(await session.observe(), [{ kind: 'click', selector: copier(200), expect: { selector: copier(300), exists: true } }])
    .then(result => JSON.stringify(result), error => error.message);
  assert.doesNotMatch(other, /only restates the target/);
  assert.equal(calls.length, 0);
});

test('a postcondition already true that does not depend on the action never skips it: refused, nothing sent', async t => {
  const { session, calls, observation } = await setup(t);
  // L'option « Bravo » existe toujours dans l'arbre (WinForms) : elle ne prouve pas l'ouverture de la liste.
  await assert.rejects(session.act(observation, { kind: 'secondary', selector: formule, action: 'Expand', expect: { selector: { name: 'Bravo' }, exists: true } }),
    refusedBeforeInput(/already true before the action.*expanded/));
  // Texte partiel déjà présent : même refus.
  await assert.rejects(session.act(await session.observe(), { kind: 'click', selector: valider, expect: { selector: { automationId: 'resultat' }, field: 'value', includes: 'vi' } }),
    refusedBeforeInput(/already true before the action/));
  // Libellé de la cible (sélecteur sans nom) : ne dépend pas du clic.
  await assert.rejects(session.act(await session.observe(), { kind: 'click', selector: valider, expect: { selector: valider, equals: 'Valider' } }),
    refusedBeforeInput(/already true before the action/));
  assert.equal(calls.length, 0);
});

test('a precise state that the action changes is already-satisfied when observed BEFORE, and acted on otherwise', async t => {
  const { session, calls, state, observation } = await setup(t);
  const expand = { kind: 'secondary', selector: formule, action: 'Expand', expect: { selector: formule, field: 'expanded', equals: true } };
  const opened = await session.act(observation, expand);
  assert.equal(opened.status, 'verified');
  assert.equal(state.expanded, true);
  assert.equal(calls.length, 1);
  // Liste déjà ouverte : rien n'est envoyé (un Collapse/Expand inutile n'a pas lieu).
  const again = await session.act(opened.observation, { ...expand, action: 'Collapse', expect: { selector: formule, field: 'expanded', equals: true } });
  assert.equal(again.status, 'already-satisfied');
  assert.equal(calls.length, 1);
  // Case déjà cochée : le clic qui la décocherait n'est pas envoyé.
  state.checked = true;
  const check = await session.act(await session.observe(), { kind: 'click', selector: { automationId: 'accepter' }, expect: { selector: { automationId: 'accepter' }, field: 'checked', equals: true } });
  assert.equal(check.status, 'already-satisfied');
  assert.equal(state.checked, true);
  assert.equal(calls.length, 1);
});

test('a combo box choice must be proven by the combo box value, not by the option element', async t => {
  const { session, calls, state, observation } = await setup(t);
  await assert.rejects(session.act(observation, { kind: 'select', selector: formule, option: 'Bravo', expect: { selector: { name: 'Bravo' }, field: 'selected', equals: true } }),
    refusedBeforeInput(/proven by the combo box value.*"field":"value","equals":"Bravo"/));
  await assert.rejects(session.act(await session.observe(), { kind: 'click', selector: { name: 'Charlie', role: 'listitem' }, expect: { selector: { name: 'Charlie', role: 'listitem' }, field: 'selected', equals: true } }),
    refusedBeforeInput(/combo box value/));
  assert.equal(calls.length, 0);
  // Ouvrir la liste, choisir Bravo dans la liste ouverte, Valider : chaque effet prouvé, liste refermée.
  const batch = await session.actBatch(await session.observe(), [
    { kind: 'secondary', selector: formule, action: 'Expand', expect: { selector: formule, field: 'expanded', equals: true } },
    { kind: 'click', selector: { name: 'Bravo', role: 'listitem' }, expect: { selector: formule, field: 'value', equals: 'Bravo' } },
    { kind: 'click', selector: valider, expect: { selector: { automationId: 'resultat' }, field: 'value', equals: 'Formule=Bravo;Envois=1' } },
  ]);
  assert.equal(batch.status, 'completed');
  assert.deepEqual(batch.steps.map(s => s.status), ['verified', 'verified', 'verified']);
  assert.equal(state.sends, 1);
  assert.equal(batch.observation.elements.find(e => e.automationId === 'formule').expanded, false);
  // Valider de nouveau avec la même condition précise déjà vraie : rien n'est renvoyé.
  const again = await session.act(batch.observation, { kind: 'click', selector: valider, expect: { selector: { automationId: 'resultat' }, field: 'value', equals: 'Formule=Bravo;Envois=1' } });
  assert.equal(again.status, 'already-satisfied');
  assert.equal(state.sends, 1);
});

test('a transient popup (open drop-down list) is reported but never followed as a new window', async t => {
  const popup = { id: 77, ownerChain: [], enabled: true, z: 1, popup: true, className: 'HwndWrapper[Banc]' };
  let state;
  // La surgissante du même processus apparaît PENDANT l'action (liste ouverte) : sans la règle, elle serait suivie.
  const ctx = await setup(t, { related: async () => ({ ok: true, boundEnabled: true, windows: state?.expanded ? [popup] : [] }) });
  state = ctx.state;
  ctx.sky.windows.push({ id: 77, app: 'test!Banc', title: '' });
  const opened = await ctx.session.act(ctx.observation, { kind: 'secondary', selector: formule, action: 'Expand', expect: { selector: formule, field: 'expanded', equals: true } });
  assert.equal(opened.status, 'verified');
  assert.equal(opened.windowChange, null);
  assert.equal(opened.observation.window.id, 10);
  assert.deepEqual(opened.observation.windowStack, [10]);
  assert.deepEqual(opened.observation.popups, [{ id: 77, className: 'HwndWrapper[Banc]' }]);
  // Les contrôles de la fenêtre restent accessibles (le banc perdait tout : « found 0 »).
  const chosen = await ctx.session.act(opened.observation, { kind: 'click', selector: { name: 'Bravo', role: 'listitem' }, expect: { selector: formule, field: 'value', equals: 'Bravo' } });
  assert.equal(chosen.status, 'verified');
  assert.deepEqual(chosen.observation.popups, []);
});
test('expanded and collapsed states are parsed and usable as a postcondition field', () => {
  const tree = parseTree('0 window W\n\t1 combo box (expanded) A ID: a\n\t2 combo box (collapsed) B ID: b\n\t3 combo box C ID: c');
  assert.deepEqual(tree.slice(1).map(e => e.expanded), [true, false, null]);
  assert.equal(checkExpectation(tree, { selector: { automationId: 'a' }, field: 'expanded', equals: true }), true);
  assert.equal(checkExpectation(tree, { selector: { automationId: 'b' }, field: 'expanded', equals: false }), true);
  // Aucun état exposé : jamais une preuve de repli.
  assert.equal(checkExpectation(tree, { selector: { automationId: 'c' }, field: 'expanded', equals: false }), false);
  assert.ok(digest('x'));
});
