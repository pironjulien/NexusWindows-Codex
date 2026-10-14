import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { ApplicationMemory } from './memory.mjs';
import { parseTree, uniqueElement, structureHash, checkExpectation, validateExpectation, digest } from './tree.mjs';

const coordinators = new WeakMap();
const sameWindow = (a, b) => a.id === b.id && a.app === b.app;
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = value => structuredClone(value);
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

const actionFields = {
  click: ['selector', 'point', 'screenshotId', 'button', 'count'],
  setValue: ['selector', 'value'], typeText: ['focus', 'text'], key: ['key'],
  secondary: ['selector', 'action'], scroll: ['point', 'screenshotId', 'scrollX', 'scrollY'],
  drag: ['from', 'to', 'screenshotId'],
};
function validateAction(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec) || !Object.hasOwn(actionFields, spec.kind)) throw new Error('Unsupported action');
  const allowed = ['kind', 'expect', 'timeoutMs', 'refresh', 'requiredStructureHash', 'requiredRevision', ...actionFields[spec.kind]];
  if (Object.keys(spec).some(k => !allowed.includes(k))) throw new Error('Unexpected action field for ' + spec.kind);
  if (spec.expect !== undefined) validateExpectation(spec.expect);
  if (spec.timeoutMs !== undefined && (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs < 0 || spec.timeoutMs > 15000)) throw new Error('timeoutMs must be between 0 and 15000');
  if (spec.refresh !== undefined && !['text', 'image', 'both'].includes(spec.refresh)) throw new Error('Invalid refresh mode');
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
  #memory; #root; #metrics = []; #sessionId = randomUUID(); #native; #nativePreferred = false;
  constructor(sky, { stateRoot, maxAgeMs = 30000, native } = {}) {
    if (sky?.target !== 'windows') throw new Error('The supported Windows Sky API is required');
    if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0 || maxAgeMs > 60000) throw new Error('maxAgeMs must be between 1 and 60000');
    this.#sky = sky; this.#coordinator = coordinator(sky); this.maxAgeMs = maxAgeMs;
    this.#root = stateRoot; this.#memory = stateRoot ? new ApplicationMemory(stateRoot) : null; this.#native = native;
  }
  async #exclusive(fn) {
    if (this.#busy || this.#coordinator.busy) throw new Error('Another Windows operation is running; serialize desktop interaction');
    this.#busy = this.#coordinator.busy = true;
    try { return await fn(); } finally { this.#busy = this.#coordinator.busy = false; }
  }
  #invalidate() { this.#observation = null; this.#coordinator.epoch++; }
  async windows() { return this.#exclusive(() => this.#sky.list_windows()); }
  async close() {
    return this.#exclusive(() => { this.#invalidate(); this.#window = null; this.#native?.close?.(); });
  }
  async activate() {
    return this.#exclusive(async () => {
      this.#invalidate();
      if (!this.#window) throw new Error('Bind a window first');
      await this.#sky.activate_window({ window: this.#window });
      return this.#capture('both');
    });
  }
  async bind({ id, app, title } = {}) {
    return this.#exclusive(async () => {
      this.#invalidate(); this.#window = null; this.#nativePreferred = false;
      if (id === undefined && app === undefined && title === undefined) throw new Error('Specify a returned window id, exact app or exact title');
      const found = (await this.#sky.list_windows()).filter(w =>
        (id === undefined || id === w.id) && (app === undefined || app === w.app) && (title === undefined || title === w.title));
      if (found.length !== 1) throw new Error(`Window selection must be unique; found ${found.length}`);
      const win = await this.#sky.get_window({ id: found[0].id, app: found[0].app });
      if (!sameWindow(win, found[0])) throw new Error('Window identity changed during selection');
      this.#window = win;
      return clone(win);
    });
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
  async #capture(mode, backend = 'auto') {
    this.#invalidate();
    if (!this.#window) throw new Error('Bind a returned window before observing');
    if (!['text', 'image', 'both'].includes(mode)) throw new Error('mode must be text, image or both');
    if (!['auto', 'sky', 'native'].includes(backend)) throw new Error('backend must be auto, sky or native');
    if (backend === 'native' && !this.#native) throw new Error('Native UIA is not configured');
    const current = await this.#sky.get_window({ id: this.#window.id, app: this.#window.app });
    if (!sameWindow(current, this.#window)) throw new Error('Window identity changed; bind it again');
    const useNative = backend === 'native' || (backend === 'auto' && this.#nativePreferred);
    const state = mode === 'text' && useNative
      ? { window: current, accessibility: null, screenshots: [] }
      : await this.#sky.get_window_state({
        window: current, include_text: mode !== 'image' && !useNative, include_screenshot: mode !== 'text',
      });
    if (!sameWindow(state.window, current)) throw new Error('Capture returned another window');
    this.#window = state.window;
    let accessibility = state.accessibility;
    let elements = parseTree(accessibility?.tree);
    const focusedIndex = Number(/^\s*(\d+)\s/.exec(accessibility?.focused_element ?? '')?.[1]);
    elements = elements.map(e => ({ ...e, focused: Number.isFinite(focusedIndex) ? e.index === focusedIndex : e.flags.includes('focused') ? true : null }));
    let source = 'sky';
    let revision = await this.#getRevision(state.window.app);
    if (mode !== 'image' && this.#native && (useNative || (!elements.length && backend === 'auto'))) {
      const native = await this.#native.inspect(state.window);
      accessibility = native.accessibility; elements = native.elements; source = 'native-uia';
      revision = native.revision;
      this.#nativePreferred = true;
    }
    else if (mode !== 'image') this.#nativePreferred = false;
    const observation = freeze({
      token: randomUUID(), epoch: this.#coordinator.epoch, capturedAt: Date.now(), mode, source, revision,
      window: clone(state.window), elements, structureHash: structureHash(elements),
      accessibility: clone(accessibility),
      // The provider displays images. Never copy their pixels into memory or telemetry.
      screenshots: (state.screenshots ?? []).map(({ id, width, height, originX, originY, zIndex }) =>
        ({ id, width, height, originX, originY, zIndex })),
    });
    this.#observation = observation;
    return observation;
  }
  async observe({ mode = 'text', backend = 'auto' } = {}) { return this.#exclusive(() => this.#capture(mode, backend)); }
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
    return this.#exclusive(async () => {
      const start = Date.now();
      const original = this.#take(observation);
      const spec = clone(request);
      validateAction(spec);
      const coordinate = spec.point !== undefined || spec.kind === 'scroll' || spec.kind === 'drag';
      if (spec.selector && coordinate) throw new Error('Choose a semantic selector or screenshot coordinates');
      if (spec.kind === 'typeText' && !spec.focus) throw new Error('typeText requires a focus selector from the observed editable surface');
      let selected;
      if (spec.selector) selected = uniqueElement(original.elements, spec.selector);
      if (['setValue', 'secondary'].includes(spec.kind) && !selected) throw new Error('A semantic target is required');
      if (spec.kind === 'click' && !selected && !coordinate) throw new Error('Click requires an observed semantic or coordinate target');
      if (spec.kind === 'typeText') uniqueElement(original.elements, spec.focus);
      if (spec.expect && checkExpectation(original.elements, spec.expect)) {
        return freeze({ status: 'already-satisfied', verified: false, performed: false, observation: original });
      }
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
      if (!coordinate) {
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
          const focusIndex = Number(/^\s*(\d+)\s/.exec(before.accessibility?.focused_element ?? '')?.[1]);
          if (focusIndex !== focused.index) throw new Error('Observed editable surface does not have keyboard focus');
          if (!['edit', 'document'].includes(focused.role)) throw new Error('Focus target is not an editable surface');
        }
        if (spec.expect && checkExpectation(before.elements, spec.expect)) {
          return freeze({ status: 'already-satisfied', verified: false, performed: false, observation: before });
        }
      } else {
        const current = await this.#sky.get_window({ id: before.window.id, app: before.window.app });
        if (!sameWindow(current, before.window)) throw new Error('Coordinate target identity changed');
      }
      const input = { window: before.window };
      let call;
      switch (spec.kind) {
        case 'click': {
          Object.assign(input, selected ? { element_index: selected.index } : { screenshotId: screenshot.id, x: spec.point.x, y: spec.point.y });
          Object.assign(input, { mouse_button: spec.button ?? 'left', click_count: spec.count ?? 1 });
          if (selected && before.source === 'native-uia') {
            if ((spec.button ?? 'left') !== 'left' || (spec.count ?? 1) !== 1) throw new Error('Native semantic actions require one left click; observe a screenshot for other clicks');
            call = () => this.#native.call(before.window, 'click', { selector: spec.selector, runtimeId: selected.runtimeId });
          } else call = () => this.#sky.click(input);
          break;
        }
        case 'setValue':
          Object.assign(input, { element_index: selected.index, value: spec.value });
          call = before.source === 'native-uia'
            ? () => this.#native.call(before.window, 'setValue', { selector: spec.selector, runtimeId: selected.runtimeId, value: spec.value })
            : () => this.#sky.set_value(input);
          break;
        case 'typeText':
          input.text = spec.text; call = () => this.#sky.type_text(input); break;
        case 'key':
          input.key = spec.key; call = () => this.#sky.press_key(input); break;
        case 'secondary':
          if (!selected.actions.some(a => a.toLowerCase() === String(spec.action).toLowerCase())) throw new Error('Secondary action is not exposed by this control');
          Object.assign(input, { element_index: selected.index, action: spec.action });
          call = before.source === 'native-uia'
            ? () => this.#native.call(before.window, 'secondary', { selector: spec.selector, runtimeId: selected.runtimeId, action: spec.action })
            : () => this.#sky.perform_secondary_action(input);
          break;
        case 'scroll':
          Object.assign(input, { screenshotId: screenshot.id, x: spec.point.x, y: spec.point.y, scrollX: spec.scrollX ?? 0, scrollY: spec.scrollY ?? 0 });
          call = () => this.#sky.scroll(input); break;
        case 'drag':
          Object.assign(input, { screenshotId: screenshot.id, from_x: spec.from.x, from_y: spec.from.y, to_x: spec.to.x, to_y: spec.to.y });
          call = () => this.#sky.drag(input); break;
      }
      this.#invalidate(); // Consume BEFORE sending input, including input with unknown outcomes.
      let after;
      try {
        await call();
        const refresh = spec.refresh ?? (coordinate ? 'both' : 'text');
        after = await this.#capture(spec.expect && refresh === 'image' ? 'both' : refresh);
        if (spec.expect && !checkExpectation(after.elements, spec.expect)) {
          const deadline = Date.now() + (spec.timeoutMs ?? 1618);
          while (Date.now() < deadline && !checkExpectation(after.elements, spec.expect)) {
            await new Promise(resolve => setTimeout(resolve, 100));
            after = await this.#capture('text'); // Wait on state only. Never repeat the input.
          }
        }
      } catch (cause) {
        this.#invalidate();
        this.#record(spec.kind, 'unknown', Date.now() - start);
        throw new Error('Input or refresh outcome is unknown. Observe again before deciding; do not replay automatically.', { cause });
      }
      const verified = Boolean(spec.expect && checkExpectation(after.elements, spec.expect));
      const status = verified ? 'verified' : spec.expect ? 'unmet' : 'observed';
      const result = freeze({ status, verified, performed: true, durationMs: Date.now() - start, observation: after });
      this.#record(spec.kind, status, result.durationMs);
      this.#results.set(result, { before, spec });
      return result;
    });
  }
  async runRecipe(observation, name) {
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
  #record(kind, status, durationMs) {
    this.#metrics.push({ kind, status, durationMs, at: new Date().toISOString() });
  }
  metrics() { return clone(this.#metrics); }
  async saveMetrics() {
    if (!this.#root) throw new Error('Local state is not configured');
    const dir = path.join(this.#root, 'reports');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, this.#sessionId + '.json');
    const tmp = file + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(tmp, JSON.stringify({ schema: 1, sessionId: this.#sessionId, actions: this.#metrics }, null, 2), { flag: 'wx' });
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
    tree: observation.accessibility?.tree ?? '', focused: observation.accessibility?.focused_element ?? '',
    screenshots: observation.screenshots,
  };
}
