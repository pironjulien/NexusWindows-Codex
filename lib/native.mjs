import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export class NativeUIA {
  #child; #pending; #idle;
  constructor(executable, { timeoutMs = 10000, idleTimeoutMs = 30000, args = ['--server'] } = {}) {
    for (const value of [timeoutMs, idleTimeoutMs]) {
      if (!Number.isFinite(value) || value <= 0 || value > 60000) throw new Error('Native worker timeouts must be between 1 and 60000 ms');
    }
    this.executable = executable; this.timeoutMs = timeoutMs; this.idleTimeoutMs = idleTimeoutMs; this.args = args;
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
          else pending.reject(new Error(response.result.message || 'Native UIA failed'));
        } catch (error) { fail(error); return; }
      }
    });
    return child;
  }
  call(window, operation, args = {}) {
    if (this.#pending) return Promise.reject(new Error('Another native UIA request is running'));
    const id = randomUUID();
    const data = JSON.stringify({ ...args, requestId: id, operation, windowId: window.id, app: window.app });
    if (data.length > 262144) return Promise.reject(new Error('Native UIA request is too large'));
    clearTimeout(this.#idle); this.#idle = null;
    return new Promise((resolve, reject) => {
      const child = this.#child ?? this.#start();
      const timer = setTimeout(() => this.#stop(new Error('Native UIA timed out; any input outcome is unknown. Reobserve, never replay automatically.')), this.timeoutMs);
      this.#pending = { id, resolve, reject, timer };
      child.stdin.write(data + '\n');
    });
  }
  inspect(window) { return this.call(window, 'inspect'); }
}
