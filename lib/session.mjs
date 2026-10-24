import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename, stat, unlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import { ApplicationMemory } from './memory.mjs';
import { parseTree, markCandidates, uniqueElement, findElements, structureHash, stateDigest, checkExpectation, validateExpectation, digest } from './tree.mjs';
import { emergencyStop } from './stop.mjs';
import { JulienActiveError, PresenceUnknownError, QUIET_MS, MAX_WAIT_MS } from './presence.mjs';
import * as gardeFous from './garde-fous.mjs';
import { journalLine, writeJournal } from './journal.mjs';

const coordinators = new WeakMap();
// Même fenêtre : même HWND, même application et, quand les deux le connaissent (fournisseur natif), même processus : un
// HWND recyclé par un autre processus n'est jamais pris pour l'ancien (relecture de Codex du 23/10).
const sameWindow = (a, b) => a.id === b.id && a.app === b.app && (a.pid === undefined || b.pid === undefined || a.pid === b.pid);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = value => structuredClone(value);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) freeze(v);
    Object.freeze(value);
  }
  return value;
}
function coordinator(sky) {
  if (!coordinators.has(sky)) coordinators.set(sky, { epoch: 0, busy: false });
  return coordinators.get(sky);
}
function targetIdentity(element, elements) {
  const key = e => [e.role, e.automationId, e.name, e.runtimeId ?? null];
  return [key(element), element.ancestors.map(i => key(elements.find(e => e.index === i)))];
}
// Erreur levée avant toute entrée : jamais un résultat inconnu, jamais rejouée.
const beforeInput = message => Object.assign(new Error(message), { beforeInput: true });

// ---- Postconditions : une condition déjà vraie ne vaut que si elle décrit l'effet de l'action ----
// Mesure du banc (16/10) : « le bouton existe » ou « l'option Bravo existe » (toujours vraies) faisaient passer un clic
// ou un Expand pour « already-satisfied » sans rien envoyer. Règle :
// 1. Refus d'une postcondition qui ne fait que redire la cible (existence de la cible, ou son nom déjà donné par le
//    sélecteur) : vraie avant l'action, elle ne prouve rien.
// 2. Déjà vraie AVANT l'action : « already-satisfied » (rien n'est envoyé) seulement pour un état précis (`equals`) que
//    l'action change — sur la cible, l'un des champs d'état (value, checked, selected, expanded, focused) ; ou sur un
//    autre élément. Sinon (`exists`, `includes`, libellé de la cible) refus avant toute entrée : la condition ne
//    distinguerait pas l'effet de l'état d'avant.
// 3. Choix dans une liste déroulante : prouvé par la valeur de la liste déroulante, jamais par l'élément d'option (exposé
//    seulement liste ouverte, ou toujours présent selon le fournisseur).
const STATE_FIELDS = new Set(['value', 'checked', 'selected', 'expanded', 'focused']);
const label = text => String(text ?? '').split(/\s+/).filter(Boolean).join(' ');
// `window` (menu attesté, ancêtre seulement) fait partie de la clé : deux menus distincts ne sont pas la même cible
// (relecture de Codex du 22/10 08:07).
const selectorKey = s => s && JSON.stringify(['role', 'name', 'automationId', 'window'].map(k => s[k] ?? null).concat([s.ancestor ? selectorKey(s.ancestor) : null]));
const actionTarget = spec => spec.kind === 'typeText' ? spec.focus : spec.selector;
const restatesTarget = (expect, target) => (expect.exists === true && expect.equals === undefined && expect.includes === undefined) ? 'its existence'
  : (expect.field ?? 'name') === 'name' && typeof target?.name === 'string' && (expect.equals === target.name || (expect.includes !== undefined && target.name.includes(expect.includes))) ? 'its own label'
  : null;
const TRIVIAL = what => `Postcondition only restates the target (${what}): it is already true before the action and proves nothing. ` +
  'Describe the effect: a state the action changes (field value, checked, selected, expanded or focused with equals) or another element (for example a result label)';
// Identité native transmise au helper : identité d'exécution de la cible, chaîne de ses ancêtres telle qu'observée (le
// helper ne relit que la cible et ses ancêtres, et refuse tout écart) et fenêtre propre éventuelle (accès direct).
function nativeIdentity(target, observation) {
  const ancestry = target.ancestors.map(i => observation.elements.find(e => e.index === i))
    .map(e => ({ role: e.role, automationId: e.automationId, name: e.name, runtimeId: e.runtimeId ?? [], ...(e.nativeWindow ? { nativeWindow: e.nativeWindow } : {}) }));
  return { runtimeId: target.runtimeId, ancestry, ...(target.nativeWindow ? { nativeWindow: target.nativeWindow } : {}) };
}
// Élément signalé hors champ (UIA IsOffscreen, drapeau « offscreen ») dont le rectangle ne recoupe pas celui de sa
// fenêtre (racine de l'arbre) : rien n'en est visible. Rectangles UIA : [x, y, largeur, hauteur].
function hiddenOffscreen(element, elements) {
  if (!element.flags?.includes('offscreen')) return false;
  const [x, y, w, h] = element.bounds ?? [];
  const [rx, ry, rw, rh] = elements[0]?.bounds ?? [];
  if (!(w > 0 && h > 0 && rw > 0 && rh > 0)) return true;
  return x >= rx + rw || y >= ry + rh || x + w <= rx || y + h <= ry;
}
function trivialPostcondition(spec) {
  const target = actionTarget(spec);
  if (!spec.expect || !target || selectorKey(spec.expect.selector) !== selectorKey(target)) return null;
  return restatesTarget(spec.expect, target);
}
// Découpe en graphèmes (jamais au milieu d'un emoji ou d'un caractère combiné), par tranches bornées.
export function textChunks(text, size = 48) {
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(s => s.segment);
  const chunks = [];
  for (let i = 0; i < graphemes.length; i += size) chunks.push(graphemes.slice(i, i + size).join(''));
  return chunks.length ? chunks : [''];
}

const CAPTURE_RETENTION_MS = 10 * 60 * 1000, CAPTURE_KEEP = 32, BATCH_MAX = 32;
const FRESH_MS = 162; // ≈ 1,618 × 100 ms : au-delà, l'état est relu avant l'entrée
const TYPE_CHUNK = 1; // frappe physique par graphème : l'arrêt d'urgence est contrôlé avant chacun
const PRESENCE_POLL_MS = 50, PRESENCE_POLLS = 33; // ≈ 1,618 s d'attente du retour du garde avant refus
// 'key' : touches et raccourcis Ctrl/Maj postés en Win32/WinForms (banc commun du 21/10) ; ailleurs, non applicable → Sky.
const BACKGROUND_KINDS = new Set(['click', 'setValue', 'typeText', 'secondary', 'select', 'menu', 'key']);
// Champ destinataire (À, Cc, Cci, To, Destinataire, numéro) : montré à part dans le résumé de l'accord.
const RECIPIENT_FIELD = /^((a|to|cc|cci|bcc)( recipients?| destinataires?)?|destinataires?|recipients?|e ?mail|courriel|adresse (e ?mail|electronique)|email address|tel|telephone|numero de telephone|phone( number)?|beneficiaire|iban)( |$)/;
const plainName = name => String(name).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^0-9a-z]+/g, ' ').trim();
const actionFields = {
  click: ['selector', 'point', 'screenshotId', 'button', 'count'],
  setValue: ['selector', 'value'], typeText: ['focus', 'text'], key: ['key'],
  secondary: ['selector', 'action'], scroll: ['point', 'screenshotId', 'scrollX', 'scrollY'],
  drag: ['from', 'to', 'screenshotId'],
  select: ['selector', 'option'], menu: ['path'],
};
// Capture native de l'observation désignée par son id : repère de coordonnées pour les gestes d'arrière-plan et pour la
// confirmation (screenPoints : origine écran du cadre).
function nativeShot(observation, id) {
  const image = (observation.images ?? []).find(i => i.id === id);
  if (!image?.frame) return undefined;
  // frame : zone que couvre l'image (points) ; windowFrame : cadre entier de la fenêtre (garde de mouvement du helper),
  // distincts pour une image zoomée (relecture de Codex du 24/10).
  return { id, width: image.width, height: image.height, originX: image.frame.left, originY: image.frame.top, frame: image.frame,
    windowFrame: image.windowFrame ?? image.frame, native: true };
}
function validateAction(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec) || !Object.hasOwn(actionFields, spec.kind)) throw new Error('Unsupported action');
  const allowed = ['kind', 'expect', 'timeoutMs', 'refresh', 'requiredStructureHash', 'requiredRevision', 'fallback', 'confirm', 'accord', ...actionFields[spec.kind]];
  if (Object.keys(spec).some(k => !allowed.includes(k))) throw new Error('Unexpected action field for ' + spec.kind);
  if (spec.expect !== undefined) validateExpectation(spec.expect);
  const trivial = trivialPostcondition(spec);
  if (trivial) throw beforeInput(TRIVIAL(trivial));
  if (spec.timeoutMs !== undefined && (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs < 0 || spec.timeoutMs > 15000)) throw new Error('timeoutMs must be between 0 and 15000');
  if (spec.refresh !== undefined && !['text', 'image', 'both'].includes(spec.refresh)) throw new Error('Invalid refresh mode');
  if (spec.fallback !== undefined && typeof spec.fallback !== 'boolean') throw new Error('fallback must be boolean');
  if (spec.confirm !== undefined && typeof spec.confirm !== 'boolean') throw new Error('confirm must be boolean');
  if (spec.accord !== undefined && (typeof spec.accord !== 'string' || !/^[0-9a-f]{8}$/i.test(spec.accord.trim()))) throw new Error('accord must be the 8-character token returned by the refusal');
  for (const key of ['point', 'from', 'to']) {
    const p = spec[key];
    if (p !== undefined && (!p || typeof p !== 'object' || Array.isArray(p) ||
        Object.keys(p).some(k => k !== 'x' && k !== 'y') || !Number.isFinite(p.x) || !Number.isFinite(p.y))) {
      throw new Error('A coordinate point must contain only finite x and y');
    }
  }
  if (spec.kind === 'click') {
    if (spec.button !== undefined && !['left', 'right', 'middle'].includes(spec.button)) throw new Error('Invalid mouse button');
    if (spec.count !== undefined && ![1, 2].includes(spec.count)) throw new Error('click count must be 1 or 2');
    if (spec.screenshotId !== undefined && spec.point === undefined) throw new Error('A screenshotId requires a coordinate point');
  }
  if (spec.kind === 'setValue' && typeof spec.value !== 'string') throw new Error('value must be a string');
  if (spec.kind === 'typeText' && typeof spec.text !== 'string') throw new Error('text must be a string');
  if (spec.kind === 'select' && (typeof spec.option !== 'string' || !spec.option.trim())) throw new Error('option must be a nonempty string');
  if (spec.kind === 'menu' && (typeof spec.path !== 'string' || spec.path.split('>').some(s => !s.trim()))) throw new Error('menu path must look like "File > Save"');
  if (spec.kind === 'key') {
    if (typeof spec.key !== 'string' || !spec.key.trim().length) throw new Error('key must be a nonempty chord');
    if (spec.key.split('+').some(k => /^(?:win|windows|meta|super|cmd|command|os)(?:_[lr])?$/i.test(k.trim()))) {
      throw new Error('Windows-key chords are unsupported by the installed Computer Use skill');
    }
  }
  if (spec.kind === 'scroll' && ![spec.scrollX ?? 0, spec.scrollY ?? 0].every(Number.isFinite)) throw new Error('Invalid scroll delta');
}

