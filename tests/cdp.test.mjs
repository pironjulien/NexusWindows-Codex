// Molette au point (recettes A et B du banc commun du 21/10) : choix de la page DevTools, port prouvé au processus de la
// fenêtre, sens et extrémités du défilement, hors ligne, par le vrai helper (--cdp-selftest, --wheel-selftest) quand il
// est fourni (NEXUS_FOREGROUND_EXE). Aucune page ni fenêtre réelle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const executable = process.env.NEXUS_FOREGROUND_EXE;
const skip = !executable && 'NEXUS_FOREGROUND_EXE absent';
const run = (flag, input) => JSON.parse(execFileSync(executable, [flag], { input: JSON.stringify(input), windowsHide: true }).toString());
const pick = input => run('--cdp-selftest', input);
const page = (title, url) => ({ type: 'page', title, webSocketDebuggerUrl: url });
const ws = id => `ws://127.0.0.1:9222/devtools/page/${id}`;

test('DevTools page: decoded title, exact match up to the browser suffix, otherwise nothing is sent', { skip }, () => {
  const edge = 'Labo Web — zone gauche - Microsoft Edge';
  assert.equal(pick({ title: edge, targets: [page('Labo Web — zone gauche', ws('a')), page('Autre', ws('b'))] }).url, ws('a'));
  assert.equal(pick({ title: 'Labo - Personnel - Microsoft​ Edge', targets: [page('Labo', ws('a')), page('Autre', ws('b'))] }).url, ws('a'));
  // Edge à onglets avec profil, titre mesuré le 22/10 (preuve C) : tiret demi-cadratin avant « Microsoft Edge ».
  assert.equal(pick({ title: 'Labo Web — prêt - Profil 1 – Microsoft​ Edge', targets: [page('Labo Web — prêt', ws('a'))] }).url, ws('a'));
  // /json/list échappe les titres en HTML : « A &amp; B » est l'onglet « A & B », jamais « A » (relecture de Codex).
  const amp = 'A & B - Google Chrome';
  assert.equal(pick({ title: amp, targets: [page('A', ws('a')), page('A &amp; B', ws('ab'))] }).url, ws('ab'));
  assert.equal(pick({ title: 'x <y> "z" - Chromium', targets: [page('x &lt;y&gt; &quot;z&quot;', ws('q')), page('x', ws('x'))] }).url, ws('q'));
  // Un préfixe n'est pas une identité : « Labo » ne désigne pas la fenêtre « Labo Web - Microsoft Edge ».
  assert.match(pick({ title: 'Labo Web - Microsoft Edge', targets: [page('Labo', ws('a')), page('Autre', ws('b'))] }).error, /No single DevTools page/);
  // Homonymes (deux onglets au même titre, ou deux fenêtres) : ambigu, refus.
  assert.match(pick({ title: edge, targets: [page('Labo Web — zone gauche', ws('a')), page('Labo Web — zone gauche', ws('b'))] }).error, /2 matching/);
  // Une seule page au titre différent (Electron setTitle) n'est plus acceptée : la liaison n'est pas prouvée (2e relecture).
  assert.match(pick({ title: 'Mon appli', targets: [page('index', ws('e'))] }).error, /0 matching/);
  assert.match(pick({ title: 'x', targets: [] }).error, /0 pages/);
  // Le WebSocket de la page reste sur l'hôte et le port prouvés ; sinon refus.
  assert.match(pick({ title: 'Labo', targets: [page('Labo', 'ws://127.0.0.1:9333/devtools/page/z')] }).error, /proven host and port/);
  assert.match(pick({ title: 'Labo', targets: [page('Labo', 'ws://198.51.100.5:9222/devtools/page/z')] }).error, /proven host and port/);
  assert.equal(pick({ title: 'Labo', targets: [page('Labo', 'ws://localhost:9222/devtools/page/z')] }).url, ws('z'));
});

