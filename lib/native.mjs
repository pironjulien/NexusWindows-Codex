import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { emergencyStop } from './stop.mjs';
import { policyPath } from './garde-fous.mjs';

// Arrêt d'urgence rapporté par le helper : avant toute entrée (refus, rien d'envoyé), ou APRÈS une entrée partielle
// (« Emergency stop after input: k of n characters sent ») : issue inconnue, accord consommé, jamais rejoué.
export const stopRefusal = (message, error, inputStarted = false) => {
  if (error !== 'EmergencyStopException') return null;
  const partial = /^Emergency stop after input: (\d+) of (\d+) characters sent/.exec(message ?? '');
  const after = Boolean(partial) || inputStarted === true; // helper : entrée déjà partie (inputStarted)
  return Object.assign(new Error(message), { name: 'EmergencyStopError', emergencyStop: true, deferred: !after,
    ...(after ? { afterInput: true } : {}),
    ...(partial ? { typed: { characters: Number(partial[1]), total: Number(partial[2]) } } : {}) });
};

// Erreurs du helper. « notApplicable » : aucune entrée envoyée, la technique suivante est permise. « refused » : aucune
// entrée envoyée et aucun repli (mot de passe, application exclue, identité changée, fenêtre fermée, cible désactivée).
// « julienActive » : Julien a repris clavier ou souris pendant l'attente du jeton, rien n'a été envoyé. Toute autre
// erreur d'action peut suivre une entrée : résultat inconnu, jamais rejoué.
// inputStarted (helper) : une entrée est déjà partie ; aucune de ces natures « rien n'a été envoyé » ne s'applique plus,
// l'issue est inconnue et terminale (relecture de Codex du 24/10 : sinon un repli physique rejouait le geste).
function nativeError({ message, error, inputStarted }) {
  const after = inputStarted === true;
  return Object.assign(new Error(message || 'Native UIA failed'), {
    nativeError: error ?? null,
    deferred: !after && (error === 'TimeoutException' || error === 'JulienActiveException'),
    julienActive: !after && error === 'JulienActiveException',
    notApplicable: !after && (error === 'BackgroundNotApplicableException' || error === 'CaptureUnavailableException'),
    refused: !after && error === 'ActionRefusedException',
    ...(after ? { afterInput: true } : {}),
  });
}

// Délais bornés par le helper lui-même : attente du jeton (ForegroundToken.cs) et action UI Automation dans l'enfant
// --com-worker (ComBridge, ComWorker.cs). Le délai Node les dépasse toujours d'une marge : sinon Node tuerait le helper
// en pleine action alors que le helper l'aurait encore bornée et rapportée lui-même.
export const TOKEN_WAIT_MS = 8000, COM_ACTION_MS = 10000, MARGIN_MS = 1618;
export const ACTION_TIMEOUT_MS = COM_ACTION_MS + MARGIN_MS;
export const FOREGROUND_TIMEOUT_MS = TOKEN_WAIT_MS + COM_ACTION_MS + MARGIN_MS;
// Actions d'arrière-plan qui peuvent tenir le jeton (gestes postés au point, touches, activation simulée Chromium :
// ChromiumInput.Budget, 9 s après le jeton) puis nettoyer (désactivation, premier plan rendu) : le délai Node couvre
// jeton + voie complète + nettoyage, sinon il tuerait le helper avant son `finally` (relecture de Codex du 22/10).
export const CHROMIUM_BUDGET_MS = 9000, CLEANUP_MS = 1000;
export const TOKEN_ACTION_TIMEOUT_MS = TOKEN_WAIT_MS + Math.max(COM_ACTION_MS, CHROMIUM_BUDGET_MS) + CLEANUP_MS + MARGIN_MS;
// Lancement : jeton (8 s), attente des nouvelles fenêtres (15 s), puis premier plan rendu et relecture finale ; le délai
// Node couvre tout, sinon il tuerait le helper avant son `finally` (relecture de Codex du 23/10).
export const LAUNCH_WAIT_MS = 15000;
export const LAUNCH_TIMEOUT_MS = TOKEN_WAIT_MS + LAUNCH_WAIT_MS + CLEANUP_MS + MARGIN_MS;
const READ_ONLY = new Set(['inspect', 'probe', 'windows', 'related', 'capture', 'listWindows', 'alive']);
export function actionTimeoutMs(operation, args, base) {
  if (args?.mode === 'foreground') return Math.max(base, FOREGROUND_TIMEOUT_MS);
  if (operation === 'launch' || operation === 'openSettings') return Math.max(base, LAUNCH_TIMEOUT_MS);
  return READ_ONLY.has(operation) ? base : Math.max(base, TOKEN_ACTION_TIMEOUT_MS);
}

