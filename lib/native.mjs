import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { emergencyStop } from './stop.mjs';
import { policyPath } from './garde-fous.mjs';

// Refus du helper pour arrêt d'urgence : aucune entrée envoyée, à ne jamais rejouer.
const stopRefusal = (message, error) => error === 'EmergencyStopException'
  ? Object.assign(new Error(message), { name: 'EmergencyStopError', emergencyStop: true, deferred: true })
  : null;

// Erreurs du helper. « notApplicable » : aucune entrée envoyée, la technique suivante est permise. « refused » : aucune
// entrée envoyée et aucun repli (mot de passe, application exclue, identité changée, fenêtre fermée, cible désactivée).
// « julienActive » : Julien a repris clavier ou souris pendant l'attente du jeton, rien n'a été envoyé. Toute autre
// erreur d'action peut suivre une entrée : résultat inconnu, jamais rejoué.
function nativeError({ message, error }) {
  return Object.assign(new Error(message || 'Native UIA failed'), {
    nativeError: error ?? null,
    deferred: error === 'TimeoutException' || error === 'JulienActiveException',
    julienActive: error === 'JulienActiveException',
    notApplicable: error === 'BackgroundNotApplicableException' || error === 'CaptureUnavailableException',
    refused: error === 'ActionRefusedException',
  });
}

// Délais bornés par le helper lui-même : attente du jeton (ForegroundToken.cs) et action UI Automation dans l'enfant
// --com-worker (ComBridge, ComWorker.cs). Le délai Node les dépasse toujours d'une marge : sinon Node tuerait le helper
// en pleine action alors que le helper l'aurait encore bornée et rapportée lui-même.
export const TOKEN_WAIT_MS = 8000, COM_ACTION_MS = 10000, MARGIN_MS = 1618;
export const ACTION_TIMEOUT_MS = COM_ACTION_MS + MARGIN_MS;
export const FOREGROUND_TIMEOUT_MS = TOKEN_WAIT_MS + COM_ACTION_MS + MARGIN_MS;

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
    // Politique commune des garde-fous : le helper refuse toute requête sans elle (échec fermé).
    const env = { ...process.env, NEXUS_GARDE_FOUS: policyPath() };
    const child = spawn(this.executable, this.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env });
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
          else pending.reject(stopRefusal(response.result.message, response.result.error) ?? nativeError(response.result));
        } catch (error) { fail(error); return; }
      }
    });
    return child;
  }
  call(window, operation, args = {}) {
    if (this.#pending) return Promise.reject(new Error('Another native UIA request is running'));
    if (!['inspect', 'capture', 'related', 'probe', 'windows'].includes(operation)) {
      try { this.#assertNotStopped(); } catch (error) { return Promise.reject(error); }
    }
    const id = randomUUID();
    const data = JSON.stringify({ ...args, requestId: id, operation, windowId: window.id, app: window.app });
    if (data.length > 262144) return Promise.reject(new Error('Native UIA request is too large'));
    clearTimeout(this.#idle); this.#idle = null;
    // Action au premier plan : le helper attend d'abord le jeton (8 s au plus), puis agit (10 s au plus).
    const timeoutMs = args.mode === 'foreground' ? Math.max(this.timeoutMs, FOREGROUND_TIMEOUT_MS) : this.timeoutMs;
    return new Promise((resolve, reject) => {
      const child = this.#child ?? this.#start();
      const timer = setTimeout(() => this.#stop(new Error('Native UIA timed out; any input outcome is unknown. Reobserve, never replay automatically.')), timeoutMs);
      this.#pending = { id, resolve, reject, timer };
      child.stdin.write(data + '\n');
    });
  }
  inspect(window) { return this.call(window, 'inspect'); }
  // Lectures sans entrée (permises pendant l'arrêt d'urgence).
  capture(window, directory) { return this.call(window, 'capture', { directory }); }
  related(window) { return this.call(window, 'related'); }
  probe() { return this.call({ id: 0, app: '' }, 'probe'); }
  listWindows(processId) { return this.call({ id: 0, app: '' }, 'windows', { processId }); }
  // Jeton commun de premier plan (protocole commun foreground-token.md). Le helper note la fenêtre active de Julien
  // dès le jeton pris ; à la fin de l'action, toujours sous le jeton, il la remet devant si la fenêtre cible
  // (`window`) tient encore le premier plan, jamais si Julien est passé à une autre fenêtre. `onRelease` reçoit l'état :
  // restored, not-taken, kept-by-julien, refused, none ; null si le helper ne l'a pas dit.
  async withForeground(purpose, action, { window, onRelease } = {}) {
    this.#assertNotStopped();
    const target = Number.isSafeInteger(window?.id) && window.id > 0 ? [String(window.id)] : [];
    const child = spawn(this.executable, [...this.tokenArgs, '--foreground-token', purpose, ...target], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    let lost = false, started = false, buffer = '', ready = null, release = null;
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
      return await action();
    } catch (error) {
      if (!started) error.deferred = true;
      throw error;
    } finally {
      // Fin de l'action : le helper rend la fenêtre de Julien sous le jeton, puis rend le jeton. Attendre sa sortie,
      // y compris après un échec de l'action.
      child.stdin.end();
      await exited;
      if (started) {
        try { release = JSON.parse(lines.at(-1) ?? '{}').giveBack ?? null; } catch { release = null; }
        onRelease?.(release);
      }
    }
  }
}
