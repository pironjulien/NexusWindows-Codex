// Arrêt d'urgence commun aux agents de Julien (protocole commun emergency-stop.md).
// Une NOUVELLE version de `stop` (date + contenu) datée de moins de HOLD_S secondes fige toute action de bureau pour
// le temps restant. L'arrêt est tenu en mémoire sur une horloge monotone : ni la suppression du fichier ni un saut de
// l'horloge murale ne le lèvent, seul le temps le fait ; un nouvel appui le réarme, jamais il ne le lève.
import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Presence } from './presence.mjs';

export const HOLD_S = 120;
export const HEARTBEAT_S = 3;
export const OWNER_STALE_S = 3 * HEARTBEAT_S;
export const HOTKEY_LABEL = 'Ctrl+Alt+Maj+Échap';
const WATCH_MS = 200;
const VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? 'unknown'; }
  catch { return 'unknown'; }
})();

// Dossier commun local au poste. NEXUS_SHARED_HOME ne sert qu'aux tests : ils ne doivent jamais écrire le vrai
// `~\.nexus\stop`, qui figerait les autres agents.
export function sharedDirectory(env = typeof process === 'undefined' ? {} : process.env) {
  return env.NEXUS_SHARED_HOME || path.join(os.homedir(), '.nexus');
}

export class EmergencyStopError extends Error {
  constructor(remainingS) {
    super(stopMessage(remainingS));
    this.name = 'EmergencyStopError';
    this.emergencyStop = true;
    this.deferred = true; // Aucune entrée envoyée ; ne jamais rejouer automatiquement.
    this.remainingS = remainingS;
  }
}

export function stopMessage(remainingS) {
  return `Arrêt d'urgence demandé par Julien (${HOTKEY_LABEL}) : plus aucune action pendant encore ${Math.ceil(remainingS)} s ; ne pas contourner. ` +
    'Attendre ses instructions dans la conversation ; une action refusée ainsi ne doit jamais être rejouée.';
}

