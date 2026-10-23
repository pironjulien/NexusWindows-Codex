#!/usr/bin/env node
// Commande `nexus-windows-codex` : serveur MCP autonome (stdio) de NexusWindows for Codex, sans Sky.
// Helper natif cherché dans l'ordre : NEXUS_WINDOWS_CODEX_HELPER, celui du paquet npm (native/bin, construit par la
// CI), puis celui de install.ps1 (installation.json de l'état local).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeUIA } from '../lib/native.mjs';
import { nativeProvider } from '../lib/native-provider.mjs';
import { WindowsSession } from '../lib/session.mjs';
import { emergencyStop } from '../lib/stop.mjs';
import { WindowsTools, serve } from '../lib/mcp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stateRoot = path.join(process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? '.', 'AppData', 'Local'), 'NexusCodex', 'ComputerUse');

function helperPath() {
  // Chemin imposé : lui seul (absent = aucun helper), jamais un autre trouvé à sa place.
  const forced = process.env.NEXUS_WINDOWS_CODEX_HELPER;
  if (forced) return existsSync(forced) ? forced : null;
  const candidates = [path.join(root, 'native', 'bin', 'NexusCodex.UIA.exe')];
  try { candidates.push(JSON.parse(readFileSync(path.join(stateRoot, 'installation.json'), 'utf8')).NativeExecutable); } catch { /* pas d'install.ps1 */ }
  return candidates.find(file => file && existsSync(file)) ?? null;
}

const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
// Hors Windows ou sans helper, le serveur démarre et liste ses outils (annuaires MCP qui le lancent dans un conteneur
// Linux) ; chaque appel répond la cause, rien n'est tenté.
const unavailable = reason => ({ async call() { throw new Error(reason); } });
const helper = process.platform === 'win32' ? helperPath() : null;
if (process.platform !== 'win32') {
  await serve({ tools: unavailable('NexusWindows for Codex drives the Windows desktop: Windows 10 or 11 is required.'), version });
} else if (!helper) {
  await serve({ tools: unavailable('Native helper not found: install the npm package, run install.ps1, or set NEXUS_WINDOWS_CODEX_HELPER.'), version });
} else {
  const stop = emergencyStop();
  stop.startGuard(helper);
  const native = new NativeUIA(helper, { emergencyStop: stop });
  const session = new WindowsSession(nativeProvider(native), { stateRoot, native, emergencyStop: stop, maxAgeMs: 60000 });
  await session.pruneCaptures(); // captures d'une session précédente : purgées dès le démarrage
  await serve({ tools: new WindowsTools(session), version });
  await session.close().catch(() => {});
  native.close();
}
process.exit(0);