test('DevTools port: from the window process command line, and listened to by that process only', { skip }, () => {
  assert.equal(pick({ title: 'x', commandLine: 'msedge.exe --remote-debugging-port=9333 --x', targets: [] }).port, 9333);
  assert.equal(pick({ title: 'x', commandLine: 'electron.exe --remote-debugging-port 9227', targets: [] }).port, 9227);
  assert.equal(pick({ title: 'x', commandLine: 'chrome.exe --remote-debugging-port=0', targets: [] }).port, null);
  assert.equal(pick({ title: 'x', commandLine: 'chrome.exe --remote-debugging-pipe', targets: [] }).port, null);
  // L'adresse contactée (127.0.0.1, ou 0.0.0.0) doit être écoutée par le PID EXACT de la fenêtre, et par lui seul.
  const owned = listeners => pick({ title: 'x', targets: [], pid: 200, listeners }).owned;
  assert.equal(owned([{ address: '127.0.0.1', pid: 200 }]), true);
  assert.equal(owned([{ address: '0.0.0.0', pid: 200 }]), true);
  assert.equal(owned([{ address: '127.0.0.1', pid: 100 }]), false); // Electron B lancé avec le port de A
  assert.equal(owned([{ address: '127.0.0.1', pid: 300 }]), false); // enfant ou parent : plus d'exception (2e relecture)
  assert.equal(owned([{ address: '127.0.0.1', pid: 200 }, { address: '0.0.0.0', pid: 100 }]), false); // deux écoutes : ambigu
  assert.equal(owned([{ address: '192.0.2.5', pid: 200 }]), false); // adresse non contactée
  assert.equal(owned([]), false);
});

test('wheel at a point: only the vertical Windows sign is inverted, real ends only', { skip }, () => {
  const [down, up, right, left, nearEnd, nearStart, atEnd, none] = run('--wheel-selftest', [
    { deltaY: -120, deltaX: 0 }, { deltaY: 120, deltaX: 0 }, { deltaY: 0, deltaX: 120 }, { deltaY: 0, deltaX: -120 },
    { deltaY: -120, deltaX: 0, percent: 99.95 }, { deltaY: 120, deltaX: 0, percent: 0.05 }, { deltaY: -240, deltaX: 0, percent: 100 },
    { deltaY: 0, deltaX: 0 },
  ]);
  // Y- (cran vers le bas) : vers la fin ; DevTools deltaY positif = vers le bas.
  assert.deepEqual([down.vertical, down.forward, down.amount, down.cdpY], [true, true, 4, 120]);
  assert.deepEqual([up.forward, up.amount, up.cdpY], [false, 1, -120]);
  // X+ = vers la droite, pour UI Automation comme pour DevTools (seul le vertical s'inverse).
  assert.deepEqual([right.vertical, right.forward, right.amount, right.cdpX], [false, true, 4, 120]);
  assert.deepEqual([left.forward, left.amount, left.cdpX], [false, 1, -120]);
  // 99,95 % et 0,05 % ne sont pas des extrémités (il reste du contenu) ; 100 % l'est.
  assert.equal(nearEnd.atEnd, false);
  assert.equal(nearStart.atEnd, false);
  assert.deepEqual([atEnd.atEnd, atEnd.notches], [true, 2]);
  assert.match(none.error, /exactly one axis/);
});

test('scroll container under the point: smallest area, deepest when equal, otherwise ambiguous', { skip }, () => {
  const choose = input => run('--scroll-choice-selftest', input);
  assert.equal(choose({ count: 3, areas: [900, 400, 1600] }).index, 1);
  // Aires égales imbriquées (1 dans 0) : le descendant l'emporte, dans les deux ordres (2e relecture de Codex).
  assert.equal(choose({ count: 2, areas: [400, 400], parents: { 1: 0 } }).index, 1);
  assert.equal(choose({ count: 2, areas: [400, 400], parents: { 0: 1 } }).index, 0);
  assert.equal(choose({ count: 3, areas: [400, 400, 400], parents: { 1: 0, 2: 1 } }).index, 2);
  assert.match(choose({ count: 2, areas: [400, 400] }).error, /ambiguous/);
  assert.equal(choose({ count: 0, areas: [] }).index, -1);
  assert.match(choose({ count: 5001, areas: [1] }).error, /not exhaustive/);
});

test('rendered surface: exactly one visible surface in the window, the point on it, its size the proven page', { skip }, () => {
  const surface = input => run('--surface-selftest', input);
  const one = { surfaces: [[100, 100, 1700, 1100]], point: [500, 500], inner: [1280, 800], ratio: 1.25 };
  assert.deepEqual(surface(one), { index: 0, gap: [0, 0] });
  // Règle commune (relecture de Codex 19:18) : plusieurs zones visibles dans la fenêtre = refus, même si une seule est à
  // la taille de la page (grande page A sous une petite vue B visée).
  assert.match(surface({ ...one, surfaces: [[100, 100, 1700, 1100], [300, 300, 700, 600]] }).error, /2 visible rendered surfaces/);
  assert.match(surface({ ...one, point: [50, 50] }).error, /not on the rendered page/);
  // Taille physique = round(inner x DPR) à ceil(DPR) px près : 2 px d'écart à DPR 1,25 passent, 3 non.
  assert.deepEqual(surface({ ...one, surfaces: [[100, 100, 1702, 1098]] }).gap, [2, -2]);
  assert.match(surface({ ...one, surfaces: [[100, 100, 1703, 1100]] }).error, /gap 3\/0 px/);
  assert.match(surface({ ...one, inner: [0, 800] }).error, /unreadable/);
});

