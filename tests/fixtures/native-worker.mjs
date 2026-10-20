// Transport fixture only: it never loads UI Automation or sends desktop input.
import { createInterface } from 'node:readline';
let count = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  count++;
  if (request.operation === 'hang') continue;
  if (request.operation === 'crash') process.exit(7);
  if (request.operation === 'malformed') { process.stdout.write('broken\n'); continue; }
  const result = request.operation === 'reject'
    ? { ok: false, message: 'provider error after possible effect' }
    : request.operation === 'stopped'
      ? { ok: false, error: 'EmergencyStopException', message: "Arrêt d'urgence demandé par Julien (Ctrl+Alt+Maj+Échap) : plus aucune action pendant encore 90 s ; ne pas contourner." }
      : { ok: true, pid: process.pid, count, value: request.value, policy: request.policyFile ?? process.env.NEXUS_GARDE_FOUS ?? null, envMarker: process.env.NEXUS_TRANSPORT_TEST ?? null };
  const response = JSON.stringify({ requestId: request.operation === 'mismatch' ? 'wrong' : request.requestId, result }) + '\n';
  if (request.operation === 'duplicate') { process.stdout.write(response + response); continue; }
  if (request.operation === 'trailing') { process.stdout.write(response + 'broken\n'); continue; }
  if (request.operation === 'chunks') {
    const bytes = Buffer.from(response);
    for (let i = 0; i < bytes.length; i += 3) {
      process.stdout.write(bytes.subarray(i, i + 3));
      await new Promise(resolve => setImmediate(resolve));
    }
  } else process.stdout.write(response);
}
