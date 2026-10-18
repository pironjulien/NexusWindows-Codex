// Présence de Julien au clavier et à la souris, alimentée par le garde .NET (`--stop-guard`).
// Source « raw-input » : seules les entrées physiques arrivent (les injections, dont celles de Sky, n'ont pas de
// périphérique d'origine). Source « last-input-info » (repli) : toute entrée arrive, et les événements reçus pendant
// une injection de cette session (plus une marge) sont écartés. Aucune touche ni position n'est lue ni gardée :
// seulement l'instant de la dernière entrée.
export const QUIET_MS = 1618;     // pause demandée avant une entrée physique (nombre d'or, en secondes)
export const MAX_WAIT_MS = 8000;  // au-delà, l'entrée physique est différée (rien n'est envoyé)
const INJECTION_TAIL_MS = 300;

export class JulienActiveError extends Error {
  constructor(idleMs) {
    super(`Julien utilise le clavier ou la souris (dernière entrée il y a ${Math.round(idleMs)} ms) : entrée physique différée, rien n'a été envoyé. Réobserver plus tard ; ne jamais rejouer automatiquement.`);
    this.name = 'JulienActiveError';
    this.deferred = true;
    this.julienActive = true;
  }
}

// Garde prévu mais présence inconnue (garde arrêté ou en cours de relance) : une inactivité supposée serait fausse.
export class PresenceUnknownError extends Error {
  constructor(guard) {
    super(`Présence de Julien inconnue (garde de l'arrêt d'urgence : ${guard}, relance en cours) : entrée physique différée, rien n'a été envoyé. Réobserver dans quelques secondes ; ne jamais rejouer automatiquement.`);
    this.name = 'PresenceUnknownError';
    this.deferred = true;
    this.presenceUnknown = true;
  }
}

export class Presence {
  #monotonic; #source = 'none'; #since = null; #last = -Infinity; #injections = [];
  constructor({ monotonic = () => performance.now() } = {}) { this.#monotonic = monotonic; }
  get source() { return this.#source; }
  get available() { return this.#source === 'raw-input' || this.#source === 'last-input-info'; }
  setSource(source) {
    if (!['raw-input', 'last-input-info', 'none'].includes(source)) return;
    this.#source = source;
    this.#since ??= this.#monotonic();
  }
  // Entrée signalée par le garde. Avec GetLastInputInfo, une entrée pendant nos propres injections est la nôtre.
  input({ injectedPossible = false, at = this.#monotonic() } = {}) {
    if ((injectedPossible || this.#source === 'last-input-info') &&
        this.#injections.some(([start, end]) => at >= start && at <= end + INJECTION_TAIL_MS)) return false;
    this.#last = Math.max(this.#last, at);
    return true;
  }
  // Fenêtre d'injection de cette session (entrée physique Sky en cours) : ouverte avant l'entrée, fermée après.
  beginInjection() {
    const horizon = this.#monotonic() - 60000;
    this.#injections = this.#injections.filter(([, e]) => e >= horizon);
    const entry = [this.#monotonic(), Infinity];
    this.#injections.push(entry);
    return entry;
  }
  endInjection(entry) { if (entry) entry[1] = this.#monotonic(); }
  now() { return this.#monotonic(); }
  // Inactivité connue : depuis la dernière entrée, sinon depuis le début de l'écoute (rien n'est supposé avant).
  idleMs() {
    if (!this.available) return null;
    const reference = Number.isFinite(this.#last) ? this.#last : this.#since;
    return Math.max(0, this.#monotonic() - reference);
  }
  since(moment) { return this.#last > moment; }
  status() {
    return { source: this.#source, available: this.available, idleMs: this.idleMs() };
  }
  // Attend une pause de quietMs avant une entrée physique ; Julien toujours actif après maxWaitMs : différé.
  async waitForPause({ quietMs = QUIET_MS, maxWaitMs = MAX_WAIT_MS, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
    if (!this.available) return { waitedMs: 0, source: this.#source, idleMs: null };
    const start = this.#monotonic();
    for (;;) {
      const idle = this.idleMs();
      if (idle >= quietMs) return { waitedMs: this.#monotonic() - start, source: this.#source, idleMs: idle };
      if (this.#monotonic() - start >= maxWaitMs) throw new JulienActiveError(idle);
      await sleep(Math.min(Math.max(quietMs - idle, 20), 200));
    }
  }
}