test('title proof: the pose is under the cleanup (pose applied, reply lost), conditional, and a failed cleanup is said', { skip }, () => {
  const prove = scenario => run('--prove-selftest', { scenario });
  assert.deepEqual(prove('nominal'), { ok: true, pageTitle: 'Labo' });
  // Pose appliquée puis réponse perdue (connexion cassée) : le titre d'origine est remis par une NOUVELLE connexion.
  const lost = prove('lost-pose');
  assert.equal(lost.pageTitle, 'Labo');
  assert.ok(lost.error);
  // Titre changé entre la lecture et la pose : rien n'est posé, le titre de la page est gardé.
  assert.deepEqual(prove('title-changed').pageTitle, 'Autre');
  // Les deux connexions perdues après la pose : refus qui le dit explicitement.
  assert.match(prove('dead').error, /cleanup failed on two connections/);
  assert.equal(prove('dead').kind, 'ActionRefusedException'); // terminal : aucune autre technique ne suit (preuve C)
  // Relecture de Codex du 22/10 11:27 : remise du titre de la FENÊTRE vérifiée sur tous les chemins ; script de remise
  // qui rend un objet d'erreur = nettoyage raté. Terminal dans les trois cas, aussi après le classement de Wheel.
  for (const scenario of ['hwnd-stuck', 'lost-pose-hwnd-stuck', 'restore-error-object']) {
    const r = prove(scenario);
    assert.equal(r.kind, 'ActionRefusedException', scenario);
    assert.equal(r.wheelKind, 'ActionRefusedException', scenario);
  }
  assert.match(prove('hwnd-stuck').error, /still shown in the window title/);
  // Pose perdue puis remise vérifiée : l'erreur d'origine remonte, classée « non applicable » (rien n'a été envoyé).
  assert.equal(lost.wheelKind, 'BackgroundNotApplicableException');
  assert.equal(prove('never-shown').pageTitle, 'Labo');
  // Page et fenêtre découplées (relecture de Codex 19:28) : un autre onglet affiché pendant le nettoyage fait échouer la
  // liaison (le titre FINAL de la page n'est plus celui de la fenêtre) ; un titre changé par la page elle-même est gardé.
  assert.match(prove('tab-switched').error, /binding changed/);
  assert.deepEqual(prove('page-retitled'), { ok: true, pageTitle: 'Nouveau' });
  // Habillage EXACT (relecture de Codex 19:36) : nonce vu sous « … - Google Chrome », puis l'onglet B « Labo - Personnel »
  // devant : « Labo - Personnel - Google Chrome » ne passe plus pour la page « Labo ».
  assert.match(prove('profile-confusion').error, /binding changed/);
});

test('fallback cleanup goes through the REAL connection factory: opened, evaluated, then closed', { skip }, () => {
  // Serveur WebSocket local minimal dans le helper ; la connexion principale est perdue, le secours doit nettoyer.
  const result = JSON.parse(execFileSync(executable, ['--session-selftest'], { input: '', windowsHide: true, timeout: 10000 }).toString());
  assert.equal(result.cleaned, true);
  assert.equal(result.received.length, 1);
  assert.match(result.received[0], /document\.title === "nexus-test"/);
});

