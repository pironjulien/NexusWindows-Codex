// La commande du paquet démarre et liste ses outils (initialize puis tools/list) par stdio, sur Windows comme sous
// Linux (annuaires MCP, CI). Helper volontairement introuvable : aucune action possible, chaque appel dit pourquoi.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS } from '../lib/mcp.mjs';

const bin = fileURLToPath(new URL('../bin/nexus-windows-codex.mjs', import.meta.url));

test('the packaged command starts, lists its tools and explains why a call cannot run', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'nexus-codex-startup-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { ...process.env, LOCALAPPDATA: home, USERPROFILE: home, HOME: home, NEXUS_SHARED_HOME: home,
    NEXUS_WINDOWS_CODEX_HELPER: path.join(home, 'absent.exe') };
  delete env.NODE_TEST_CONTEXT; // le serveur n'est pas un sous-test
  const child = spawn(process.execPath, [bin], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let buffer = '';
  const replies = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (let end; (end = buffer.indexOf('\n')) >= 0; buffer = buffer.slice(end + 1)) {
      const message = JSON.parse(buffer.slice(0, end));
      replies.get(message.id)?.(message);
    }
  });
  const rpc = (id, method, params) => new Promise(resolve => {
    replies.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const init = await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.equal(init.result.serverInfo.name, 'nexus-windows-codex');
  assert.match(init.result.serverInfo.version, /^\d+\.\d+\.\d+/);
  const list = await rpc(2, 'tools/list', {});
  assert.deepEqual(list.result.tools.map(tool => tool.name), TOOLS.map(tool => tool.name));
  const call = await rpc(3, 'tools/call', { name: 'windows', arguments: {} });
  assert.equal(call.result.isError, true);
  assert.match(call.result.content[0].text, process.platform === 'win32' ? /helper not found/ : /Windows 10 or 11 is required/);
  child.stdin.end();
});