export class NativeUIA {
  #child; #pending; #idle;
  // `tokenArgs` : arguments placés avant `--foreground-token` (tests : script Node qui imite le helper).
  constructor(executable, { timeoutMs = ACTION_TIMEOUT_MS, idleTimeoutMs = 30000, args = ['--server'], tokenArgs = [], emergencyStop: stop } = {}) {
    for (const value of [timeoutMs, idleTimeoutMs]) {
      if (!Number.isFinite(value) || value <= 0 || value > 60000) throw new Error('Native worker timeouts must be between 1 and 60000 ms');
    }
    this.executable = executable; this.timeoutMs = timeoutMs; this.idleTimeoutMs = idleTimeoutMs; this.args = args; this.tokenArgs = tokenArgs;
    this.stop = stop ?? null; // null : instance commune du processus, créée à la première action
  }
  #assertNotStopped() {
    (this.stop ??= emergencyStop()).assertClear();
  }
  #stop(error) {
    clearTimeout(this.#idle); this.#idle = null;
    const child = this.#child; this.#child = null;
    const pending = this.#pending; this.#pending = null;
    if (pending) { clearTimeout(pending.timer); pending.reject(error); }
    child?.kill();
  }
  close() { this.#stop(new Error('Native UIA worker closed; any pending input outcome is unknown')); }
  #start() {
    // Hériter de l'environnement natif même dans le REPL, sans global process.
    // La politique obligatoire est fournie dans chaque requête du protocole.
    const child = spawn(this.executable, this.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.#child = child;
    child.stdout.setEncoding('utf8');
    let buffer = '';
    const fail = error => { if (this.#child === child) this.#stop(error); };
    child.on('error', fail); child.stdin.on('error', fail);
    // Error text is sent in the bounded JSON response. Drain stderr without retaining UI content.
    child.stderr.resume();
    child.on('close', () => fail(new Error('Native UIA worker exited; any pending input outcome is unknown')));
    child.stdout.on('data', chunk => {
      if (this.#child !== child) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > 8 * 1024 * 1024) {
        fail(new Error('Native UIA observation exceeds 8 MiB')); return;
      }
      const end = buffer.indexOf('\n');
      if (end >= 0) {
        try {
          // Exactly one reply is allowed for the one outstanding request. Validate
          // the whole received frame before settling a possibly successful action.
          if (end !== buffer.length - 1) throw new Error('Unexpected trailing native UIA response; outcome is unknown');
          const line = buffer.slice(0, end); buffer = '';
          const response = JSON.parse(line);
          const pending = this.#pending;
          if (!pending || response.requestId !== pending.id || typeof response.result?.ok !== 'boolean') {
            throw new Error('Native UIA response identity is invalid; outcome is unknown');
          }
          this.#pending = null; clearTimeout(pending.timer);
          this.#idle = setTimeout(() => this.close(), this.idleTimeoutMs);
          this.#idle.unref();
          if (response.result.ok) pending.resolve(response.result);
          else pending.reject(stopRefusal(response.result.message, response.result.error, response.result.inputStarted) ?? nativeError(response.result));
        } catch (error) { fail(error); return; }
      }
    });
    return child;
  }
  call(window, operation, args = {}) {
    if (this.#pending) return Promise.reject(new Error('Another native UIA request is running'));
    if (!['inspect', 'capture', 'related', 'probe', 'windows', 'alive'].includes(operation)) {
      try { this.#assertNotStopped(); } catch (error) { return Promise.reject(error); }
    }
    const id = randomUUID();
    // Fenêtre attestée par le helper seul (absente de Sky) : son processus et son propriétaire sont imposés au helper,
    // qui refuse toute requête si l'un a changé (relecture de Codex du 22/10).
    const identity = window.nativeOnly ? { expectedPid: window.pid, expectedOwner: window.owner, expectedAnchor: window.anchor } : {};
    const data = JSON.stringify({ ...args, ...identity, requestId: id, operation, windowId: window.id, app: window.app, policyFile: policyPath() });
    if (data.length > 262144) return Promise.reject(new Error('Native UIA request is too large'));
    clearTimeout(this.#idle); this.#idle = null;
    // Action au premier plan, ou d'arrière-plan qui peut tenir le jeton : jeton (8 s au plus), voie, nettoyage.
    const timeoutMs = actionTimeoutMs(operation, args, this.timeoutMs);
    return new Promise((resolve, reject) => {
      const child = this.#child ?? this.#start();
      const timer = setTimeout(() => this.#stop(new Error('Native UIA timed out; any input outcome is unknown. Reobserve, never replay automatically.')), timeoutMs);
      this.#pending = { id, resolve, reject, timer };
      child.stdin.write(data + '\n');
    });
  }
  inspect(window) { return this.call(window, 'inspect'); }
  // Lectures sans entrée (permises pendant l'arrêt d'urgence).
  // marks : numéros à dessiner ({ marks: [{index, bounds, scope}], treeFrame }), lus avec l'arbre juste avant (session.mjs).
  capture(window, directory, zoom, marks = null) { return this.call(window, 'capture', { directory, ...(zoom ? { zoom } : {}), ...(marks ?? {}) }); }
  related(window) { return this.call(window, 'related'); }
  alive(window) { return this.call(window, 'alive'); }
  // Page des Paramètres (ms-settings: seul), ouverte sous le jeton et premier plan rendu ; rend la fenêtre notée.
  openSettings(uri, options = {}) { return this.call({ id: 0, app: '' }, 'openSettings', { uri, ...options }); }
  probe() { return this.call({ id: 0, app: '' }, 'probe'); }
  launch(target, options = {}) { return this.call({ id: 0, app: '' }, 'launch', { target, ...options }); }
  listWindows(processId) { return this.call({ id: 0, app: '' }, 'windows', { processId }); }
  // Jeton commun de premier plan (protocole commun foreground-token.md). Le helper note la fenêtre active de Julien
  // dès le jeton pris ; à la fin de l'action, toujours sous le jeton, il la remet devant si la fenêtre cible
  // (`window`) tient encore le premier plan, jamais si Julien est passé à une autre fenêtre. `onRelease` reçoit l'état :
  // restored, not-taken, kept-by-julien, refused, none ; null si le helper ne l'a pas dit.
  // `keep` : appelé à la fin ; vrai = Julien a repris la main pendant l'action, le helper ne rend rien (« keep »).
  async withForeground(purpose, action, { window, onRelease, keep } = {}) {
    this.#assertNotStopped();
    const target = Number.isSafeInteger(window?.id) && window.id > 0 ? [String(window.id)] : [];
    const child = spawn(this.executable, [...this.tokenArgs, '--foreground-token', purpose, ...target], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    // `acknowledged` : accusé terminal du helper (« released ») ; seul il prouve une libération normale. Une fermeture
    // sans lui est une perte, même notifiée tard par une boucle Node occupée (relecture de Codex, 21/10).
    let lost = false, acknowledged = false, failed = false, started = false, buffer = '', ready = null, release = null;
    const lines = [];
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 8192) { buffer = ''; ready?.(new Error('Invalid foreground token response')); child.kill(); return; }
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        lines.push(line);
        if (lines.length === 1) ready?.(null, line);
        else { try { if (JSON.parse(line).released === true) acknowledged = true; } catch { /* ligne illisible : pas d'accusé */ } }
      }
    });
    const exited = new Promise(resolve => child.once('close', () => { lost = true; resolve(); }));
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('Foreground token acquisition timed out; action deferred')); }, TOKEN_WAIT_MS + 1500);
        ready = (error, line) => {
          clearTimeout(timer); ready = null;
          if (error) return reject(error);
          try {
            const response = JSON.parse(line);
            if (response.ok === true) resolve();
            else reject(stopRefusal(response.message, response.error) ?? new Error(response.message || 'Foreground action deferred'));
          } catch (parseError) { reject(parseError); }
        };
        child.once('error', error => ready?.(error));
        child.once('close', () => ready?.(new Error('Foreground token helper exited; action deferred')));
      });
      if (lost) throw new Error('Foreground token lost; action deferred');
      started = true;
      // `held()` : faux dès que le helper a disparu sans accusé de libération (perte, verrou libéré). Vie du processus
      // relue au système (signal 0 sur l'objet enfant, sans le global `process`, absent du REPL Codex) : une boucle
      // Node occupée retarde l'évènement « close », pas cette réponse (relecture de Codex, 21/10).
      const alive = () => { try { return child.kill(0) === true; } catch { return false; } };
      const value = await action({ held: () => acknowledged || (!lost && alive()) });
      // Helper perdu PENDANT l'action : une entrée a pu partir sans jeton ; résultat inconnu, jamais rejoué.
      if (!acknowledged && (lost || !alive())) throw new Error('Foreground token lost during the action; outcome unknown, do not replay');
      return value;
    } catch (error) {
      failed = true;
      if (!started) error.deferred = true;
      throw error;
    } finally {
      // Fin de l'action : le helper rend la fenêtre de Julien sous le jeton, puis rend le jeton. Attendre sa sortie,
      // y compris après un échec de l'action.
      let kept = false;
      try { kept = started && keep?.() === true; } catch { kept = false; }
      child.stdin.end(kept ? 'keep\n' : undefined);
      await exited;
      if (started) {
        try { release = JSON.parse(lines.at(-1) ?? '{}').giveBack ?? null; } catch { release = null; }
        onRelease?.(release);
        // Sortie sans accusé : le helper était déjà perdu (sa fermeture arrivée après l'action) ; jamais un succès.
        if (!acknowledged && !failed) throw new Error('Foreground token lost during the action; outcome unknown, do not replay');
      }
    }
  }
}
