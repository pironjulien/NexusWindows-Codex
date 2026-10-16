import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename, stat, unlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import { ApplicationMemory } from './memory.mjs';
import { parseTree, uniqueElement, findElements, structureHash, stateDigest, checkExpectation, validateExpectation, digest } from './tree.mjs';
import { emergencyStop } from './stop.mjs';
import { JulienActiveError, QUIET_MS, MAX_WAIT_MS } from './presence.mjs';

const coordinators = new WeakMap();
const sameWindow = (a, b) => a.id === b.id && a.app === b.app;
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
const selectorKey = s => s && JSON.stringify(['role', 'name', 'automationId'].map(k => s[k] ?? null).concat([s.ancestor ? selectorKey(s.ancestor) : null]));
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
    .map(e => ({ role: e.role, automationId: e.automationId, name: e.name, runtimeId: e.runtimeId ?? [] }));
  return { runtimeId: target.runtimeId, ancestry, ...(target.nativeWindow ? { nativeWindow: target.nativeWindow } : {}) };
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
const BACKGROUND_KINDS = new Set(['click', 'setValue', 'typeText', 'secondary', 'select', 'menu']);
const actionFields = {
  click: ['selector', 'point', 'screenshotId', 'button', 'count'],
  setValue: ['selector', 'value'], typeText: ['focus', 'text'], key: ['key'],
  secondary: ['selector', 'action'], scroll: ['point', 'screenshotId', 'scrollX', 'scrollY'],
  drag: ['from', 'to', 'screenshotId'],
  select: ['selector', 'option'], menu: ['path'],
};
function validateAction(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec) || !Object.hasOwn(actionFields, spec.kind)) throw new Error('Unsupported action');
  const allowed = ['kind', 'expect', 'timeoutMs', 'refresh', 'requiredStructureHash', 'requiredRevision', 'fallback', ...actionFields[spec.kind]];
  if (Object.keys(spec).some(k => !allowed.includes(k))) throw new Error('Unexpected action field for ' + spec.kind);
  if (spec.expect !== undefined) validateExpectation(spec.expect);
  const trivial = trivialPostcondition(spec);
  if (trivial) throw beforeInput(TRIVIAL(trivial));
  if (spec.timeoutMs !== undefined && (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs < 0 || spec.timeoutMs > 15000)) throw new Error('timeoutMs must be between 0 and 15000');
  if (spec.refresh !== undefined && !['text', 'image', 'both'].includes(spec.refresh)) throw new Error('Invalid refresh mode');
  if (spec.fallback !== undefined && typeof spec.fallback !== 'boolean') throw new Error('fallback must be boolean');
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
  #stack = []; #seen = new Set(); #pause; #popups = [];
  constructor(sky, { stateRoot, maxAgeMs = 30000, native, emergencyStop: stop = emergencyStop(), pause = {} } = {}) {
    if (sky?.target !== 'windows') throw new Error('The supported Windows Sky API is required');
    if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0 || maxAgeMs > 60000) throw new Error('maxAgeMs must be between 1 and 60000');
    this.#sky = sky; this.#coordinator = coordinator(sky); this.maxAgeMs = maxAgeMs;
    this.#root = stateRoot; this.#memory = stateRoot ? new ApplicationMemory(stateRoot) : null; this.#native = native;
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
    try { return await fn(); } finally { this.#busy = this.#coordinator.busy = false; }
  }
  #invalidate() { this.#observation = null; this.#coordinator.epoch++; }
  async windows() { return this.#exclusive(() => this.#sky.list_windows()); }
  async #foreground(purpose, action) {
    if (!this.#native?.withForeground) throw Object.assign(new Error('Foreground token helper is required; action deferred'), { deferred: true });
    this.#assertNotStopped();
    // Le jeton peut attendre jusqu'à 8 s : contrôle de nouveau une fois acquis, juste avant l'entrée.
    return this.#native.withForeground(purpose, () => { this.#assertNotStopped(); return action(); });
  }
  async close() {
    return this.#exclusive(() => { this.#invalidate(); this.#window = null; this.#stack = []; this.#seen.clear(); this.#native?.close?.(); });
  }
  async activate() {
    return this.#exclusive(async () => {
      this.#invalidate();
      if (!this.#window) throw new Error('Bind a window first');
      this.#assertNotStopped();
      await this.#foreground('activate_window', () => this.#sky.activate_window({ window: this.#window }));
      return this.#capture('both');
    });
  }
  async bind({ id, app, title } = {}) {
    return this.#exclusive(async () => {
      this.#invalidate(); this.#window = null; this.#stack = []; this.#seen.clear(); this.#nativePreferred = false; this.#popups = [];
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
      const closed = this.#stack.pop();
      change = { reason: 'closed', from: closed.id, to: this.#stack.at(-1).id };
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
      if (!listed) continue; // Sky ne la cible pas : signalée par relatedWindows, jamais devinée
      const win = await this.#sky.get_window({ id: listed.id, app: listed.app });
      if (!sameWindow(win, listed)) continue;
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
    try { files = (await readdir(directory)).filter(f => f.endsWith('.png')); } catch { return; }
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
  async #capture(mode, backend = 'auto', { capture = 'sky', windowChange = null } = {}) {
    this.#invalidate();
    if (!this.#window) throw new Error('Bind a returned window before observing');
    if (!['text', 'image', 'both'].includes(mode)) throw new Error('mode must be text, image or both');
    if (!['auto', 'sky', 'native'].includes(backend)) throw new Error('backend must be auto, sky or native');
    if (!['sky', 'native'].includes(capture)) throw new Error('capture must be sky or native');
    if (backend === 'native' && !this.#native) throw new Error('Native UIA is not configured');
    const current = await this.#sky.get_window({ id: this.#window.id, app: this.#window.app });
    if (!sameWindow(current, this.#window)) throw new Error('Window identity changed; bind it again');
    const useNative = backend === 'native' || (backend === 'auto' && this.#nativePreferred);
    // Capture propre (PrintWindow, fenêtre recouverte, sans premier plan) ; image vide ou échec : capture Sky.
    let images = [], imageFallback = null;
    if (capture === 'native' && mode !== 'text') {
      if (!this.#native?.capture || !this.#root) imageFallback = 'Native capture is not configured';
      else {
        const directory = path.join(this.#root, 'captures');
        try {
          const shot = await this.#native.capture(current, directory);
          if (shot.blank) imageFallback = 'PrintWindow returned a uniform (blank) image';
          else images = [{ path: shot.path, width: shot.width, height: shot.height, method: shot.method, scale: shot.scale, ms: shot.ms, frame: shot.frame }];
        } catch (error) { imageFallback = error.message; }
        await this.#pruneCaptures(directory);
      }
    }
    const skyText = mode !== 'image' && !useNative;
    const skyImage = mode !== 'text' && !images.length;
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
      const native = await this.#native.inspect(state.window);
      accessibility = native.accessibility; elements = native.elements; source = 'native-uia';
      revision = native.revision;
      this.#nativePreferred = true;
    }
    else if (mode !== 'image') this.#nativePreferred = false;
    const observation = freeze({
      token: randomUUID(), epoch: this.#coordinator.epoch, capturedAt: Date.now(), mode, source, revision,
      window: clone(state.window), windowStack: this.#stack.map(w => w.id), windowChange: clone(windowChange), popups: clone(this.#popups),
      elements, structureHash: structureHash(elements),
      accessibility: clone(accessibility),
      // The provider displays images. Never copy their pixels into memory or telemetry.
      screenshots: (state.screenshots ?? []).map(({ id, width, height, originX, originY, zIndex }) =>
        ({ id, width, height, originX, originY, zIndex })),
      // Captures natives : fichiers locaux (LocalAppData) à regarder avec view_image ; jamais des cibles de coordonnées.
      images, imageFallback,
    });
    this.#observation = observation;
    return observation;
  }
  async observe({ mode = 'text', backend = 'auto', capture = 'sky' } = {}) {
    return this.#exclusive(async () => {
      const windowChange = await this.#follow(false);
      return this.#capture(mode, backend, { capture, windowChange });
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
    return this.#exclusive(() => this.#actOnce(observation, request));
  }

  // Lot d'actions vérifiées en un appel : chaque étape a sa postcondition, s'appuie sur l'observation rafraîchie par
  // l'étape précédente (réobservation interne, une observation ne sert qu'une fois) et le lot s'arrête à la première
  // étape non atteinte, inconnue, différée, interrompue par Julien ou refusée.
  async actBatch(observation, steps) {
    return this.#exclusive(async () => {
      if (!Array.isArray(steps) || !steps.length || steps.length > BATCH_MAX) throw new Error(`A batch needs 1 to ${BATCH_MAX} steps`);
      for (const [i, step] of steps.entries()) {
        try { validateAction(clone(step)); } catch (error) { throw new Error(`Step ${i}: ${error.message}`); }
        if (!step.expect) throw new Error(`Step ${i}: every batch step needs an explicit expect postcondition`);
      }
      const report = [];
      let current = observation;
      for (const [index, step] of steps.entries()) {
        const started = Date.now();
        let result;
        try { result = await this.#actOnce(current, step); }
        catch (error) {
          const status = error.emergencyStop ? 'stopped' : error.julienActive ? 'julien-active' : error.deferred ? 'deferred'
            : error.refused || error.beforeInput ? 'refused' : 'unknown';
          report.push({ index, kind: step.kind, status, error: error.message, durationMs: Date.now() - started });
          const summary = freeze({ status: 'stopped', stoppedAt: index, completed: index, steps: clone(report), observation: null });
          if (error.emergencyStop) { error.batch = summary; throw error; }
          return summary;
        }
        report.push({ index, kind: step.kind, status: result.status, verified: result.verified, performed: result.performed,
          technique: result.technique, foregroundTaken: result.foregroundTaken, julienInput: result.julienInput,
          windowChange: result.windowChange, durationMs: result.durationMs });
        current = result.observation;
        if (!['verified', 'already-satisfied'].includes(result.status) || result.julienInput) {
          return freeze({ status: 'stopped', stoppedAt: index, completed: index, steps: clone(report), observation: current });
        }
      }
      return freeze({ status: 'completed', completed: steps.length, steps: clone(report), observation: current });
    });
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
  #already(observation, start) {
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
  #backgroundPlan(spec, before, selected, coordinate) {
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
    return { op: spec.kind, args };
  }
  // Contrôles propres à l'entrée physique, faits sur l'observation qui la fonde.
  #physicalTarget(spec, original, basis) {
    if (!this.#canFallBack(spec, basis)) {
      throw beforeInput(basis.source === 'native-uia'
        ? `No background technique applies, and a native observation has no Sky index for a physical ${spec.kind}`
        : `No background technique applies for ${spec.kind}; open the control with a click and choose the item`);
    }
    if (spec.kind === 'click' && spec.selector && basis.source === 'native-uia' && ((spec.button ?? 'left') !== 'left' || (spec.count ?? 1) !== 1)) {
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
  async #physicalInput(purpose, action, { token = true } = {}) {
    const presence = this.#stop.presence;
    let waitedMs = 0;
    if (presence?.available) waitedMs = Math.round((await presence.waitForPause(this.#pause)).waitedMs);
    this.#assertNotStopped();
    let t0 = 0;
    const run = async () => {
      // Le jeton peut avoir attendu : Julien a peut-être repris la main entre-temps.
      if (presence?.available && presence.idleMs() < this.#pause.quietMs) throw new JulienActiveError(presence.idleMs());
      const injection = presence?.beginInjection?.();
      t0 = presence?.now?.() ?? 0;
      try { return await action(presence); } finally { presence?.endInjection?.(injection); }
    };
    const value = token ? await this.#foreground(purpose, run) : await run();
    return { value, waitedMs, presence: presence?.source ?? 'none', julienInput: Boolean(presence?.available && presence.since(t0)) };
  }
  async #runPhysical(spec, basis, selected, screenshot) {
    const input = { window: basis.window };
    const physical = (purpose, call) => this.#physicalInput(purpose, call).then(r => ({ ...r, outcome: { technique: 'physical:sky', mechanism: purpose, effect: 'sent', foregroundTaken: true } }));
    switch (spec.kind) {
      case 'click': {
        if (basis.source === 'native-uia' && selected) {
          let reply;
          try {
            reply = await this.#physicalInput('UIA foreground', () =>
              this.#native.call(basis.window, 'click', { selector: spec.selector, ...nativeIdentity(selected, basis), mode: 'foreground' }), { token: false });
          } catch (error) {
            if (error.notApplicable) throw beforeInput('No background or foreground UI Automation technique applies: ' + error.message);
            throw error;
          }
          const r = reply.value ?? {};
          return { ...reply, outcome: { technique: r.technique ?? 'foreground:uia', mechanism: r.mechanism ?? null, effect: r.effect ?? 'sent', foregroundTaken: r.foregroundTaken ?? null } };
        }
        Object.assign(input, selected ? { element_index: selected.index } : { screenshotId: screenshot.id, x: spec.point.x, y: spec.point.y });
        Object.assign(input, { mouse_button: spec.button ?? 'left', click_count: spec.count ?? 1 });
        return physical('Sky click', () => this.#sky.click(input));
      }
      case 'setValue':
        // Remplacement de valeur par le moteur intégré (sans jeton, comme avant) : technique sémantique de Sky.
        await this.#sky.set_value({ ...input, element_index: selected.index, value: spec.value });
        return { julienInput: false, outcome: { technique: 'sky:semantic', mechanism: 'set_value', effect: 'sent', foregroundTaken: null } };
      case 'secondary':
        if (!selected.actions.some(a => a.toLowerCase() === String(spec.action).toLowerCase())) throw beforeInput('Secondary action is not exposed by this control');
        await this.#sky.perform_secondary_action({ ...input, element_index: selected.index, action: spec.action });
        return { julienInput: false, outcome: { technique: 'sky:semantic', mechanism: 'perform_secondary_action', effect: 'sent', foregroundTaken: null } };
      case 'typeText': {
        // Frappe par tranches : si Julien reprend le clavier ou la souris, la frappe s'arrête (jamais renvoyée).
        const chunks = textChunks(spec.text);
        const r = await physical('Sky typeText', async presence => {
          let typed = 0;
          for (const chunk of chunks) {
            const c0 = presence?.now?.() ?? 0;
            await this.#sky.type_text({ ...input, text: chunk });
            typed++;
            if (typed < chunks.length) {
              if (presence?.available && presence.since(c0)) return { interrupted: 'julien', typed, total: chunks.length };
              try { this.#stop.assertClear(); } catch { return { interrupted: 'emergency-stop', typed, total: chunks.length }; }
            }
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
  async #settle(spec, coordinate) {
    const refresh = spec.refresh ?? (coordinate ? 'both' : 'text');
    let change = await this.#follow(true);
    let after = await this.#capture(spec.expect && refresh === 'image' ? 'both' : refresh, 'auto', { windowChange: change });
    if (spec.expect && !checkExpectation(after.elements, spec.expect)) {
      const deadline = Date.now() + (spec.timeoutMs ?? 1618);
      while (Date.now() < deadline && !checkExpectation(after.elements, spec.expect)) {
        await sleep(100);
        change = (await this.#follow(true)) ?? change;
        after = await this.#capture('text', 'auto', { windowChange: change }); // Wait on state only. Never repeat the input.
      }
    }
    return { after, change };
  }

  async #actOnce(observation, request) {
    const start = Date.now();
    try { this.#assertNotStopped(); }
    catch (error) { this.#record(request?.kind ?? 'unknown', 'stopped', Date.now() - start); throw error; }
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
    if (spec.expect && this.#judge(spec, original, selected)) return this.#already(original, start);
    let screenshot;
    if (coordinate) {
      screenshot = original.screenshots.find(s => s.id === spec.screenshotId);
      if (!screenshot) throw new Error('Choose a screenshotId from the inspected observation');
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
      if (spec.expect && this.#judge(spec, before, selected)) return this.#already(before, start);
    } else if (coordinate) {
      const current = await this.#sky.get_window({ id: before.window.id, app: before.window.app });
      if (!sameWindow(current, before.window)) throw new Error('Coordinate target identity changed');
    }
    const background = this.#backgroundPlan(spec, before, selected, coordinate);
    // Sans technique d'arrière-plan possible, les contrôles de l'entrée physique précèdent toute consommation.
    if (!background) selected = this.#physicalTarget(spec, original, before) ?? selected;
    await this.#markSeen();
    this.#invalidate(); // Consume BEFORE sending input, including input with unknown outcomes.
    const attempts = [];
    let outcome = null, after, change = null, physical = null;
    try {
      this.#assertNotStopped(); // Dernier point de contrôle avant l'entrée (après la relecture).
      if (background) {
        try {
          const reply = (await this.#native.call(before.window, background.op, background.args)) ?? {};
          outcome = { technique: reply.technique ?? 'background:uia', mechanism: reply.mechanism ?? null, effect: reply.effect ?? 'sent',
            foregroundTaken: reply.foregroundTaken === true, cursorMoved: reply.cursorMoved === true };
          attempts.push({ technique: outcome.technique, mechanism: outcome.mechanism, effect: outcome.effect });
        } catch (error) {
          if (!error.notApplicable) throw error;
          attempts.push({ technique: 'background', outcome: 'not-applicable', reason: error.message });
        }
      }
      if (outcome) {
        ({ after, change } = await this.#settle(spec, coordinate));
        // Repli physique seulement si l'arrière-plan n'a eu AUCUN effet relu : état relu inchangé (relecture du
        // helper, ou empreinte complète de l'état observable identique et aucune fenêtre apparue).
        if (spec.expect && !checkExpectation(after.elements, spec.expect) && spec.fallback !== false && this.#canFallBack(spec, before)) {
          const noEffect = outcome.effect === 'none' || (outcome.effect === 'sent' && !change && after.window.id === before.window.id &&
            after.source === before.source && after.structureHash === before.structureHash && stateDigest(after.elements) === stateDigest(before.elements));
          if (noEffect) {
            attempts.at(-1).outcome = 'no-effect';
            const basis = after.source === 'sky' && spec.kind === 'click' && after.mode === 'text' ? await this.#capture('both') : after;
            this.#invalidate();
            selected = this.#physicalTarget(spec, original, basis);
            before = basis; outcome = null;
          }
        }
      }
      if (!outcome) {
        if (background && attempts.at(-1)?.outcome === 'not-applicable') selected = this.#physicalTarget(spec, original, before) ?? selected;
        physical = await this.#runPhysical(spec, before, selected, screenshot);
        outcome = physical.outcome;
        attempts.push({ technique: outcome.technique, mechanism: outcome.mechanism, effect: outcome.effect });
        ({ after, change } = await this.#settle(spec, coordinate));
      }
    } catch (cause) {
      this.#invalidate();
      cause.attempts ??= attempts;
      if (cause.emergencyStop) { this.#record(spec.kind, 'stopped', Date.now() - start); throw cause; }
      if (cause.julienActive) { this.#record(spec.kind, 'julien-active', Date.now() - start); throw cause; }
      if (cause.deferred) { this.#record(spec.kind, 'deferred', Date.now() - start); throw cause; }
      if (cause.refused || cause.beforeInput) { this.#record(spec.kind, 'refused', Date.now() - start); throw cause; }
      this.#record(spec.kind, 'unknown', Date.now() - start);
      throw new Error('Input or refresh outcome is unknown. Observe again before deciding; do not replay automatically.', { cause });
    }
    const verified = Boolean(spec.expect && checkExpectation(after.elements, spec.expect));
    const status = physical?.interrupted ? 'interrupted' : verified ? 'verified' : spec.expect ? 'unmet' : 'observed';
    const result = freeze({
      status, verified: verified && !physical?.interrupted, performed: true, technique: outcome.technique, mechanism: outcome.mechanism,
      foregroundTaken: outcome.foregroundTaken, attempts, julienInput: Boolean(physical?.julienInput),
      ...(physical?.interrupted ? { interrupted: physical.interrupted, typed: physical.typed } : {}),
      ...(physical ? { presence: physical.presence ?? 'none', waitedMs: physical.waitedMs ?? 0 } : {}),
      windowChange: change, durationMs: Date.now() - start, observation: after,
    });
    this.#record(spec.kind, status, result.durationMs, outcome.technique);
    this.#results.set(result, { before, spec });
    return result;
  }
  async runRecipe(observation, name) {
    this.#assertNotStopped();
    const inspected = await this.inspectRecipe(name, observation);
    if (inspected.status !== 'ready') throw new Error(`Recipe ${name} is ${inspected.status}; inspect current controls and relearn after verification`);
    const r = inspected.recipe;
    return this.act(observation, { kind: r.kind, selector: r.selector, ...(r.kind === 'secondary' ? { action: r.action } : {}), expect: r.expect, requiredStructureHash: r.structureHash, requiredRevision: r.revision });
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
  #record(kind, status, durationMs, technique = null) {
    this.#metrics.push({ kind, status, technique, durationMs, at: new Date().toISOString() });
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
  };
}