test('DevTools wheel traces: acknowledgement lost after receipt is unknown and sent once; stop during preparation sends nothing', { skip }, async () => {
  // Traces D de la relecture de Codex du 22/10, par la vraie connexion contre un serveur DevTools local instrumenté ;
  // dossier d'arrêt de test (jamais le vrai ~/.nexus/stop).
  const { mkdtemp, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const home = await mkdtemp(path.join(os.tmpdir(), 'nexus-codex-wheel-'));
  try {
    const trace = scenario => JSON.parse(execFileSync(executable, ['--wheel-trace-selftest'], { input: JSON.stringify({ scenario }), windowsHide: true, timeout: 10000,
      env: { ...process.env, NEXUS_SHARED_HOME: home } }).toString());
    assert.deepEqual(trace('ack-lost'), { outcome: 'unknown', started: 1, dispatched: 1, evaluated: 1 });
    assert.deepEqual(trace('stop-during-prepare'), { outcome: 'stopped', started: 0, dispatched: 0, evaluated: 1 });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('a WinForms drop-down or context menu (tool window without caption) is a transient popup, listed in obs.popups', { skip }, () => {
  // Banc commun du 21/10 : le menu contextuel WinForms ouvert n'était ni suivi ni signalé (« found 0 » pour « Copier »).
  const WS_POPUP = 0x80000000, WS_CAPTION = 0x00C00000, NOACTIVATE = 0x08000000, TOOL = 0x80;
  const popup = cases => run('--popup-selftest', cases);
  assert.deepEqual(popup([
    { style: WS_POPUP, ex: TOOL, cls: 'WindowsForms10.Window.808.app.0.2bf8098_r6_ad1', menu: true, linked: true }, // ToolStripDropDown
    { style: WS_POPUP, ex: NOACTIVATE, cls: 'Popup' },
    { style: 0, ex: 0, cls: 'ComboLBox' },
    { style: WS_POPUP, ex: TOOL, cls: 'SomeOtherTool', menu: true, linked: true }, // fenêtre outil d'une autre technologie
    { style: (WS_POPUP | WS_CAPTION) >>> 0, ex: TOOL, cls: 'WindowsForms10.Window.8.app', menu: true, linked: true }, // boîte titrée
    { style: 0, ex: TOOL, cls: 'WindowsForms10.Window.8.app', menu: true, linked: true }, // pas une surgissante
    // Relecture de Codex du 22/10 : le style seul ne suffit pas, il faut le rôle menu ET le lien à la fenêtre suivie.
    { style: WS_POPUP, ex: TOOL, cls: 'WindowsForms10.Window.8.app', menu: false, linked: true }, // infobulle, palette…
    { style: WS_POPUP, ex: TOOL, cls: 'WindowsForms10.Window.8.app', menu: true, linked: false }, // menu d'une autre fenêtre
    // ContextMenuStrip mesuré le 22/10 : WS_EX_TOPMOST | WS_EX_CONTROLPARENT, sans WS_EX_TOOLWINDOW.
    { style: 0x96000000, ex: 0x10008, cls: 'WindowsForms10.Window.20808.app.0.38a021f_r13_ad1', menu: true, linked: true },
    { style: 0x96000000, ex: 0x10008, cls: 'WindowsForms10.Window.20808.app.0.38a021f_r13_ad1', menu: false, linked: true },
  ]), [true, true, true, false, false, false, false, false, true, false]);
});

test('menu path: each segment directly under the previous one, never through another menu item; ambiguous or unreadable refused', { skip }, () => {
  // Relecture de Codex du 22/10 (P1-3, P2-11) : « Fichier > Ouvrir » ne doit pas trouver « Fichier > Récents > Ouvrir ».
  const menu = input => run('--menu-selftest', input);
  const item = (id, name, children = [], extra = {}) => ({ id, role: 'menuitem', name, children, ...extra });
  const pane = (id, children) => ({ id, role: 'menu', name: '', children });
  const nested = [pane(0, [1]), item(1, 'Fichier', [2]), pane(2, [3]), item(3, 'Récents', [4]), pane(4, [5]), item(5, 'Ouvrir')];
  assert.match(menu({ nodes: nested, root: 0, path: [{ name: 'Fichier' }, { name: 'Ouvrir' }] }).error, /not found/);
  assert.deepEqual(menu({ nodes: nested, root: 0, path: [{ name: 'Fichier' }, { name: 'Récents' }, { name: 'Ouvrir' }] }), { id: 5 });
  // Sous un conteneur (volet, séparateur) : traversé ; deux homonymes au même niveau : refus, sauf identifiant distinct.
  const twins = [pane(0, [1]), item(1, 'Fichier', [2]), pane(2, [3, 4]), item(3, 'Ouvrir', [], { automationId: 'a' }), item(4, 'Ouvrir', [], { automationId: 'b' })];
  assert.match(menu({ nodes: twins, root: 0, path: [{ name: 'Fichier' }, { name: 'Ouvrir' }] }).error, /ambiguous/);
  assert.deepEqual(menu({ nodes: twins, root: 0, path: [{ name: 'Fichier' }, { name: 'Ouvrir', automationId: 'b' }] }), { id: 4 });
  // Lecture incomplète : enfants illisibles ou arbre trop grand, refus (jamais un « absent » trompeur).
  const unreadable = [pane(0, [1, 2]), { id: 1, role: 'pane', name: '', unreadable: true }, item(2, 'Fichier')];
  assert.match(menu({ nodes: unreadable, root: 0, path: [{ name: 'Fichier' }] }).error, /could not be read completely/);
  const wide = [pane(0, Array.from({ length: 2001 }, (_, i) => i + 1)), ...Array.from({ length: 2001 }, (_, i) => ({ id: i + 1, role: 'pane', name: '', children: [] }))];
  wide[1].children = [2002];
  wide.push(item(2002, 'Fichier'));
  assert.match(menu({ nodes: wide, root: 0, path: [{ name: 'Fichier' }] }).error, /too large/);
});

test('WinForms menu item click: path from the observed ancestry with automationId, required ancestor checked', { skip }, () => {
  // Relecture de Codex du 22/10 (P1-2) : le raccourci par nom seul perdait l'identifiant et le contexte du menu.
  const menu = input => run('--menu-selftest', input);
  const ancestry = [{ role: 'window', name: 'Banc' }, { role: 'menuitem', name: 'Fichier', automationId: 'fileMenu' }, { role: 'menu', name: '' }];
  assert.deepEqual(menu({ ancestry, selector: { role: 'menuitem', name: 'Ouvrir', automationId: 'openItem' } }).segments,
    [{ name: 'Fichier', automationId: 'fileMenu' }, { name: 'Ouvrir', automationId: 'openItem' }]);
  assert.deepEqual(menu({ ancestry, selector: { role: 'menuitem', name: 'Ouvrir', ancestor: { name: 'Fichier' } } }).segments,
    [{ name: 'Fichier', automationId: 'fileMenu' }, { name: 'Ouvrir', automationId: null }]);
  assert.match(menu({ ancestry, selector: { role: 'menuitem', name: 'Ouvrir', ancestor: { name: 'Édition' } } }).error, /required ancestor absent/);
  // Relecture de Codex du 22/10 07:59 : commande exigée dans le menu attesté par son HWND, jamais dans un autre menu.
  const opened = [{ role: 'window', name: 'Banc' }, { role: 'menu', name: '', nativeWindow: 300 }];
  assert.equal(menu({ ancestry: opened, selector: { role: 'menuitem', name: 'Copier', ancestor: { window: 300 } } }).segments.length, 1);
  assert.match(menu({ ancestry: opened, selector: { role: 'menuitem', name: 'Copier', ancestor: { window: 200 } } }).error, /required ancestor absent/);
});

test('context menu command: resolved in the open popup of its observed ancestry, otherwise in the window itself', { skip }, () => {
  // Plan de Codex du 22/10 : après UN clic droit, la surgissante liée (HWND lu) est la portée de la commande.
  const menu = input => run('--menu-selftest', input);
  const ancestry = [{ role: 'window', name: 'Banc', nativeWindow: 100 }, { role: 'menu', name: 'Menu contextuel', nativeWindow: 200 }];
  assert.deepEqual(menu({ scopeOf: 100, ancestry }), { scope: 200 });
  assert.deepEqual(menu({ scopeOf: 100, ancestry: [{ role: 'window', name: 'Banc', nativeWindow: 100 }, { role: 'menuitem', name: 'Fichier' }] }), { scope: 100 });
  assert.deepEqual(menu({ scopeOf: 100, ancestry: [] }), { scope: 100 });
});

test('collapse of a menu opened for the search is read back; still open or failing is an unknown outcome', { skip }, () => {
  // Relecture de Codex du 22/10 (P2-12).
  const [closed, open, throws] = run('--collapse-selftest', ['closed', 'open', 'throws']);
  assert.equal(closed, 'closed');
  assert.match(open, /still open; outcome unknown/);
  assert.match(throws, /could not be closed; outcome unknown: element gone/);
});

test('Chromium typing: exact comparison (only line endings normalized), bounded units that never split a surrogate pair', { skip }, () => {
  // Relecture de Codex du 22/10 (P2-7, P2-8).
  const chromium = input => run('--chromium-selftest', input);
  assert.equal(chromium({ same: ['Bonjour', 'Bonjour'] }), true);
  assert.equal(chromium({ same: ['a\r\nb', 'a\nb'] }), true);
  assert.equal(chromium({ same: ['bonjour', 'Bonjour'] }), false);
  assert.equal(chromium({ same: ['Bon  jour', 'Bon jour'] }), false);
  assert.equal(chromium({ same: ['Bonjour ', 'Bonjour'] }), false);
  const units = chromium({ units: 'abcdefg😀hij' });
  assert.equal(units.join(''), 'abcdefg😀hij');
  assert.ok(units.every(u => [...u].length <= 8 && !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(u)), JSON.stringify(units));
  assert.ok(units.length >= 2);
});