export class EmergencyStop {
  #directory; #monotonic; #wall; #latchedUntil = 0; #seen = null; #timer = null; #guard = null; #guardState = 'absent'; #busyCount = 0;
  #guardStartedAt = -Infinity; #guardExecutable = null; #guardPrefix = []; #presence;
  constructor({ directory = sharedDirectory(), monotonic = () => performance.now(), wall = () => Date.now(), watch = true } = {}) {
    this.#directory = directory; this.#monotonic = monotonic; this.#wall = wall;
    // Présence de Julien : alimentée par le même garde (Raw Input), indisponible tant qu'il ne l'a pas annoncée.
    this.#presence = new Presence({ monotonic });
    this.check();
    if (watch) {
      // Surveillance au repos : un « rm » entre deux actions ne doit pas lever l'arrêt.
      this.#timer = setInterval(() => { try { this.check(); } catch { /* le verrou déjà posé tient */ } }, WATCH_MS);
      this.#timer.unref();
    }
  }
  get directory() { return this.#directory; }
  get presence() { return this.#presence; }
  get stopFile() { return path.join(this.#directory, 'stop'); }
  get ownerFile() { return path.join(this.#directory, 'stop.owner'); }
  #latch(seconds) {
    this.#latchedUntil = Math.max(this.#latchedUntil, this.#monotonic() + seconds * 1000);
  }
  // Lit le fichier ; chaque nouvelle version pose le verrou une seule fois, pour ce qu'il lui reste d'après sa date,
  // borné à [0, HOLD_S] (une date « du futur » ne prolonge pas l'arrêt au-delà de HOLD_S).
  check() {
    let version, mtimeMs;
    try {
      const info = statSync(this.stopFile, { bigint: true });
      mtimeMs = Number(info.mtimeNs / 1000000n);
      version = info.mtimeNs.toString() + ':' + readFileSync(this.stopFile).toString('base64');
    } catch { return this.remainingS(false); } // absent ou illisible : seul le verrou compte
    if (version !== this.#seen) {
      this.#seen = version;
      const left = Math.min(Math.max(HOLD_S - (this.#wall() - mtimeMs) / 1000, 0), HOLD_S);
      if (left > 0) this.#latch(left);
    }
    return this.remainingS(false);
  }
  remainingS(read = true) {
    if (read) return this.check();
    return Math.max(this.#latchedUntil - this.#monotonic(), 0) / 1000;
  }
  // Point de contrôle avant chaque action de bureau. Les observations n'y passent pas. Il relance aussi le garde s'il
  // est mort (crash, fermeture) : sans lui, ni raccourci ni présence de Julien.
  assertClear() {
    this.#ensureGuard();
    const left = this.check();
    if (left > 0) throw new EmergencyStopError(left);
  }
  // Appui reçu par le détenteur du raccourci (processus de garde) : verrou immédiat, même si l'écriture du fichier
  // a échoué de son côté.
  pressed() { this.#latch(HOLD_S); }

  // Processus de garde .NET : détient Ctrl+Alt+Maj+Échap (RegisterHotKey) tant que ce processus Node vit, bat dans
  // stop.owner et écrit stop à l'appui. Il s'arrête à la fermeture de son entrée standard (mort du REPL).
  // `prefix` : arguments placés avant `--stop-guard` (tests : script Node qui imite le garde).
  startGuard(executable, prefix = []) {
    this.#guardExecutable = executable; this.#guardPrefix = [...prefix];
    this.#ensureGuard();
  }
  // Un garde est prévu (session réelle) : sans présence connue, aucune entrée physique ne part.
  get guardExpected() { return Boolean(this.#guardExecutable); }
  get guardState() { return this.#guardState; }
  #ensureGuard() {
    if (!this.#guardExecutable || this.#guard) return;
    if (this.#monotonic() - this.#guardStartedAt < HEARTBEAT_S * 1000) return; // relance bornée
    this.#guardStartedAt = this.#monotonic();
    let child;
    try {
      child = spawn(this.#guardExecutable, [...this.#guardPrefix, '--stop-guard', VERSION], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch { this.#guardState = 'failed'; return; }
    this.#guard = child; this.#guardState = 'starting';
    child.on('error', () => { if (this.#guard === child) { this.#guard = null; this.#guardState = 'failed'; } });
    // Garde arrêté : sa présence n'est plus connue (une inactivité supposée serait fausse).
    child.on('close', () => { if (this.#guard === child) { this.#guard = null; this.#guardState = 'exited'; this.#presence.setSource('none'); } });
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    let buffer = '';
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 65536) buffer = '';
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.event === 'stop') this.pressed();
        else if (event.event === 'hotkey') this.#guardState = event.state;
        else if (event.event === 'presence') this.#presence.setSource(event.source);
        else if (event.event === 'input') this.#presence.input({ injectedPossible: event.injectedPossible === true });
      }
    });
    // Le REPL ne doit pas rester ouvert pour son garde ; la fin du REPL ferme le tube et arrête le garde.
    child.unref(); child.stdin.unref?.(); child.stdout.unref?.();
  }
  // Logo « agent au travail » (BusyIndicator.cs, dessiné par le garde) : allumé pendant chaque action de bureau des
  // sessions de ce REPL, retiré par le garde 1,618 s après la dernière. Sans garde (tests, garde absent) : rien.
  busy(hwnd) {
    this.#ensureGuard();
    this.#busyCount++;
    this.#send(`busy ${Number.isSafeInteger(hwnd) && hwnd > 0 ? hwnd : 0}`);
  }
  idle() {
    if (this.#busyCount > 0 && --this.#busyCount === 0) this.#send('idle');
  }
  #send(line) {
    try { this.#guard?.stdin.write(`${line}\n`); } catch {} // garde parti : l'indicateur se tait, l'action continue
  }
  closeGuard() {
    const child = this.#guard; this.#guard = null; this.#guardExecutable = null;
    this.#guardState = 'absent';
    this.#presence.setSource('none');
    child?.stdin.end();
  }
  #owner() {
    try {
      const data = JSON.parse(readFileSync(this.ownerFile, 'utf8'));
      return data && typeof data === 'object' && (this.#wall() / 1000 - Number(data.ts)) <= OWNER_STALE_S ? data : null;
    } catch { return null; }
  }
  // État pour le modèle : arrêt restant et disponibilité du raccourci (détenu ici, par un autre agent vivant, ou non).
  status() {
    this.#ensureGuard();
    const remainingS = this.check();
    const owner = this.#owner();
    let hotkey;
    if (this.#guardState === 'owned') hotkey = 'détenu par ce garde NexusCodex';
    else if (owner) hotkey = `détenu par ${owner.owner ?? 'un agent'} pid ${owner.pid}`;
    else if (this.#guardState === 'disabled') hotkey = 'désactivé (dossier de test NEXUS_SHARED_HOME)';
    else hotkey = `NON GARANTI (garde ${this.#guardState}, aucun détenteur vivant) : prévenir Julien`;
    return { remainingS, stopped: remainingS > 0, hotkey, guard: this.#guardState, directory: this.#directory, presence: this.#presence.status() };
  }
  close() {
    clearInterval(this.#timer); this.#timer = null;
    this.closeGuard();
  }
}

let shared = null;
// Instance commune au processus (toutes les sessions d'un même REPL partagent l'arrêt et le garde).
export function emergencyStop() {
  shared ??= new EmergencyStop();
  return shared;
}