export class WindowsSession {
  #sky; #coordinator; #window; #observation; #busy = false; #results = new WeakMap();
  #memory; #root; #metrics = []; #sessionId = randomUUID(); #native; #nativePreferred = false; #stop;
  #stack = []; #seen = new Set(); #pause; #popups = []; #interaction = null; #actLease; #batchLease; #tokenHeld = null; #nativeShots = 0; #openedSettings = null;
  constructor(sky, { stateRoot, maxAgeMs = 30000, native, emergencyStop: stop = emergencyStop(), pause = {} } = {}) {
    if (sky?.target !== 'windows') throw new Error('The supported Windows Sky API is required');
    if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0 || maxAgeMs > 60000) throw new Error('maxAgeMs must be between 1 and 60000');
    this.#sky = sky; this.#coordinator = coordinator(sky); this.maxAgeMs = maxAgeMs;
    this.#root = stateRoot; this.#memory = stateRoot ? new ApplicationMemory(stateRoot) : null; this.#native = native;
    // Après une action d'arrière-plan, l'arbre renvoyé par Sky peut encore décrire l'ancien état.
    // Lire UIA dès le départ quand il est disponible ; backend:'sky' reste un choix explicite et persistant.
    this.#nativePreferred = Boolean(native?.inspect);
    this.#stop = stop;
    this.#pause = { quietMs: pause.quietMs ?? QUIET_MS, maxWaitMs: pause.maxWaitMs ?? MAX_WAIT_MS, ...(pause.sleep ? { sleep: pause.sleep } : {}) };
  }
  // Arrêt d'urgence de Julien : point de contrôle avant toute action de bureau. Un refus consomme l'observation
  // (rien n'est rejoué ensuite) ; les observations restent permises.
  #assertNotStopped() {
    try { this.#stop.assertClear(); }
    catch (error) { this.#invalidate(); throw error; }
  }
  emergencyStopStatus() { return this.#stop.status(); }
  presenceStatus() { return this.#stop.presence?.status() ?? { source: 'none', available: false, idleMs: null }; }
  async #exclusive(fn) {
    if (this.#busy || this.#coordinator.busy) throw new Error('Another Windows operation is running; serialize desktop interaction');
    this.#busy = this.#coordinator.busy = true;
    try { return await fn(); } finally { this.#busy = this.#coordinator.busy = false; this.#actLease = undefined; }
  }
  #invalidate() { this.#observation = null; this.#coordinator.epoch++; }
  async windows() { return this.#exclusive(() => this.#sky.list_windows()); }
  // Ouvre une page des Paramètres (« ms-settings:display ») par le helper, sans Sky (son lancement refuse les adresses,
  // passe 2 du 22/10). Rend la fenêtre Sky à lier (`bind`), relue dans l'inventaire de Sky ; jamais liée d'office.
  async openSettings(uri) {
    return this.#working(() => this.#exclusive(async () => {
      this.#assertNotStopped();
      this.#openedSettings = null; // une ouverture précédente n'est jamais liable après une nouvelle demande
      if (this.#interaction) throw beforeInput('End the foreground interaction before opening Settings');
      if (!/^ms-settings:[A-Za-z0-9-]*$/.test(String(uri))) throw Object.assign(new Error('Only ms-settings: pages can be opened'), { refused: true, beforeInput: true });
      if (!this.#native?.openSettings) throw new Error('openSettings needs the native helper');
      gardeFous.load(); // politique commune illisible : refus avant tout lancement (le helper la relit aussi)
      this.#invalidate(); // la page peut changer la fenêtre liée : toute observation antérieure est périmée
      // Prise brève du premier plan : même règle qu'une entrée physique (pause de Julien) ; le helper prend lui-même le
      // jeton commun et rend la fenêtre de Julien.
      const reply = (await this.#physicalInput('open Settings page', presence =>
        this.#native.openSettings(uri, presence?.available ? { quietMs: this.#pause.quietMs } : {}), { token: false })).value;
      if (!reply?.window) return { status: 'unknown', reason: 'No Settings window found within 5 s; list windows before deciding' };
      const listed = (await this.#sky.list_windows()).find(w => w.id === reply.window) ?? null;
      // Ouverte masquée (lancement d'arrière-plan, mesure du 23/10) : Sky ne la liste pas ; seule CETTE fenêtre peut
      // être liée par bindOpenedSettings(), lue et pilotée par le helper seul. Jamais une fenêtre masquée quelconque.
      this.#openedSettings = listed ? null : { id: reply.window, app: reply.app, pid: reply.pid, title: reply.title ?? '' };
      return { status: 'opened', window: listed, hidden: reply.hidden === true, bindable: listed ? 'bind' : 'bindOpenedSettings',
        nativeWindow: reply.window, title: reply.title ?? null, foregroundReturned: reply.foregroundReturned ?? null };
    }));
  }
  // Fenêtre liée de l'Explorateur menée à un dossier (chemin absolu existant) par le shell, en arrière-plan : ni Ctrl+L
  // ni barre d'adresse (passe 2 du 22/10 : sans focus en arrière-plan, saisie perdue au premier plan rendu). Fenêtre à
  // un seul onglet seulement. Arrivée relue ; observer ensuite.
  async openFolder(path) {
    return this.#working(() => this.#exclusive(async () => {
      this.#assertNotStopped();
      if (!this.#window) throw new Error('Bind an Explorer window first');
      if (!this.#native?.call) throw new Error('openFolder needs the native helper');
      this.#invalidate(); // le contenu de la fenêtre va changer : observations antérieures périmées
      const reply = await this.#native.call(this.#window, 'navigateFolder', { path: String(path) });
      return { status: reply.effect === 'verified' || reply.effect === 'already' ? 'verified' : 'unknown', effect: reply.effect, path: reply.path ?? null };
    }));
  }
  // Lancement par le helper, sans Sky (serveur MCP) : application (nom, chemin, AUMID), dossier ou document, sous le
  // jeton commun, premier plan rendu à chaque prise ; une page ms-settings: passe par openSettings. Rend les nouvelles
  // fenêtres d'application, jamais liées d'office.
  async launch(target) {
    if (/^ms-settings:/i.test(String(target).trim())) return this.openSettings(String(target).trim());
    return this.#working(() => this.#exclusive(async () => {
      this.#assertNotStopped();
      if (this.#interaction) throw beforeInput('End the foreground interaction before launching');
      if (!this.#native?.launch) throw new Error('launch needs the native helper');
      gardeFous.load(); // politique commune illisible : refus avant tout lancement (le helper la relit aussi)
      this.#invalidate(); // le lancement peut changer la fenêtre liée (document ouvert dedans) : observation périmée
      const start = Date.now();
      const reply = (await this.#physicalInput('launch an application', presence =>
        this.#native.launch(String(target), presence?.available ? { quietMs: this.#pause.quietMs } : {}), { token: false })).value;
      const opened = reply?.opened === true;
      this.#record('launch', opened ? 'verified' : 'unknown', Date.now() - start, 'shell', true);
      const candidates = reply?.candidates ?? [];
      return { status: opened ? 'opened' : 'unknown', windows: reply?.windows ?? [], candidates, foregroundReturned: reply?.foregroundReturned ?? null,
        ...(opened ? {} : { reason: candidates.length
          ? 'New windows appeared but none is attested as this launch (process, executable or document name); look before deciding, never launch again blindly'
          : 'No new application window within 15 s; list windows before deciding, never launch again blindly' }) };
    }));
  }
  // Fermeture de la fenêtre liée : WM_CLOSE posté une fois par le helper (jamais rejoué), relu 3 s. Encore ouverte avec
  // une fenêtre possédée (enregistrer ?) : à regarder avant de décider.
  async closeWindow() {
    return this.#working(() => this.#exclusive(async () => {
      this.#assertNotStopped();
      if (!this.#window) throw new Error('Bind a window first');
      if (this.#interaction) throw beforeInput('End the foreground interaction before closing');
      const start = Date.now();
      this.#invalidate();
      const reply = await this.#native.call(this.#window, 'close');
      const status = reply.state === 'closed' ? 'verified' : reply.state === 'hidden' ? 'sent-unconfirmed' : (reply.prompts ?? []).length ? 'prompted' : 'unmet';
      this.#record('close', status, Date.now() - start, 'background:messages', false);
      if (reply.state === 'closed') { this.#window = null; this.#stack = []; }
      return { status, state: reply.state, prompts: reply.prompts ?? [] };
    }));
  }
  // Retour à la fenêtre liée elle-même (racine de la pile), sans nouvel inventaire : les dialogues suivis depuis sont
  // retirés de la pile. Pour une racine que l'inventaire ne liste pas (Paramètres ouverts masqués), son identité est
  // relue par le helper.
  async returnToRoot(id) {
    return this.#exclusive(async () => {
      if (this.#interaction) throw beforeInput('End the foreground interaction before binding another window');
      const root = this.#stack[0];
      if (!root || root.id !== id) throw new Error('This window is no longer bound; list windows');
      if (root.nativeOnly && (await this.#native.alive(root)).state !== 'alive') throw new Error('Window identity changed; bind it again');
      this.#invalidate(); this.#stack = [root]; this.#window = root;
      await this.#markSeen();
      return clone(root);
    });
  }
  async bindOpenedSettings() {
    return this.#exclusive(async () => {
      if (this.#interaction) throw beforeInput('End the foreground interaction before binding another window');
      const opened = this.#openedSettings;
      if (!opened?.id || !opened.app || !Number.isInteger(opened.pid)) throw new Error('No hidden Settings window opened by openSettings in this session');
      const win = { id: opened.id, app: opened.app, title: opened.title, nativeOnly: true, pid: opened.pid };
      if ((await this.#native.alive(win)).state !== 'alive') throw new Error('The opened Settings window is gone; open it again');
      this.#invalidate(); this.#seen.clear(); this.#popups = []; this.#nativePreferred = true;
      this.#window = win; this.#stack = [win]; this.#openedSettings = null;
      await this.#markSeen();
      return clone(win);
    });
  }
  // Toute prise du premier plan (entrée physique Sky, activation, set_value et action secondaire de Sky) passe ici, sous
  // le jeton commun. Le helper note la fenêtre active de Julien dès le jeton pris et la lui rend sous le jeton si la
  // fenêtre cible tient encore le premier plan à la fin ; `report.foregroundReturned` reçoit l'état rapporté.
  async #foreground(purpose, action, report = {}, keep = undefined) {
    if (!this.#native?.withForeground) throw Object.assign(new Error('Foreground token helper is required; action deferred'), { deferred: true });
    this.#assertNotStopped();
    const interaction = this.#interaction;
    if (interaction?.active) {
      if (interaction.reason) throw beforeInput('Foreground interaction ended: ' + interaction.reason);
      if (this.#window?.app !== interaction.window.app) throw beforeInput('Foreground interaction belongs to another application');
      interaction.running++;
      this.#tokenHeld = interaction.held ?? null;
      try {
        const value = await action();
        // Helper du bail perdu pendant l'action : une entrée a pu partir sans jeton ; inconnu dès cette action, pas
        // seulement à la fin de l'interaction (relecture de Codex, 21/10).
        if (interaction.held?.() === false) {
          interaction.finish?.('token-lost');
          throw new Error('Foreground token lost during the action; outcome unknown, do not replay');
        }
        return value;
      } finally {
        this.#tokenHeld = null;
        interaction.running--;
        if (interaction.reason && !interaction.running) interaction.release();
        report.foregroundReturned = 'interaction-held';
      }
    }
    // Le jeton peut attendre jusqu'à 8 s : contrôle de nouveau une fois acquis, juste avant l'entrée.
    try {
      return await this.#native.withForeground(purpose, lease => { this.#assertNotStopped(); this.#tokenHeld = lease?.held ?? null; return action(); },
        { window: this.#window, keep, onRelease: state => { report.foregroundReturned = state ?? null; } });
    } finally { this.#tokenHeld = null; }
  }
  // Menus transitoires et canvas : conserver le même bail pendant une courte
  // séquence observe -> agir -> observer. Jamais de bail sans limite, ni de
  // verrou réentrant partagé avec un autre objet/session.
  async beginInteraction({ durationMs = 30000 } = {}) {
    return this.#exclusive(async () => {
      if (!this.#window) throw beforeInput('Bind a window first');
      if (this.#interaction) throw beforeInput('End the current foreground interaction first');
      if (!Number.isSafeInteger(durationMs) || durationMs < 100 || durationMs > 30000) throw beforeInput('durationMs must be between 100 and 30000');
      if (!this.#native?.withForeground) throw beforeInput('Foreground token helper is required');
      this.#assertNotStopped();
      const presence = this.#stop.presence;
      await this.#knownPresence(presence);
      if (presence?.available) await presence.waitForPause(this.#pause);
      const interaction = { window: clone(this.#window), active: false, running: 0, reason: null, giveBack: null, release: null, done: null };
      let ready, failed;
      const observation = new Promise((resolve, reject) => { ready = resolve; failed = reject; });
      const released = new Promise(resolve => { interaction.release = resolve; });
      const finish = reason => {
        interaction.reason ??= reason;
        this.#invalidate();
        if (!interaction.running) interaction.release();
      };
      interaction.finish = finish;
      this.#interaction = interaction;
      interaction.done = this.#native.withForeground('interactive observation and input', async lease => {
        interaction.held = lease?.held ?? null;
        this.#assertNotStopped();
        if (presence?.available && presence.idleMs() < this.#pause.quietMs) throw new JulienActiveError(presence.idleMs());
        const began = presence?.now?.() ?? 0;
        interaction.began = began;
        // Mise au premier plan par le helper lui-même (sans Sky) quand il est là ; Sky en secours.
        let activated = false;
        if (this.#nativeInput()) {
          try { await this.#native.call(interaction.window, 'activate'); activated = true; } catch (error) { if (!error.notApplicable) throw error; }
        }
        if (!activated && interaction.window.nativeOnly) throw beforeInput('The helper cannot bring this window forward and Sky does not list it');
        if (!activated) await this.#sky.activate_window({ window: interaction.window });
        this.#assertNotStopped();
        interaction.active = true;
        const timer = setTimeout(() => finish('timeout'), durationMs);
        const guard = setInterval(() => {
          try {
            this.#assertNotStopped();
            if (presence?.available && presence.since(began)) finish('julien-active');
            else if (this.#stop.guardExpected && !presence?.available) finish('presence-unknown');
          } catch { finish('emergency-stop'); }
        }, PRESENCE_POLL_MS);
        try {
          ready(await this.#capture('both'));
          await released;
        } finally { clearTimeout(timer); clearInterval(guard); interaction.active = false; }
      }, { window: interaction.window,
        // Julien a touché clavier ou souris depuis le début du bail (présence, injections exclues), quelle que soit la
        // raison de clôture : son choix est gardé (relecture de Codex, 21/10 : fin avant le contrôle périodique).
        keep: () => interaction.reason === 'julien-active' || Boolean(presence?.available && interaction.began != null && presence.since(interaction.began)),
        onRelease: state => { interaction.giveBack = state ?? null; } })
        .catch(error => { failed(error); interaction.error = error; })
        .finally(() => { this.#invalidate(); if (this.#interaction === interaction) this.#interaction = null; });
      return observation;
    });
  }
  async endInteraction() {
    return this.#exclusive(async () => {
      const interaction = this.#interaction;
      if (!interaction) return { status: 'inactive' };
      interaction.reason ??= 'ended';interaction.release();
      await interaction.done;
      if (interaction.error) throw interaction.error;
      return { status: interaction.reason, foregroundReturned: interaction.giveBack };
    });
  }
  async close() {
    await this.endInteraction();
    await this.pruneCaptures();
    return this.#exclusive(() => { this.#invalidate(); this.#window = null; this.#stack = []; this.#seen.clear(); this.#openedSettings = null; this.#native?.close?.(); });
  }
  // Captures natives : 32 au plus, 10 minutes au plus ; purgées à chaque capture, au démarrage du serveur et à son arrêt
  // propre (relecture de Codex du 23/10 : sans cela, les dernières images restaient après l'arrêt).
  async pruneCaptures() { if (this.#root) await this.#pruneCaptures(path.join(this.#root, 'captures')); }
  // Logo « agent au travail » pendant une action (jamais pendant une simple observation) ; sur l'écran de la fenêtre liée.
  async #working(fn) {
    const stop = this.#stop;
    if (typeof stop.busy !== 'function') return fn();
    stop.busy(Number(this.#window?.id));
    try { return await fn(); } finally { stop.idle(); }
  }
  async activate() {
    return this.#working(() => this.#exclusive(async () => {
      this.#invalidate();
      if (!this.#window) throw new Error('Bind a window first');
      this.#assertNotStopped();
      // Activation = prise du premier plan : même règle qu'une entrée physique (pause de Julien, jeton, fenêtre rendue).
      const result = await this.#physicalInput('activate_window', async () => {
        if (this.#window.nativeOnly) await this.#native.call(this.#window, 'activate');
        else await this.#sky.activate_window({ window: this.#window });
        // Capturer avant de rendre le premier plan : sinon les pixels peuvent
        // montrer l'application de Julien qui vient justement d'etre restauree.
        return this.#capture('both');
      });
      return result.value;
    }));
  }
  async bind({ id, app, title } = {}) {
    return this.#exclusive(async () => {
      if (this.#interaction) throw beforeInput('End the foreground interaction before binding another window');
      this.#invalidate(); this.#window = null; this.#stack = []; this.#seen.clear(); this.#nativePreferred = Boolean(this.#native?.inspect); this.#popups = [];
      if (id === undefined && app === undefined && title === undefined) throw new Error('Specify a returned window id, exact app or exact title');
      const found = (await this.#sky.list_windows()).filter(w =>
        (id === undefined || id === w.id) && (app === undefined || app === w.app) && (title === undefined || title === w.title));
      if (found.length !== 1) throw new Error(`Window selection must be unique; found ${found.length}`);
      const win = await this.#sky.get_window({ id: found[0].id, app: found[0].app });
      if (!sameWindow(win, found[0])) throw new Error('Window identity changed during selection');
      this.#window = win; this.#stack = [win];
      await this.#markSeen(); // les fenêtres liées déjà ouvertes ne sont pas suivies d'office
      return clone(win);
    });
  }

  // ---- Fenêtres liées : dialogues et surgissantes possédés, ou du même processus apparus pendant l'action ----
  async #related() {
    if (!this.#native?.related || !this.#stack.length) return null;
    try { return await this.#native.related(this.#stack[0]); } catch { return null; }
  }
  async #markSeen() {
    const info = await this.#related();
    for (const w of info?.windows ?? []) this.#seen.add(w.id);
  }
  async #follow(inAction) {
    const info = await this.#related();
    if (!info) return null;
    const open = new Set(info.windows.map(w => w.id));
    let change = null;
    while (this.#stack.length > 1 && !open.has(this.#stack.at(-1).id)) {
      // Absente de la liste VISIBLE : dépilée seulement si le helper atteste sa disparition (gone|other) ; masquée mais
      // vivante, ou existence illisible : gardée (relecture de Codex). Sans lecture d'existence : comportement d'avant.
      if (this.#native?.alive) {
        let state = null;
        try { state = (await this.#native.alive(this.#stack.at(-1))).state; } catch { /* inconnu : gardée */ }
        if (state !== 'gone' && state !== 'other') break;
      }
      const closed = this.#stack.pop();
      change = { reason: 'closed', from: closed.id, to: this.#stack.at(-1).id };
    }
    // Fenêtres attestées par le helper : même processus et même propriétaire qu'à leur adoption, relus à chaque suivi.
    for (const [i, w] of this.#stack.entries()) {
      if (!w.nativeOnly) continue;
      const seen = info.windows.find(x => x.id === w.id);
      // Propriétaire DIRECT attesté (GW_OWNER, aussi imposé au helper) et ancre suivie (fenêtre de la pile dans la
      // chaîne), gardés séparément : un propriétaire intermédiaire non suivi ou une fenêtre sœur restent valides
      // (relecture de Codex).
      const anchored = this.#stack.slice(0, i).some(s => s.id === w.anchor);
      // Sans propriétaire (fenêtre du même processus apparue pendant l'action, fournisseur natif) : le processus seul.
      const ownerChanged = w.owner !== undefined && (seen?.ownerChain[0] !== w.owner || !seen?.ownerChain.includes(w.anchor) || !anchored);
      if (seen && (seen.pid !== w.pid || ownerChanged)) {
        throw new Error('Window identity changed (process or owner); bind it again');
      }
    }
    const inStack = new Set(this.#stack.map(w => w.id));
    const top = this.#stack.at(-1);
    const topEnabled = top === this.#stack[0] ? info.boundEnabled !== false : info.windows.find(w => w.id === top.id)?.enabled !== false;
    // Surgissantes transitoires (liste déroulante ouverte, infobulle, surgissante WPF : sans barre de titre et non
    // activables) : parties de la fenêtre suivie, lues par son arbre ; jamais suivies comme une nouvelle fenêtre (le
    // banc du 16/10 perdait ainsi tous les contrôles de la fenêtre WPF : « found 0 »). Signalées dans `obs.popups`.
    this.#popups = info.windows.filter(w => w.popup).map(w => ({ id: w.id, className: w.className ?? null }));
    const candidates = info.windows.filter(w => !inStack.has(w.id) && !w.popup && (
      // Possédée par une fenêtre suivie : nouvelle, ou fenêtre active désactivée par ce dialogue (modal).
      (w.ownerChain.some(o => inStack.has(o)) && (!this.#seen.has(w.id) || (!topEnabled && w.enabled))) ||
      // Même processus, sans propriétaire, apparue pendant l'action.
      (inAction && w.ownerChain.length === 0 && !this.#seen.has(w.id))))
      .sort((a, b) => a.z - b.z);
    for (const w of info.windows) this.#seen.add(w.id);
    for (const next of candidates) {
      const listed = (await this.#sky.list_windows()).find(s => s.id === next.id && s.app === this.#stack[0].app);
      let win = null;
      if (listed) {
        win = await this.#sky.get_window({ id: listed.id, app: listed.app });
        if (!sameWindow(win, listed)) continue;
        // Fournisseur natif (serveur MCP sans Sky) : la fenêtre listée est pilotée par le helper seul ; elle garde
        // son processus, son propriétaire et son ancre comme une fenêtre attestée, sinon le suivi suivant la rejette
        // alors que son identité n'a pas changé (relecture de Codex du 23/10).
        if (win.nativeOnly) {
          if (next.pid !== win.pid) continue;
          win = { ...win, pid: next.pid, owner: next.ownerChain[0], anchor: next.ownerChain.find(o => inStack.has(o)) };
        }
      } else {
        // Absente de Sky (boîtes Ouvrir/Enregistrer sous du Bloc-notes WinUI et de Paint, passe 2 du 22/10) : suivie
        // seulement si le helper l'atteste POSSÉDÉE par une fenêtre suivie ET du MÊME processus que la fenêtre liée ;
        // lue, capturée et pilotée ensuite par le helper seul, jamais par Sky (diagnostic de Codex).
        const owned = next.ownerChain.some(o => inStack.has(o));
        if (!owned || !Number.isInteger(info.boundPid) || next.pid !== info.boundPid || !this.#native?.inspect || !this.#native?.alive) continue;
        // pid et propriétaire gardés : relus à chaque suivi et imposés au helper à chaque requête (expectedPid/Owner).
        const anchor = next.ownerChain.find(o => inStack.has(o));
        win = { id: next.id, app: this.#stack[0].app, title: next.title ?? '', nativeOnly: true, pid: next.pid, owner: next.ownerChain[0], anchor };
      }
      this.#stack.push(win);
      change = { reason: 'opened', from: top.id, to: win.id, owned: next.ownerChain.length > 0 };
      break;
    }
    this.#window = this.#stack.at(-1);
    return change;
  }

  async #getRevision(app) {
    if (!app.startsWith('process:')) return null; // Store app ids do not expose a binary version.
    try {
      const info = await stat(app.slice('process:'.length));
      return digest(`${info.size}:${info.mtimeMs}`);
    } catch (e) {
      if (['ENOENT', 'EACCES', 'EPERM'].includes(e.code)) return null;
      throw e;
    }
  }
  async #pruneCaptures(directory) {
    let files;
    try { files = (await readdir(directory)).filter(f => f.endsWith('.png') || f.endsWith('.webp')); } catch { return; }
    const dated = [];
    for (const name of files) {
      try { dated.push({ file: path.join(directory, name), at: (await stat(path.join(directory, name))).mtimeMs }); } catch { /* déjà retiré */ }
    }
    dated.sort((a, b) => b.at - a.at);
    const now = Date.now();
    for (const [i, entry] of dated.entries()) {
      if (i >= CAPTURE_KEEP || now - entry.at > CAPTURE_RETENTION_MS) await unlink(entry.file).catch(() => {});
    }
  }
  async #capture(mode, backend = 'auto', { capture = 'sky', windowChange = null, zoom = null, marks = 'none' } = {}) {
    this.#invalidate();
    if (!this.#window) throw new Error('Bind a returned window before observing');
    if (!['text', 'image', 'both'].includes(mode)) throw new Error('mode must be text, image or both');
    if (!['auto', 'sky', 'native'].includes(backend)) throw new Error('backend must be auto, sky or native');
    if (!['sky', 'native'].includes(capture)) throw new Error('capture must be sky or native');
    if (!['none', 'auto', 'all'].includes(marks)) throw new Error('marks must be none, auto or all');
    if (backend === 'native' && !this.#native) throw new Error('Native UIA is not configured');
    const nativeOnly = this.#window.nativeOnly === true;
    if (nativeOnly) {
      if (backend === 'sky') throw new Error('Sky does not list this window: observe it with the native backend');
      if ((await this.#native.alive(this.#window)).state !== 'alive') throw new Error('Window identity changed; bind it again');
      if (mode !== 'text') capture = 'native'; // aucune image Sky pour une fenêtre que Sky ne liste pas
    }
    const current = nativeOnly ? this.#window : await this.#sky.get_window({ id: this.#window.id, app: this.#window.app });
    if (!sameWindow(current, this.#window)) throw new Error('Window identity changed; bind it again');
    const useNative = nativeOnly || backend === 'native' || (backend === 'auto' && this.#nativePreferred);
    // Capture propre (PrintWindow, fenêtre recouverte, sans premier plan) ; image vide ou échec : capture Sky.
    // Numéros [N] (shared/images.md point 5, avis de Codex du 24/10) : arbre natif lu AVANT la capture, une seule fois et
    // sous le même verrou ; ses index et rectangles vont au helper, qui ne les dessine que si le cadre de la fenêtre est
    // resté celui de la lecture. L'âge de l'observation part du début de cette lecture (FRESH_MS).
    let marksNote = null, preread = null, treeStartedAt = null, candidates = null;
    if (marks !== 'none') {
      if (mode !== 'both') marksNote = 'numbers need mode both (tree and image together): none drawn';
      else if (capture !== 'native' || !useNative || !this.#native?.inspect || !this.#native?.capture || !this.#root) marksNote = 'numbers need the native tree and capture: none drawn';
      else { treeStartedAt = Date.now(); preread = await this.#native.inspect(current); }
    }
    let images = [], imageFallback = null;
    if (capture === 'native' && mode !== 'text') {
      if (!this.#native?.capture || !this.#root) imageFallback = 'Native capture is not configured';
      else {
        const directory = path.join(this.#root, 'captures');
        try {
          const shot = await this.#native.capture(current, directory, zoom,
            preread ? { marks: (candidates = markCandidates(preread.elements, marks)), treeFrame: preread.frame ?? null } : null);
          if (shot.blank) imageFallback = 'PrintWindow returned a uniform (blank) image';
          // id : repère de coordonnées natif (banc commun du 21/10, plan de Codex étape 5), distinct des captures Sky ;
          // un point de cette image vise l'écran à frame.left + x * frame.width / width (image réduite au plus à
          // 1568 px et 1,15 Mpx, règle commune des produits Nexus : nativeScreen).
          else images = [{ id: `native-${++this.#nativeShots}`, path: shot.path, width: shot.width, height: shot.height, method: shot.method, scale: shot.scale, ms: shot.ms, frame: shot.frame, windowFrame: shot.windowFrame ?? shot.frame, ...(zoom ? { zoom: true } : {}), ...(preread ? { marks: { ...(shot.marks ?? { reason: 'the helper drew no numbers' }), ...(candidates?.capped ? { capped: candidates.capped } : {}) } } : {}) }];
        } catch (error) { imageFallback = error.message; }
        await this.#pruneCaptures(directory);
      }
    }
    if (preread && !images.length) marksNote = 'no native image: none drawn';
    const skyText = mode !== 'image' && !useNative;
    const skyImage = mode !== 'text' && !images.length && !nativeOnly;
    const state = !skyText && !skyImage
      ? { window: current, accessibility: null, screenshots: [] }
      : await this.#sky.get_window_state({ window: current, include_text: skyText, include_screenshot: skyImage });
    if (!sameWindow(state.window, current)) throw new Error('Capture returned another window');
    this.#window = state.window;
    if (this.#stack.length) this.#stack[this.#stack.length - 1] = state.window;
    let accessibility = state.accessibility;
    let elements = parseTree(accessibility?.tree);
    const focusedIndex = Number(/^\s*(\d+)\s/.exec(accessibility?.focused_element ?? '')?.[1]);
    elements = elements.map(e => ({ ...e, focused: Number.isFinite(focusedIndex) ? e.index === focusedIndex : e.flags.includes('focused') ? true : null }));
    let source = 'sky';
    const nativeRead = mode !== 'image' && this.#native?.inspect && (useNative || (!elements.length && backend === 'auto'));
    let revision = nativeRead ? null : await this.#getRevision(state.window.app); // une lecture native donne la sienne
    if (nativeRead) {
      const native = preread ?? await this.#native.inspect(state.window);
      accessibility = native.accessibility; elements = native.elements; source = 'native-uia';
      revision = native.revision;
      this.#nativePreferred = true;
    }
    else if (mode !== 'image') this.#nativePreferred = false;
    const observation = freeze({
      token: randomUUID(), epoch: this.#coordinator.epoch, capturedAt: treeStartedAt ?? Date.now(), mode, source, revision,
      window: clone(state.window), windowStack: this.#stack.map(w => w.id), windowChange: clone(windowChange), popups: clone(this.#popups),
      elements, structureHash: structureHash(elements),
      accessibility: clone(accessibility),
      // The provider displays images. Never copy their pixels into memory or telemetry.
      screenshots: (state.screenshots ?? []).map(({ id, width, height, originX, originY, zIndex }) =>
        ({ id, width, height, originX, originY, zIndex })),
      // Captures natives : fichiers locaux (LocalAppData) à regarder avec view_image ; jamais des cibles de coordonnées.
      images, imageFallback, ...(marksNote ? { marksNote } : {}),
    });
    this.#observation = observation;
    return observation;
  }
  // zoom : zone écran [left, top, width, height] d'une capture native (lookZoom), agrandie jusqu'à ×2.
  // marks : none (défaut), auto (contrôles sans nom), all ; mode both et lecture native seulement (sinon marksNote).
  // zoomWindow : fenêtre de l'image d'où vient la zone ; un dialogue suivi entre-temps la rend caduque (refus, rien lu
  // dans un autre repère ; relecture de Codex du 24/10).
  async observe({ mode = 'text', backend = 'auto', capture = 'sky', zoom = null, marks = 'none', zoomWindow = null } = {}) {
    return this.#exclusive(async () => {
      this.#invalidate(); // un refus ci-dessous ne laisse aucune observation utilisable (relecture de Codex du 24/10)
      const windowChange = await this.#follow(false);
      if (zoom && zoomWindow != null && this.#window?.id !== zoomWindow) {
        throw new Error(`region comes from an image of window ${zoomWindow}, but the observed window is now ${this.#window?.id}: look again without region`);
      }
      return this.#capture(mode, backend, { capture, windowChange, zoom, marks });
    });
  }
  #take(observation) {
    if (!observation || observation !== this.#observation || observation.epoch !== this.#coordinator.epoch) {
      throw new Error('Stale or foreign observation; observe and inspect the current window again');
    }
    if (Date.now() - observation.capturedAt > this.maxAgeMs) {
      this.#invalidate(); throw new Error('Observation expired; observe again');
    }
    return observation;
  }
  async inspectRecipe(name, observation) {
    if (!this.#memory) throw new Error('Local application memory is not configured');
    this.#take(observation);
    const recipe = await this.#memory.read(observation.window.app, name);
    this.#take(observation); // Disk I/O must not allow an interleaved action to reuse old state.
    if (!recipe) return { status: 'unknown', name };
    const revision = observation.source === 'native-uia' ? observation.revision : await this.#getRevision(observation.window.app);
    this.#take(observation);
    if (recipe.structureHash !== observation.structureHash || recipe.revision !== revision) {
      return { status: 'changed', name, recipe, reason: 'Application binary or visible control structure changed; inspect and relearn' };
    }
    try { uniqueElement(observation.elements, recipe.selector); }
    catch { return { status: 'changed', name, recipe, reason: 'Remembered target is absent, disabled or ambiguous' }; }
    return { status: 'ready', name, recipe };
  }
  async act(observation, request) {
    return this.#working(() => this.#exclusive(async () => {
      // Toute action laisse une trace (journal commun) : un refus avant l'entrée, non noté plus bas, l'est ici
      // (relecture de Codex du 23/10 : zéro métrique pour ces refus).
      const noted = this.#metrics.length, start = Date.now();
      try { return await this.#actOnce(observation, request); }
      catch (error) {
        if (this.#metrics.length === noted) this.#record(request?.kind, error?.refused || error?.beforeInput ? 'refused' : 'unknown', Date.now() - start);
        throw error;
      }
    }));
  }

  // Lot d'actions vérifiées en un appel : chaque étape a sa postcondition, s'appuie sur l'observation rafraîchie par
  // l'étape précédente (réobservation interne, une observation ne sert qu'une fois) et le lot s'arrête à la première
  // étape non atteinte, inconnue, différée, interrompue par Julien ou refusée.
  async actBatch(observation, steps) {
    return this.#working(() => this.#exclusive(async () => {
      if (!Array.isArray(steps) || !steps.length || steps.length > BATCH_MAX) throw new Error(`A batch needs 1 to ${BATCH_MAX} steps`);
      for (const [i, step] of steps.entries()) {
        // Étape rejetée avant le lot : notée au journal commun (rien n'est envoyé ; relecture de Codex).
        try { validateAction(clone(step)); } catch (error) { this.#record(step?.kind, 'refused', 0); throw new Error(`Step ${i}: ${error.message}`); }
        if (!step.expect) { this.#record(step?.kind, 'refused', 0); throw new Error(`Step ${i}: every batch step needs an explicit expect postcondition`); }
      }
      const report = [];
      let current = observation;
      // Bail d'interaction du lot : une étape suivante ne reprend jamais un nouveau jeton après sa clôture, même si la
      // relecture précédente a rendu une observation utilisable (relecture de Codex, 21/10).
      this.#batchLease = this.#interaction;
      try {
        for (const [index, step] of steps.entries()) {
          const started = Date.now();
          let result;
          const noted = this.#metrics.length;
          try { result = await this.#actOnce(current, step); }
          catch (error) {
            const status = error.emergencyStop ? 'stopped' : error.julienActive ? 'julien-active' : error.deferred ? 'deferred'
              : error.confirmationRequired ? 'confirmation-required' : error.refused || error.beforeInput ? 'refused' : 'unknown';
            // Étape refusée avant toute entrée et pas encore notée : journal commun aussi (relecture de Codex).
            if (this.#metrics.length === noted) this.#record(step?.kind, status, Date.now() - started);
            report.push({ index, kind: step.kind, status, error: error.message, durationMs: Date.now() - started });
            const summary = freeze({ status: 'stopped', stoppedAt: index, completed: index, steps: clone(report), observation: null });
            if (error.emergencyStop) { error.batch = summary; throw error; }
            return summary;
          }
          report.push({ index, kind: step.kind, status: result.status, verified: result.verified, performed: result.performed,
            technique: result.technique, foregroundTaken: result.foregroundTaken, foregroundReturned: result.foregroundReturned, julienInput: result.julienInput,
            windowChange: result.windowChange, durationMs: result.durationMs });
          current = result.observation;
          if (!['verified', 'already-satisfied'].includes(result.status) || result.julienInput) {
            return freeze({ status: 'stopped', stoppedAt: index, completed: index, steps: clone(report), observation: current });
          }
        }
        return freeze({ status: 'completed', completed: steps.length, steps: clone(report), observation: current });
      } finally { this.#batchLease = undefined; }
    }));
  }

  // Postcondition jugée sur une observation, avant toute entrée (règles en tête de fichier). Vrai : déjà atteinte et
  // précise (already-satisfied) ; faux : l'action est à faire ; refus (beforeInput) : la condition ne prouverait rien.
  #judge(spec, observation, selected) {
    const expect = spec.expect;
    const elements = observation.elements;
    const target = spec.kind === 'typeText' ? uniqueElement(elements, spec.focus) : selected;
    const found = findElements(elements, expect.selector);
    const onTarget = Boolean(target) && found.length === 1 && found[0].index === target.index;
    if (onTarget && restatesTarget(expect, actionTarget(spec)) === 'its existence') throw beforeInput(TRIVIAL('its existence'));
    // Liste déroulante : choix direct (select) ou option cliquée dans la liste ouverte.
    const combo = !target ? null : spec.kind === 'select' && target.role === 'combobox' ? target
      : spec.kind === 'click' && target.role === 'listitem'
        ? target.ancestors.map(i => elements.find(e => e.index === i)).reverse().find(e => e?.role === 'combobox') ?? null : null;
    if (combo) {
      const option = spec.kind === 'select' ? spec.option : target.name;
      const intoList = found.some(e => e.ancestors.includes(combo.index));
      const byName = expect.selector.name !== undefined && label(expect.selector.name) === label(option) && [undefined, 'listitem'].includes(expect.selector.role);
      if (intoList || byName) {
        const comboSelector = combo.automationId ? { role: 'combobox', automationId: combo.automationId } : { role: 'combobox', name: combo.name };
        throw beforeInput('A combo box choice is proven by the combo box value, not by its option element (exposed only while the list is open, ' +
          `or always present depending on the provider): expect:${JSON.stringify({ selector: comboSelector, field: 'value', equals: option })}`);
      }
    }
    if (!checkExpectation(elements, expect)) return false;
    const precise = expect.equals !== undefined && expect.exists !== false && (!onTarget || STATE_FIELDS.has(expect.field ?? 'name'));
    if (precise) return true;
    throw beforeInput('Postcondition is already true before the action, so it cannot prove its effect (' +
      (expect.equals === undefined ? 'existence or partial text' : "the target's label") + '). ' +
      'Use a precise state that this action changes (equals on value, checked, selected, expanded or focused, ' +
      'for example {field:\'expanded\', equals:true} for Expand), or a result on another element');
  }
  #already(observation, start, kind = null) {
    this.#record(kind, 'already', Date.now() - start);
    return freeze({ status: 'already-satisfied', verified: false, performed: false, technique: null, foregroundTaken: false,
      attempts: [], julienInput: false, windowChange: null, durationMs: Date.now() - start, observation });
  }
  // Une entrée physique existe-t-elle pour cette action ? Observation Sky : indices Sky ; native : UIA sous jeton.
  #canFallBack(spec, observation) {
    if (['select', 'menu'].includes(spec.kind)) return false;
    // Observation native : pas d'indice Sky pour remplacer une valeur ; clic sémantique par UIA sous jeton, frappe,
    // touches et coordonnées par Sky comme avant.
    if (observation.source === 'native-uia') return !['setValue', 'secondary'].includes(spec.kind);
    return true;
  }
  #backgroundPlan(spec, before, selected, coordinate, screenshot) {
    // Interaction en cours : la session tient déjà le jeton de premier plan ; le helper l'attendrait 8 s (autre
    // processus) pour un point ou une touche postés. Ces gestes passent par l'entrée physique sous le bail existant,
    // ou sont refusés avant toute entrée (relecture de Codex, 21/10).
    const leased = Boolean(this.#actLease !== undefined ? this.#actLease : this.#interaction?.active);
    if (coordinate && screenshot?.native && this.#native?.call && spec.kind !== 'drag') {
      if (leased) return null;
      // Point d'une capture native : clic (bouton, double) ou molette postés au contrôle sous le point ; le helper relit
      // le cadre de la fenêtre et refuse s'il a bougé depuis la capture.
      const f = screenshot.windowFrame ?? screenshot.frame;
      const at = gardeFous.nativeScreen(screenshot, spec.point);
      const args = { mode: 'background', x: at.x, y: at.y, frame: [f.left, f.top, f.width, f.height] };
      if (spec.kind === 'click') Object.assign(args, { action: 'click', button: spec.button ?? 'left', count: spec.count ?? 1 });
      else {
        const notches = v => (v ? Math.sign(v) * Math.max(1, Math.round(Math.abs(v) / 120)) : 0);
        Object.assign(args, { action: 'wheel', deltaY: -120 * notches(spec.scrollY ?? 0), deltaX: 120 * notches(spec.scrollX ?? 0) });
      }
      return { op: 'point', args };
    }
    if (coordinate || !this.#native?.call || !BACKGROUND_KINDS.has(spec.kind)) return null;
    if (spec.kind === 'click' && ((spec.button ?? 'left') !== 'left' || (spec.count ?? 1) !== 1)) return null;
    const native = before.source === 'native-uia';
    const target = spec.kind === 'typeText' ? uniqueElement(before.elements, spec.focus) : selected;
    const args = { mode: 'background' };
    if (target) {
      args.selector = spec.kind === 'typeText' ? spec.focus : spec.selector;
      if (native) Object.assign(args, nativeIdentity(target, before));
    }
    if (spec.kind === 'setValue') args.value = spec.value;
    if (spec.kind === 'typeText') args.text = spec.text;
    if (spec.kind === 'secondary') args.action = spec.action;
    if (spec.kind === 'select') args.option = spec.option;
    if (spec.kind === 'menu') args.path = spec.path;
    if (spec.kind === 'key') { if (leased) return null; args.key = spec.key; }
    return { op: spec.kind, args };
  }
  // ---- Confirmation étanche (garde-fous.mjs) : avant toute entrée, quelle que soit la technique ensuite ----
  // Arbre le plus riche disponible pour juger une touche ou un clic en coordonnées : lecture native fraîche (rectangles,
  // focus, raccourcis Alt, bouton par défaut), sinon l'observation qui fonde l'action.
  async #treeForConfirmation(before) {
    if (before.source === 'native-uia' && Date.now() - before.capturedAt <= FRESH_MS) return before.elements;
    if (!this.#native?.inspect) return before.elements;
    try { return (await this.#native.inspect(before.window)).elements ?? before.elements; }
    catch (error) {
      if (error.refused || error.emergencyStop) throw error;
      return before.elements;
    }
  }
  // Destruction locale (désinstaller, formater…) : confirm:true seul. Geste SORTANT (envoyer, payer, publier…) : en
  // plus, accord:"<jeton>" lié à l'action exacte (garde-fous.mjs, Accords), vérifié même avec confirm:true. Rend le
  // jeton vérifié (à brûler juste avant l'entrée), ou null.
  async #confirmation(spec, before, selected, screenshot) {
    const policy = gardeFous.load(); // illisible : refus, rien n'est envoyé (échec fermé)
    const title = before.window?.title ?? '';
    const outward = []; // déclencheurs sortants de ce geste : « libellé — d'où [mot] »
    const outwardLabels = new Set();
    let basis = before.elements, what = '';
    const fail = (labels) => {
      for (const [label, source] of labels) {
        const word = gardeFous.outwardWord(label, title, policy);
        if (word) { outward.push(`${String(label).trim().slice(0, 120)}${source ? ` — ${source}` : ''} [${word}]`); outwardLabels.add(label); continue; }
        if (spec.confirm === true) continue;
        const refusal = gardeFous.check(what, [[label, source]], title, policy);
        if (refusal) throw refusal;
      }
    };
    const anchors = []; // éléments visés par le geste : leur zone (composeur, formulaire) est liée à l'accord
    const clickOn = (element, elements) => {
      anchors.push(element);
      const trigger = gardeFous.triggerOf(element, elements, policy);
      if (trigger) fail([[gardeFous.labelOf(trigger, elements), '']]);
    };
    const atPoints = async points => {
      basis = await this.#treeForConfirmation(before);
      const root = basis.find(e => !e.ancestors?.length);
      for (const point of points) for (const [x, y] of gardeFous.screenPoints(point, screenshot, root)) {
        // Point d'une capture native : le helper vise la fenêtre la plus haute sous le point (ordre Z), pas forcément
        // l'élément le plus profond ; TOUS les éléments sous le point sont jugés (relecture de Codex).
        const under = screenshot?.native ? gardeFous.elementsAt(basis, x, y) : [gardeFous.elementAt(basis, x, y)].filter(Boolean);
        for (const hit of under) { hits++; clickOn(hit, basis); }
      }
      // Aucun élément (avec son rectangle) sous le point (lecture native trop grosse ou absente) : le geste est jugé comme
      // s'il visait chaque bouton d'action de la fenêtre (libre s'il n'y en a aucun de sortant ou d'irréversible) ;
      // sans aucun élément lu, refus : on ne sait rien de ce qu'il déclencherait.
      if (hits) return;
      if (!basis.length) throw beforeInput("Coordinate gesture: nothing is known under the point (no element read), so what it would trigger is unknown. Observe with mode:'both' or backend:'native', then act");
      // Tout élément nommé qui porte un déclencheur compte (même rôle générique que pour un clic par sélecteur), et tous
      // les documents de la fenêtre sont liés (corps d'un message sans zone connue).
      what += ' (élément sous le point inconnu)';
      blind = true;
      const labels = new Set();
      for (const e of basis) {
        if (!e.name) continue;
        const trigger = gardeFous.triggerOf(e, basis, policy);
        if (trigger && !trigger.disabled) labels.add(gardeFous.labelOf(trigger, basis));
      }
      fail([...labels].map(label => [label, "élément de la fenêtre"]));
    };
    let hits = 0, blind = false;
    let kinds = [];
    switch (spec.kind) {
      case 'click': {
        if ((spec.button ?? 'left') !== 'left') return null;
        if (selected) { what = spec.count === 2 ? 'double clic' : 'clic'; clickOn(selected, before.elements); break; }
        what = 'clic par coordonnées';
        await atPoints([spec.point]);
        break;
      }
      // Appuyer puis relâcher sur un bouton (même point, ou glisser jusqu'à lui) le déclenche : départ et arrivée jugés.
      case 'drag': what = 'glisser (départ et arrivée)'; await atPoints([spec.from, spec.to]); break;
      case 'secondary': what = `action secondaire ${spec.action}`; if (!gardeFous.freeSecondary(spec.action)) clickOn(selected, before.elements); break;
      case 'menu': what = 'menu'; fail([[spec.path.split('>').at(-1).trim(), '']]); break;
      // Après Tab dans le même geste, le focus a bougé : Entrée ou Espace sont jugés sur tous les boutons d'action.
      case 'key': {
        kinds = gardeFous.keyKinds(spec.key); what = `touche « ${spec.key} » : déclencherait`;
        if (/(^|\s)(shift\+)?tab(\s|$)/i.test(spec.key) && kinds.length) kinds = ['send'];
        break;
      }
      case 'typeText':
        // Une tabulation peut déplacer le focus (corps Gmail : Tab mène à Envoyer), même dans un document.
        if (/\t[\s\S]*[ \r\n]/.test(spec.text)) { kinds = ['send']; what = 'tabulation puis espace ou saut de ligne dans le texte : déclencherait'; }
        else if (/[\r\n]/.test(spec.text)) { kinds = ['submit']; what = 'saut de ligne dans le texte : déclencherait'; }
        break;
      default: return null;
    }
    let field = null;
    if (kinds.length) {
      basis = await this.#treeForConfirmation(before);
      if (spec.kind === 'typeText') {
        const matches = findElements(basis, spec.focus);
        if (matches.length === 1) field = matches[0];
      }
      field ??= basis.filter(e => e.focused === true).sort((a, b) => b.depth - a.depth)[0] ?? null;
      for (const kind of kinds) fail(gardeFous.keyTriggers(basis, field, kind, policy));
    }
    if (!outward.length) return null;
    if (field) anchors.push(field);
    // Ce que l'accord lie et montre (jamais un mot de passe) : valeurs des champs éditables ; un document (corps d'un
    // mail) s'il est le champ visé ou dans la zone du déclencheur (son ancêtre à 3 niveaux, jamais la racine : une page
    // ou le fil d'une messagerie hors de cette zone changent sans cesse). Destinataires à part : valeur d'un champ nommé
    // À, To recipients, Cc, Courriel, IBAN…, et « pastilles » (adresse validée devenue bouton ou élément de liste) dans
    // ce champ ou à côté de lui (même parent, jamais la racine), sauf les déclencheurs du geste ; un élément de trop y est
    // lié en plus (sens sûr). Conversation (Teams, WhatsApp : le destinataire n'est pas un champ) : titre sans compteur,
    // titres de section et éléments sélectionnés des listes (conversation ouverte).
    const zoneOf = e => { const a = e.ancestors ?? []; const levels = Math.min(3, a.length - 1); return levels > 0 ? a[a.length - levels] : null; };
    const zones = new Set(anchors.map(zoneOf).filter(z => z !== null));
    const isRecipient = e => RECIPIENT_FIELD.test(plainName(e.name || e.automationId || ''));
    const isEditable = e => ['edit', 'combobox'].includes(e.role) || (e.role === 'document' && (blind || e === field || e.ancestors?.some(i => zones.has(i))));
    const chipHomes = new Set(basis.filter(isRecipient).flatMap(e => isEditable(e) && e.ancestors?.length > 1 ? [e.index, e.ancestors.at(-1)] : [e.index]));
    const CHIP_ROLES = new Set(['button', 'listitem', 'link', 'menuitem', 'custom', 'unknown']);
    const recipients = [], chips = [], content = [];
    const conversation = [title.replace(/^\(\d+\+?\)\s*/, '').replace(/\s*\(\d+\+?\)$/, '')];
    for (const e of basis) {
      if (e.password) continue;
      const name = e.name || e.automationId || 'champ';
      if (isEditable(e)) {
        if (!e.value) continue;
        if (isRecipient(e)) recipients.push(e.value);
        else content.push(`${name}: ${e.value}${e.valueTruncated ? ' […]' : ''}`);
      } else if (e.name && CHIP_ROLES.has(e.role) && !isRecipient(e) && !anchors.includes(e) && !outwardLabels.has(e.name) &&
          (chipHomes.has(e.ancestors?.at(-1)) || e.ancestors?.some(i => chipHomes.has(i) && basis.find(x => x.index === i && !isEditable(x) && isRecipient(x))))) {
        chips.push(e.name);
      } else if (e.name && (e.role === 'heading' || (e.selected === true && ['listitem', 'treeitem', 'tab', 'dataitem'].includes(e.role)))) {
        conversation.push(e.name);
      }
    }
    if (spec.kind === 'typeText') content.push(`typed: ${spec.text}`);
    const act = gardeFous.action({ gesture: what, targets: outward, recipients, chips, conversation, content,
      window: `${before.window?.app ?? ''}#${before.window?.id ?? ''}`, title });
    const refusal = gardeFous.accords.check(act, spec.confirm, spec.accord, policy);
    if (refusal) throw refusal;
    return spec.accord;
  }

  // Contrôles propres à l'entrée physique, faits sur l'observation qui la fonde.
  #physicalTarget(spec, original, basis) {
    if (!this.#canFallBack(spec, basis)) {
      throw beforeInput(basis.source === 'native-uia'
        ? `No background technique applies, and a native observation has no Sky index for a physical ${spec.kind}`
        : `No background technique applies for ${spec.kind}; open the control with a click and choose the item`);
    }
    if (spec.kind === 'click' && spec.selector && basis.source === 'native-uia' && ((spec.button ?? 'left') !== 'left' || (spec.count ?? 1) !== 1) &&
        !this.#nativeInput()) {
      throw beforeInput('Native semantic actions require one left click; observe a screenshot for other clicks');
    }
    let selected;
    if (spec.selector) {
      const current = uniqueElement(basis.elements, spec.selector);
      const prior = uniqueElement(original.elements, spec.selector);
      if (!equal(targetIdentity(prior, original.elements), targetIdentity(current, basis.elements))) {
        throw beforeInput('Target context changed since inspection; inspect the new observation');
      }
      selected = current;
    }
    if (spec.kind === 'typeText') {
      const focused = uniqueElement(basis.elements, spec.focus);
      const prior = uniqueElement(original.elements, spec.focus);
      if (!equal(targetIdentity(prior, original.elements), targetIdentity(focused, basis.elements))) {
        throw beforeInput('Editable target context changed since inspection; observe again');
      }
      if (!['edit', 'document'].includes(focused.role)) throw beforeInput('Focus target is not an editable surface');
      const focusIndex = Number(/^\s*(\d+)\s/.exec(basis.accessibility?.focused_element ?? '')?.[1]);
      if (focusIndex !== focused.index) throw beforeInput('Observed editable surface does not have keyboard focus');
    }
    return selected;
  }

  // ---- Présence de Julien avant toute entrée physique ----
  // Garde prévu (session réelle) mais présence inconnue (garde mort, en cours de relance) : attente brève de son retour
  // (le contrôle d'arrêt le relance), puis refus différé. Jamais d'entrée physique sur une inactivité supposée.
  async #knownPresence(presence) {
    if (!this.#stop.guardExpected || presence?.available) return;
    const sleep = this.#pause.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    for (let i = 0; i < PRESENCE_POLLS && !presence?.available; i++) {
      this.#assertNotStopped();
      await sleep(PRESENCE_POLL_MS);
    }
    if (!presence?.available) throw new PresenceUnknownError(this.#stop.guardState ?? 'absent');
  }
  // Bail d'interaction de l'action (figé à son entrée) expiré, remplacé ou jeton perdu : plus aucune entrée.
  #leaseGone(lease = this.#actLease !== undefined ? this.#actLease : this.#interaction) {
    if (lease?.held?.() === false) lease.finish?.('token-lost'); // helper du bail disparu : bail clos
    return Boolean(lease && (!lease.active || lease.reason || this.#interaction !== lease || lease.held?.() === false)) ||
      this.#tokenHeld?.() === false;
  }
  async #physicalInput(purpose, action, { token = true } = {}) {
    const interaction = this.#actLease !== undefined ? this.#actLease : this.#interaction;
    const leaseGone = () => this.#leaseGone(interaction);
    if (leaseGone()) throw beforeInput('Foreground interaction ended before input');
    const presence = this.#stop.presence;
    let waitedMs = 0;
    await this.#knownPresence(presence);
    if (presence?.available) waitedMs = Math.round((await presence.waitForPause(this.#pause)).waitedMs);
    this.#assertNotStopped();
    if (leaseGone()) throw beforeInput('Foreground interaction ended before input'); // expirée pendant la pause
    let t0 = 0;
    const run = async () => {
      if (leaseGone()) throw beforeInput('Foreground interaction ended before input');
      // Le jeton peut avoir attendu : Julien a peut-être repris la main entre-temps.
      if (presence?.available && presence.idleMs() < this.#pause.quietMs) throw new JulienActiveError(presence.idleMs());
      const injection = presence?.beginInjection?.();
      t0 = presence?.now?.() ?? 0;
      try { return await action(presence); } finally { presence?.endInjection?.(injection); }
    };
    const report = {};
    // Julien a repris clavier ou souris pendant l'entrée (présence, injections de l'agent exclues) : le helper garde son
    // choix au lieu de remettre l'ancienne fenêtre devant.
    const keep = () => Boolean(presence?.available && t0 && presence.since(t0));
    const value = token ? await this.#foreground(purpose, run, report, keep) : await run();
    return { value, waitedMs, presence: presence?.source ?? 'none', julienInput: Boolean(presence?.available && presence.since(t0)), ...report };
  }
  // Vraie souris et vrai clavier PROPRES au helper (Physical.cs, sans Sky ; décision de Julien du 22/10) : disponibles
  // dès que le helper et son jeton de premier plan le sont. Sky ne sert plus qu'en secours (pas de helper).
  #nativeInput() { return Boolean(this.#native?.call && this.#native?.withForeground); }
  // Point d'écran de l'entrée physique native : capture native (origine du cadre + point) ou centre du rectangle d'une
  // cible d'observation native ; null : pas de repère natif (Sky en secours).
  #nativePoint(spec, basis, selected, screenshot, key = 'point') {
    if (screenshot?.native && spec[key]) {
      const f = screenshot.windowFrame ?? screenshot.frame;
      return { ...gardeFous.nativeScreen(screenshot, spec[key]), frame: [f.left, f.top, f.width, f.height] };
    }
    if (basis.source === 'native-uia' && selected?.bounds?.length === 4 && selected.bounds[2] > 0 && selected.bounds[3] > 0) {
      const [x, y, w, h] = selected.bounds;
      return { x: Math.round(x + w / 2), y: Math.round(y + h / 2) };
    }
    return null;
  }
  #nativePhysical(purpose, basis, args, run) {
    return this.#physicalInput(purpose, presence => (run ? run(presence) : this.#native.call(basis.window, 'physical', args)))
      .then(r => ({ ...r, outcome: { technique: 'physical:native', mechanism: r.value?.mechanism ?? purpose, effect: 'sent', foregroundTaken: true,
        // Menu contextuel ouvert par CE vrai clic droit (helper), comme pour le clic droit posté.
        ...(r.value && Object.hasOwn(r.value, 'contextMenu') ? { contextMenu: r.value.contextMenu } : {}) } }));
  }
  // null : geste sans repère natif (Sky en secours) ; clic gauche simple sur une cible native : UIA au premier plan
  // (chemin existant, plus sûr qu'un point).
  async #runNativePhysical(spec, basis, selected, screenshot) {
    switch (spec.kind) {
      case 'click': {
        if (basis.source === 'native-uia' && selected && (spec.button ?? 'left') === 'left' && (spec.count ?? 1) === 1) return null;
        const click = { action: 'click', button: spec.button ?? 'left', count: spec.count ?? 1 };
        if (basis.source === 'native-uia' && selected && spec.selector) {
          // Le helper relit la cible (identité, ascendance, rectangle) APRÈS la mise au premier plan, juste avant l'entrée ;
          // aucun centre ancien n'est envoyé (relecture de Codex du 22/10 12:22).
          return this.#nativePhysical('native click', basis, { ...click, selector: spec.selector, ...nativeIdentity(selected, basis) });
        }
        const at = this.#nativePoint(spec, basis, null, screenshot);
        if (!at) return null;
        return this.#nativePhysical('native click', basis, { ...click, ...at });
      }
      case 'scroll': {
        const at = this.#nativePoint(spec, basis, null, screenshot);
        if (!at) return null;
        const notches = v => (v ? Math.sign(v) * Math.max(1, Math.round(Math.abs(v) / 120)) : 0);
        return this.#nativePhysical('native wheel', basis, { action: 'wheel', ...at, deltaY: -120 * notches(spec.scrollY ?? 0), deltaX: 120 * notches(spec.scrollX ?? 0) });
      }
      case 'drag': {
        const from = this.#nativePoint(spec, basis, null, screenshot, 'from');
        const to = this.#nativePoint(spec, basis, null, screenshot, 'to');
        if (!from || !to) return null;
        return this.#nativePhysical('native drag', basis, { action: 'drag', ...from, toX: to.x, toY: to.y });
      }
      case 'key': return this.#nativePhysical('native key', basis, { action: 'key', key: spec.key });
      case 'typeText': {
        // Frappe par tranches, comme avant : arrêt d'urgence, bail et présence de Julien contrôlés entre deux tranches ;
        // le reste n'est jamais envoyé après une interruption.
        const chunks = textChunks(spec.text, TYPE_CHUNK);
        const r = await this.#nativePhysical('native typeText', basis, null, async presence => {
          let typed = 0;
          for (const chunk of chunks) {
            if (typed > 0) {
              try { this.#stop.assertClear(); } catch { return { interrupted: 'emergency-stop', typed, total: chunks.length, mechanism: 'SendInput unicode text' }; }
              if (this.#leaseGone()) return { interrupted: 'interaction-ended', typed, total: chunks.length, mechanism: 'SendInput unicode text' };
            }
            const c0 = presence?.now?.() ?? 0;
            try { await this.#native.call(basis.window, 'physical', { action: 'type', text: chunk }); } catch (error) {
              // Tranches déjà envoyées : état partiel, accord consommé, jamais rendu ni rejoué (relecture de Codex 12:22).
              if (typed > 0 || error.afterInput) throw Object.assign(error, { afterInput: true, refused: false, beforeInput: false, notApplicable: false, deferred: false,
                typed: { chunks: typed, total: chunks.length, ...(error.typed ? { characters: error.typed } : {}) } });
              throw error;
            }
            typed++;
            if (typed < chunks.length && presence?.available && presence.since(c0)) return { interrupted: 'julien', typed, total: chunks.length, mechanism: 'SendInput unicode text' };
          }
          return { interrupted: null, typed, total: chunks.length, mechanism: 'SendInput unicode text' };
        });
        return { ...r, interrupted: r.value.interrupted, typed: { chunks: r.value.typed, total: r.value.total } };
      }
      default: return null;
    }
  }
  async #runPhysical(spec, basis, selected, screenshot) {
    const input = { window: basis.window };
    const nativeOnly = basis.window?.nativeOnly === true;
    if (this.#nativeInput()) {
      // « non applicable » du helper (ancien helper sans vraie entrée, geste qu'il ne sait pas faire) : rien n'a été
      // envoyé, Sky en secours ; toute autre erreur remonte telle quelle.
      try {
        const native = await this.#runNativePhysical(spec, basis, selected, screenshot);
        if (native) return native;
      } catch (error) {
        if (!error.notApplicable) throw error;
        // Point d'une capture native : Sky ne sait pas le viser ; refus, rien n'a été envoyé.
        if (screenshot?.native) throw Object.assign(new Error(`No technique applies at this point (${error.message}): nothing was sent`), { refused: true, beforeInput: true });
      }
    }
    // Fenêtre que Sky ne liste pas : aucune technique Sky, refus avant toute entrée (la voie UIA native du helper,
    // plus bas, reste permise : relecture de Codex).
    const noSky = () => { if (nativeOnly) throw beforeInput('No helper technique applies and Sky does not list this window: nothing was sent'); };
    const physical = (purpose, call) => (noSky(), this.#physicalInput(purpose, async presence => {
      // La capture precedente a rendu le premier plan a Julien. Ne jamais
      // envoyer une frappe ou un clic physique a cette application restituee.
      if (!this.#interaction?.active) await this.#sky.activate_window({ window: basis.window });
      this.#assertNotStopped();
      // Jeton ou bail perdu pendant l'activation : rien n'est envoyé (relecture de Codex, 21/10).
      if (this.#leaseGone()) throw beforeInput('Foreground token or interaction lost before input');
      return call(presence);
    }).then(r => ({ ...r, outcome: { technique: 'physical:sky', mechanism: purpose, effect: 'sent', foregroundTaken: true } })));
    switch (spec.kind) {
      case 'click': {
        if (basis.source === 'native-uia' && selected) {
          // Voie UIA au premier plan : un clic gauche SIMPLE seulement (Invoke, SetFocus) ; un clic droit ou double n'y est
          // jamais réduit (relecture de Codex du 22/10 13:57 : repli d'un clic droit en Invoke de « Envoyer »).
          if ((spec.button ?? 'left') !== 'left' || (spec.count ?? 1) !== 1) throw beforeInput('No technique keeps this right or double click on the native target: nothing was sent');
          if (this.#interaction?.active) throw beforeInput('Use observed coordinates for a foreground click during an interaction; native background actions remain available');
          let reply;
          try {
            // Le helper prend lui-même le jeton (jusqu'à 8 s) : il recontrôle la pause de Julien une fois le jeton pris,
            // juste avant Invoke ou SetFocus, et lui rend sa fenêtre sous le jeton.
            reply = await this.#physicalInput('UIA foreground', presence =>
              this.#native.call(basis.window, 'click', { selector: spec.selector, ...nativeIdentity(selected, basis), mode: 'foreground',
                ...(presence?.available ? { quietMs: this.#pause.quietMs } : {}) }), { token: false });
          } catch (error) {
            if (error.notApplicable) throw beforeInput('No background or foreground UI Automation technique applies: ' + error.message);
            throw error;
          }
          const r = reply.value ?? {};
          return { ...reply, foregroundReturned: r.foregroundReturned ?? null,
            outcome: { technique: r.technique ?? 'foreground:uia', mechanism: r.mechanism ?? null, effect: r.effect ?? 'sent', foregroundTaken: r.foregroundTaken ?? null } };
        }
        Object.assign(input, selected ? { element_index: selected.index } : { screenshotId: screenshot.id, x: spec.point.x, y: spec.point.y });
        Object.assign(input, { mouse_button: spec.button ?? 'left', click_count: spec.count ?? 1 });
        return physical('Sky click', () => this.#sky.click(input));
      }
      // Techniques sémantiques de Sky : UI Automation géré, qui peut activer la fenêtre ou lui donner le focus (mesure du
      // banc 1.3.0, voir Background.cs). Même règle qu'une entrée physique : pause de Julien, jeton, fenêtre rendue.
      case 'setValue': {
        noSky();
        const r = await this.#physicalInput('Sky set_value', () => this.#sky.set_value({ ...input, element_index: selected.index, value: spec.value }));
        return { ...r, outcome: { technique: 'sky:semantic', mechanism: 'set_value', effect: 'sent', foregroundTaken: null } };
      }
      case 'secondary': {
        noSky();
        if (!selected.actions.some(a => a.toLowerCase() === String(spec.action).toLowerCase())) throw beforeInput('Secondary action is not exposed by this control');
        const r = await this.#physicalInput('Sky secondary action', () => this.#sky.perform_secondary_action({ ...input, element_index: selected.index, action: spec.action }));
        return { ...r, outcome: { technique: 'sky:semantic', mechanism: 'perform_secondary_action', effect: 'sent', foregroundTaken: null } };
      }
      case 'typeText': {
        // Frappe graphème par graphème : avant chacun, l'arrêt d'urgence est contrôlé ; après chacun, la présence. Si
        // Julien appuie sur l'arrêt ou reprend clavier ou souris, la frappe s'arrête (le reste n'est jamais envoyé).
        const chunks = textChunks(spec.text, TYPE_CHUNK);
        const r = await physical('Sky typeText', async presence => {
          let typed = 0;
          for (const chunk of chunks) {
            if (typed > 0) {
              try { this.#stop.assertClear(); } catch { return { interrupted: 'emergency-stop', typed, total: chunks.length }; }
              if (this.#leaseGone()) return { interrupted: 'interaction-ended', typed, total: chunks.length };
            }
            const c0 = presence?.now?.() ?? 0;
            await this.#sky.type_text({ ...input, text: chunk });
            typed++;
            if (typed < chunks.length && presence?.available && presence.since(c0)) return { interrupted: 'julien', typed, total: chunks.length };
          }
          return { interrupted: null, typed, total: chunks.length };
        });
        return { ...r, interrupted: r.value.interrupted, typed: { chunks: r.value.typed, total: r.value.total } };
      }
      case 'key': return physical('Sky key', () => this.#sky.press_key({ ...input, key: spec.key }));
      case 'scroll': return physical('Sky scroll', () => this.#sky.scroll({ ...input, screenshotId: screenshot.id, x: spec.point.x, y: spec.point.y, scrollX: spec.scrollX ?? 0, scrollY: spec.scrollY ?? 0 }));
      case 'drag': return physical('Sky drag', () => this.#sky.drag({ ...input, screenshotId: screenshot.id, from_x: spec.from.x, from_y: spec.from.y, to_x: spec.to.x, to_y: spec.to.y }));
      default: throw beforeInput(`No physical technique for ${spec.kind}`);
    }
  }
  // Relecture après l'entrée : fenêtres liées suivies, puis attente de la postcondition (lectures seulement).
  #closed() {
    this.#invalidate();
    const observation = freeze({
      token: randomUUID(), epoch: this.#coordinator.epoch, capturedAt: Date.now(), mode: 'text', source: 'native-alive',
      revision: null, window: clone(this.#window), windowStack: [this.#window.id], windowChange: { reason: 'closed', from: this.#window.id, to: null },
      popups: [], elements: [], structureHash: structureHash([]), accessibility: null, screenshots: [], images: [],
      imageFallback: null, closed: true,
    });
    this.#observation = observation;
    return observation;
  }
  async #settle(spec, coordinate) {
    const refresh = spec.refresh ?? (coordinate ? 'both' : 'text');
    // Fenêtre liée fermée par l'action (Alt+F4, bouton Fermer, dialogue qui ferme l'application) : état terminal relu
    // par le helper à toute profondeur de pile, avant chaque capture et après une capture en échec, sans recapturer le
    // HWND détruit (passe 2 du 22/10, relecture de Codex). Existence illisible : la capture décide, comme avant.
    const rootGone = async () => {
      if (!this.#native?.alive || !this.#stack.length) return false;
      let state = null;
      try { state = (await this.#native.alive(this.#stack[0])).state; } catch { /* inconnu */ }
      return state === 'gone' || state === 'other';
    };
    const closed = () => {
      const from = this.#stack[0].id;
      this.#stack = [this.#stack[0]];
      this.#window = this.#stack[0];
      return { after: this.#closed(), change: { reason: 'closed', from, to: null } };
    };
    // Suivi et capture en échec : la racine relue d'abord (gone|other : terminal) ; sinon, une fenêtre du dessus
    // disparue pendant sa capture est dépilée par un nouveau suivi (lectures seules, preuve alive) et le propriétaire
    // recapturé une fois ; jamais de rejeu de l'action. Erreur d'existence : l'erreur d'origine remonte (inconnu).
    const GONE = Symbol('gone');
    let recovered = null; // fermeture du dessus relue pendant une capture : c'est le changement de fenêtre de l'action
    const follow = async () => {
      try { return await this.#follow(true); }
      catch (error) { if (await rootGone()) return GONE; throw error; }
    };
    const guarded = async (mode, windowChange) => {
      if (await rootGone()) return null;
      try { return await this.#capture(mode, 'auto', { windowChange }); }
      catch (error) { if (await rootGone()) return null; throw error; }
    };
    const capture = async (mode, windowChange) => {
      recovered = null; // propre à CETTE lecture : un ancien dépilage n'écrase jamais un suivi plus récent
      if (await rootGone()) return null;
      try { return await this.#capture(mode, 'auto', { windowChange }); }
      catch (error) {
        if (await rootGone()) return null;
        const top = this.#window?.id;
        const popped = this.#stack.length > 1 ? await follow() : null;
        if (popped === GONE) return null;
        // Recapture unique du propriétaire, elle aussi gardée par la relecture de la racine (relecture de Codex).
        if (popped?.reason === 'closed' && this.#window?.id !== top) { recovered = popped; return guarded(mode, popped); }
        throw error;
      }
    };
    let change = await follow();
    if (change === GONE) return closed();
    let after = await capture(spec.expect && refresh === 'image' ? 'both' : refresh, change);
    if (!after) return closed();
    if (recovered) change = recovered;
    if (spec.expect && !checkExpectation(after.elements, spec.expect)) {
      const deadline = Date.now() + (spec.timeoutMs ?? 1618);
      while (Date.now() < deadline && !checkExpectation(after.elements, spec.expect)) {
        await sleep(100);
        const followed = await follow();
        if (followed === GONE) return closed();
        change = followed ?? change;
        after = await capture('text', change); // Wait on state only. Never repeat the input.
        if (!after) return closed();
        if (recovered) change = recovered;
      }
    }
    return { after, change };
  }

  async #actOnce(observation, request) {
    const start = Date.now();
    try { this.#assertNotStopped(); }
    catch (error) { this.#record(request?.kind ?? 'unknown', 'stopped', Date.now() - start); throw error; }
    // Bail d'interaction sur lequel l'action est fondée, figé AVANT toute attente (capture, fenêtre, confirmation,
    // fenêtres liées) : une expiration pendant l'une d'elles ne fait jamais prendre un NOUVEAU bail pour envoyer
    // (relecture de Codex, 21/10).
    this.#actLease = this.#batchLease !== undefined ? this.#batchLease : this.#interaction;
    const original = this.#take(observation);
    const spec = clone(request);
    validateAction(spec);
    const coordinate = spec.point !== undefined || spec.kind === 'scroll' || spec.kind === 'drag';
    if (spec.selector && coordinate) throw new Error('Choose a semantic selector or screenshot coordinates');
    if (spec.kind === 'typeText' && !spec.focus) throw new Error('typeText requires a focus selector from the observed editable surface');
    let selected;
    if (spec.selector) selected = uniqueElement(original.elements, spec.selector);
    if (['setValue', 'secondary', 'select'].includes(spec.kind) && !selected) throw new Error('A semantic target is required');
    if (spec.kind === 'click' && !selected && !coordinate) throw new Error('Click requires an observed semantic or coordinate target');
    if (spec.kind === 'typeText') uniqueElement(original.elements, spec.focus);
    if (['select', 'menu'].includes(spec.kind) && !this.#native?.call) throw new Error(`${spec.kind} needs the native helper (messages or UI Automation in background)`);
    if (spec.kind === 'secondary' && !selected.actions.some(a => a.toLowerCase() === String(spec.action).toLowerCase())) {
      throw new Error('Secondary action is not exposed by this control');
    }
    if (spec.expect && this.#judge(spec, original, selected)) return this.#already(original, start, spec.kind);
    let screenshot;
    if (coordinate) {
      screenshot = original.screenshots.find(s => s.id === spec.screenshotId) ?? nativeShot(original, spec.screenshotId);
      if (!screenshot) throw new Error('Choose a screenshotId from the inspected observation');
      // Glisser au point d'une capture native : seulement par la vraie souris du helper (relecture de Codex du 22/10 12:22).
      if (screenshot.native && !['click', 'scroll', ...(this.#nativeInput() ? ['drag'] : [])].includes(spec.kind)) throw new Error('A native capture point supports click and scroll only');
      // Pixel entier fixé AVANT la confirmation : c'est exactement lui qui sera jugé puis envoyé (relecture de Codex :
      // 109,6 jugé sur « Enregistrer », 110 envoyé sur « Envoyer »).
      const whole = p => p && { x: Math.floor(p.x), y: Math.floor(p.y) };
      if (screenshot.native && spec.kind === 'drag') Object.assign(spec, { from: whole(spec.from), to: whole(spec.to) });
      else if (screenshot.native) spec.point = whole(spec.point);
      const points = spec.kind === 'drag' ? [spec.from, spec.to] : [spec.point];
      for (const p of points) {
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.y < 0 ||
            (screenshot.width !== undefined && p.x >= screenshot.width) ||
            (screenshot.height !== undefined && p.y >= screenshot.height)) throw new Error('Point is outside the observed screenshot');
      }
    }
    let before = original;
    // Observation native lue il y a moins de FRESH_MS (celle que l'étape précédente d'un lot vient de relire) : pas de
    // seconde lecture complète juste avant l'entrée, elle n'apprendrait rien de plus ; le helper relit de toute façon la
    // cible et ses ancêtres (identité d'exécution, chaîne, activation, mot de passe) au moment de l'entrée.
    const fresh = original.source === 'native-uia' && Date.now() - original.capturedAt <= FRESH_MS &&
      !spec.requiredStructureHash && !Object.hasOwn(spec, 'requiredRevision');
    if (!coordinate && !fresh) {
      // Sky's Windows indexed click uses screen geometry even with an AX target.
      // A text-only refresh clears that geometry. Native UIA patterns do not need it.
      before = await this.#capture(original.source === 'sky' && spec.kind === 'click' ? 'both' : 'text');
      if (before.source !== original.source) throw new Error('Observation provider changed; inspect the new controls before input');
      if (spec.requiredStructureHash && spec.requiredStructureHash !== before.structureHash) {
        throw new Error('Remembered UI structure changed immediately before input; inspect and relearn');
      }
      if (Object.hasOwn(spec, 'requiredRevision') && spec.requiredRevision !== before.revision) {
        throw new Error('Application binary changed immediately before input; inspect and relearn');
      }
      if (selected) {
        const current = uniqueElement(before.elements, spec.selector);
        if (!equal(targetIdentity(selected, original.elements), targetIdentity(current, before.elements))) {
          throw new Error('Target context changed since inspection; inspect the new observation');
        }
        selected = current;
      }
      if (spec.kind === 'typeText') {
        const focused = uniqueElement(before.elements, spec.focus);
        const priorFocus = uniqueElement(original.elements, spec.focus);
        if (!equal(targetIdentity(priorFocus, original.elements), targetIdentity(focused, before.elements))) {
          throw new Error('Editable target context changed since inspection; observe again');
        }
        if (!['edit', 'document'].includes(focused.role)) throw new Error('Focus target is not an editable surface');
      }
      if (spec.expect && this.#judge(spec, before, selected)) return this.#already(before, start, spec.kind);
    } else if (coordinate) {
      if (before.window.nativeOnly) {
        if ((await this.#native.alive(before.window)).state !== 'alive') throw new Error('Coordinate target identity changed');
      } else {
        const current = await this.#sky.get_window({ id: before.window.id, app: before.window.app });
        if (!sameWindow(current, before.window)) throw new Error('Coordinate target identity changed');
      }
    }
    if (spec.kind === 'click' && selected && hiddenOffscreen(selected, before.elements)) {
      throw beforeInput('Target is off-screen (IsOffscreen) with no visible part in its window: a click would act on what Julien cannot see. ' +
        'Scroll it into view, observe again, then act (visible first)');
    }
    // Confirmation étanche : refus avant toute entrée et avant toute consommation (rien n'a été fait).
    let accord;
    try { accord = await this.#confirmation(spec, before, selected, screenshot); }
    catch (error) { if (error.refused) this.#record(spec.kind, error.confirmationRequired ? 'confirmation-required' : 'refused', Date.now() - start); throw error; }
    const background = this.#backgroundPlan(spec, before, selected, coordinate, screenshot);
    // Sans technique d'arrière-plan possible, les contrôles de l'entrée physique précèdent toute consommation.
    if (!background) selected = this.#physicalTarget(spec, original, before) ?? selected;
    await this.#markSeen();
    // Jeton d'accord brûlé au dernier moment (deux appels ne peuvent pas l'utiliser tous deux) ; rendu plus bas si
    // l'entrée est refusée avant tout envoi.
    const spent = accord ? gardeFous.accords.spend(accord) : null;
    if (accord && !spent) throw Object.assign(new Error('Accord already used by another action: nothing was done; observe again'), { refused: true, beforeInput: true });
    this.#invalidate(); // Consume BEFORE sending input, including input with unknown outcomes.
    const attempts = [];
    let outcome = null, after, change = null, physical = null, unconfirmed = false;
    try {
      this.#assertNotStopped(); // Dernier point de contrôle avant l'entrée (après la relecture).
      // Action fondée sur une interaction expirée pendant sa préparation : ni geste posté ni nouveau jeton.
      if (this.#actLease && this.#leaseGone(this.#actLease)) throw beforeInput('Foreground interaction ended before input');
      if (background) {
        try {
          const reply = (await this.#native.call(before.window, background.op, background.args)) ?? {};
          outcome = { technique: reply.technique ?? 'background:uia', mechanism: reply.mechanism ?? null, effect: reply.effect ?? 'sent',
            foregroundTaken: reply.foregroundTaken === true, cursorMoved: reply.cursorMoved === true,
            // Premier plan rendu par le helper après un geste posté qui l'a fait prendre (Background.cs) : jusqu'au résultat.
            ...(typeof reply.foregroundReturned === 'string' ? { foregroundReturned: reply.foregroundReturned } : {}),
            // Diagnostic du geste au point (Pointer.LastTrace) et menu contextuel ouvert par CE clic droit (Background.cs) :
            // gardés jusqu'au résultat, sinon perdus (relecture de Codex du 22/10 07:13).
            ...(reply.trace ? { trace: reply.trace } : {}), ...(Object.hasOwn(reply, 'contextMenu') ? { contextMenu: reply.contextMenu } : {}) };
          attempts.push({ technique: outcome.technique, mechanism: outcome.mechanism, effect: outcome.effect });
        } catch (error) {
          if (!error.notApplicable) throw error;
          attempts.push({ technique: 'background', outcome: 'not-applicable', reason: error.message });
        }
      }
      if (outcome) {
        ({ after, change } = await this.#settle(spec, coordinate));
        // Repli physique seulement après un « none » RELU par le helper : rien n'a pris, rien n'est parti. Après « sent »
        // (transmis sans relecture possible), un état encore inchangé ne prouve rien : l'effet peut être lent (revue du
        // 16/10 : effet arrivé à 2,5 s, après la fenêtre de 1,618 s ; le repli refaisait un vrai clic, double action
        // rapportée « verified »). Ce cas reste « sent-unconfirmed » (envoyé, effet non relu) : jamais vérifié ni rejoué.
        if (spec.expect && !checkExpectation(after.elements, spec.expect)) {
          if (outcome.effect === 'none' && spec.fallback !== false && this.#canFallBack(spec, before)) {
            attempts.at(-1).outcome = 'no-effect';
            const basis = after.source === 'sky' && spec.kind === 'click' && after.mode === 'text' ? await this.#capture('both') : after;
            this.#invalidate();
            selected = this.#physicalTarget(spec, original, basis);
            before = basis; outcome = null;
          } else if (outcome.effect === 'sent' && !change && after.window.id === before.window.id && after.source === before.source &&
              after.structureHash === before.structureHash && stateDigest(after.elements) === stateDigest(before.elements)) {
            attempts.at(-1).outcome = 'effect-not-read';
            unconfirmed = true;
          }
        }
      }
      if (!outcome) {
        // fallback:false interdit TOUTE entrée physique, y compris quand aucune technique d'arrière-plan ne s'applique
        // (relecture de Codex du 21/10 : seul le repli après « none » le contrôlait). Rien n'a été envoyé.
        if (screenshot?.native && !this.#nativeInput()) {
          // Ni capture Sky ni vraie entrée du helper pour viser ce point : refus, rien n'a été envoyé.
          throw Object.assign(new Error('No background technique applies at this point; physical input needs a Sky screenshotId: nothing was sent'),
            { refused: true, beforeInput: true });
        }
        if (spec.fallback === false) {
          throw Object.assign(new Error('No background technique applies and fallback:false forbids physical input: nothing was sent'),
            { refused: true, beforeInput: true });
        }
        if (background && attempts.at(-1)?.outcome === 'not-applicable') selected = this.#physicalTarget(spec, original, before) ?? selected;
        physical = await this.#runPhysical(spec, before, selected, screenshot);
        outcome = physical.outcome;
        attempts.push({ technique: outcome.technique, mechanism: outcome.mechanism, effect: outcome.effect });
        ({ after, change } = await this.#settle(spec, coordinate));
      }
      // Helper du bail perdu pendant l'envoi ou la relecture (fond compris) : l'entrée a pu partir sans jeton ; inconnue
      // dès cette action, jamais « verified » (relecture de Codex, 21/10).
      // Bail clos pendant l'action : sa sortie (accusé du helper ou perte) est attendue avant de juger.
      if (this.#actLease?.reason) await this.#actLease.done;
      if (this.#actLease?.held?.() === false) throw new Error('Foreground token lost during the action; outcome unknown, do not replay');
    } catch (cause) {
      this.#invalidate();
      const interaction = this.#interaction;
      if (interaction?.active) { interaction.finish('input-failed'); await interaction.done; }
      // Arrêt d'urgence APRÈS une entrée partielle (frappe Chromium) : l'entrée compte, l'accord reste consommé.
      if (cause.afterInput) attempts.push({ technique: 'background', outcome: 'partial', typed: cause.typed ?? null });
      cause.attempts ??= attempts;
      if (!cause.afterInput && !attempts.some(a => a.outcome !== 'not-applicable') && (cause.emergencyStop || cause.deferred || cause.refused || cause.beforeInput)) gardeFous.accords.restore(spent);
      if (cause.emergencyStop) { this.#record(spec.kind, 'stopped', Date.now() - start); throw cause; }
      if (cause.julienActive) { this.#record(spec.kind, 'julien-active', Date.now() - start); throw cause; }
      if (cause.deferred) { this.#record(spec.kind, 'deferred', Date.now() - start); throw cause; }
      if (cause.refused || cause.beforeInput) { this.#record(spec.kind, 'refused', Date.now() - start); throw cause; }
      // Entrée partie puis relecture en échec : technique et premier plan attestés gardés (relecture de Codex).
      this.#record(spec.kind, 'unknown', Date.now() - start, outcome?.technique ?? null, outcome?.foregroundTaken === true);
      throw new Error('Input or refresh outcome is unknown. Observe again before deciding; do not replay automatically.', { cause });
    }
    const verified = Boolean(spec.expect && checkExpectation(after.elements, spec.expect));
    const status = physical?.interrupted ? 'interrupted' : verified ? 'verified' : unconfirmed ? 'sent-unconfirmed' : spec.expect ? 'unmet' : 'observed';
    const result = freeze({
      status, verified: verified && !physical?.interrupted, performed: true, technique: outcome.technique, mechanism: outcome.mechanism,
      foregroundTaken: outcome.foregroundTaken, attempts, julienInput: Boolean(physical?.julienInput),
      ...(physical && Object.hasOwn(physical, 'foregroundReturned') ? { foregroundReturned: physical.foregroundReturned }
        : Object.hasOwn(outcome, 'foregroundReturned') ? { foregroundReturned: outcome.foregroundReturned } : {}),
      ...(!physical && outcome.trace ? { trace: outcome.trace } : {}),
      ...(Object.hasOwn(outcome, 'contextMenu') ? { contextMenu: outcome.contextMenu } : {}),
      ...(physical?.interrupted ? { interrupted: physical.interrupted, typed: physical.typed } : {}),
      ...(physical ? { presence: physical.presence ?? 'none', waitedMs: physical.waitedMs ?? 0 } : {}),
      windowChange: change, durationMs: Date.now() - start, observation: after,
    });
    this.#record(spec.kind, status, result.durationMs, outcome.technique, outcome.foregroundTaken === true);
    this.#results.set(result, { before, spec });
    return result;
  }
  // Une routine apprise n'est jamais un ordre : un geste à confirmer exige `confirm:true`, sur l'ordre de Julien.
  async runRecipe(observation, name, { confirm, accord } = {}) {
    this.#assertNotStopped();
    const inspected = await this.inspectRecipe(name, observation);
    if (inspected.status !== 'ready') throw new Error(`Recipe ${name} is ${inspected.status}; inspect current controls and relearn after verification`);
    const r = inspected.recipe;
    return this.act(observation, { kind: r.kind, selector: r.selector, ...(r.kind === 'secondary' ? { action: r.action } : {}), expect: r.expect, requiredStructureHash: r.structureHash, requiredRevision: r.revision, ...(confirm === true ? { confirm: true } : {}), ...(accord !== undefined ? { accord } : {}) });
  }
  async remember(name, result, { staticUI = false } = {}) {
    if (!this.#memory) throw new Error('Local application memory is not configured');
    const evidence = this.#results.get(result);
    if (!evidence || !result.verified || !result.performed) throw new Error('Only a verified transition from this session can be remembered');
    const { before, spec } = evidence;
    if (!staticUI) throw new Error('Confirm static UI labels only; never persist user content or typed text');
    if (!['click', 'secondary'].includes(spec.kind) || !spec.selector || (spec.button && spec.button !== 'left') || (spec.count && spec.count !== 1)) {
      throw new Error('Memory supports single semantic actions, never coordinates, keystrokes or typed content');
    }
    const prior = await this.#memory.read(before.window.app, name);
    await this.#memory.save(before.window.app, name, {
      kind: spec.kind, selector: spec.selector, ...(spec.action ? { action: spec.action } : {}), expect: spec.expect,
      structureHash: before.structureHash, revision: before.revision,
      verifiedAt: new Date().toISOString(), verifiedCount: (prior?.verifiedCount ?? 0) + 1,
    });
    return { name, status: 'learned', verified: true };
  }
  #record(kind, status, durationMs, technique = null, foreground = null) {
    this.#metrics.push({ kind, status, technique, durationMs, at: new Date().toISOString() });
    // Journal commun des trois Nexus Windows (shared/journal/FORMAT.md) : sans texte d'écran, jamais bloquant.
    try { writeJournal(journalLine({ session: this.#sessionId, app: this.#window?.app, kind, status, technique, durationMs, foreground })); }
    catch { /* journal : jamais bloquant */ }
  }
  metrics() { return clone(this.#metrics); }
  async saveMetrics() {
    if (!this.#root) throw new Error('Local state is not configured');
    const dir = path.join(this.#root, 'reports');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, this.#sessionId + '.json');
    const tmp = file + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(tmp, JSON.stringify({ schema: 2, sessionId: this.#sessionId, actions: this.#metrics }, null, 2), { flag: 'wx' });
      await rename(tmp, file);
    } finally {
      await unlink(tmp).catch(e => { if (e.code !== 'ENOENT') throw e; });
    }
    return file;
  }
}

export function summarize(observation) {
  return {
    token: observation.token, window: observation.window, mode: observation.mode, source: observation.source,
    windowStack: observation.windowStack, windowChange: observation.windowChange, popups: observation.popups,
    tree: observation.accessibility?.tree ?? '', focused: observation.accessibility?.focused_element ?? '',
    screenshots: observation.screenshots, images: observation.images, imageFallback: observation.imageFallback,
    ...(observation.marksNote ? { marksNote: observation.marksNote } : {}),
  };
}
