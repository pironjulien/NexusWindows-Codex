// Serveur MCP autonome : protocole (initialize, tools/list, tools/call, erreurs) et fournisseur natif sans Sky.
// Session et helper factices : aucune entrée de bureau réelle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { writeFile, rm } from 'node:fs/promises';
import { serve, TOOLS, WindowsTools, PROTOCOL_VERSIONS } from '../lib/mcp.mjs';
import { nativeProvider, NoSkyError } from '../lib/native-provider.mjs';

async function exchange(tools, messages) {
  const input = new PassThrough(), output = new PassThrough();
  let text = '';
  output.setEncoding('utf8'); output.on('data', c => { text += c; });
  const done = serve({ tools, version: '9.9.9', input, output });
  for (const m of messages) input.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  input.end();
  await done;
  return text.trim().split('\n').map(line => JSON.parse(line));
}

test('initialize negotiates the version and every tool carries annotations', async () => {
  const [init, list] = await exchange({}, [
    { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { method: 'notifications/initialized' },
    { id: 2, method: 'tools/list' },
  ]);
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.version, '9.9.9');
  assert.equal(list.result.tools.length, TOOLS.length);
  for (const tool of list.result.tools) {
    assert.ok(tool.annotations?.title, tool.name);
    assert.equal(typeof tool.annotations.readOnlyHint, 'boolean', tool.name);
    assert.equal(typeof tool.annotations.destructiveHint, 'boolean', tool.name);
    assert.equal(tool.inputSchema.type, 'object', tool.name);
  }
  const [other] = await exchange({}, [{ id: 3, method: 'initialize', params: { protocolVersion: '1999-01-01' } }]);
  assert.equal(other.result.protocolVersion, PROTOCOL_VERSIONS[0]);
});

test('tool failures come back as isError results, unknown methods and tools as JSON-RPC errors', async () => {
  const tools = { async call() { throw new Error('Windows 10 or 11 is required.'); } };
  const [call, unknownTool, unknownMethod, ping] = await exchange(tools, [
    { id: 1, method: 'tools/call', params: { name: 'windows', arguments: {} } },
    { id: 2, method: 'tools/call', params: { name: 'format_disk' } },
    { id: 3, method: 'resources/list' },
    { id: 4, method: 'ping' },
  ]);
  assert.equal(call.result.isError, true);
  assert.match(call.result.content[0].text, /Windows 10 or 11/);
  assert.equal(unknownTool.error.code, -32602);
  assert.equal(unknownMethod.error.code, -32601);
  assert.deepEqual(ping.result, {});
});

test('look chooses one window, act needs a fresh look and reports marks', async () => {
  const observation = { token: 't', window: { id: 1, title: 'Notes', app: 'process:C:/notes.exe' }, elements: [], images: [], source: 'native-uia', accessibility: { tree: '0 window Notes' } };
  const calls = [];
  const session = {
    async windows() { return [{ id: 1, app: 'process:C:/notes.exe', title: 'Notes' }, { id: 2, app: 'process:C:/notes.exe', title: 'Notes 2' }]; },
    async bind(w) { calls.push(['bind', w.id]); return w; },
    async observe(options) { calls.push(['observe', options]); return observation; },
    async act(obs, action) { calls.push(['act', obs === observation, action.kind]); return { status: 'verified', technique: 'background:uia', observation: null }; },
    async actBatch() { const error = new Error('Step 1 refused'); error.batch = { status: 'stopped', steps: [{ kind: 'click', status: 'verified' }, { kind: 'key', status: 'refused', error: 'needs confirm' }] }; throw error; },
  };
  const tools = new WindowsTools(session);
  await assert.rejects(tools.call('act', { steps: [{ kind: 'click' }] }), /Look at the window first/);
  await assert.rejects(tools.call('look', { window: 'note' }), /2 windows match/);
  const seen = await tools.call('look', { window: 'Notes' });
  assert.match(seen[0].text, /^window 1 "Notes"/);
  assert.deepEqual(calls.slice(0, 2), [['bind', 1], ['observe', { mode: 'text', backend: 'native', capture: 'native', zoom: null }]]);
  const [report] = await tools.call('act', { steps: [{ kind: 'click' }] });
  assert.match(report.text, /^✓ click — verified \(background:uia\)/);
  await assert.rejects(tools.call('act', { steps: [{ kind: 'click' }] }), /Look at the window first/);
  await tools.call('look', {});
  const [batch] = await tools.call('act', { steps: [{ kind: 'click' }, { kind: 'key' }] });
  assert.match(batch.text, /✓ click — verified\n✗ key — refused: needs confirm/);
});

test('the native provider lists helper windows as native-only and never falls back to Sky', async () => {
  const activated = [];
  const native = {
    async listWindows(pid) { assert.equal(pid, 0); return { windows: [{ id: 5, app: 'process:C:/x.exe', title: 'X', pid: 42 }] }; },
    async call(window, op) { activated.push([window.id, op]); },
  };
  const provider = nativeProvider(native);
  assert.equal(provider.target, 'windows');
  const [w] = await provider.list_windows();
  assert.deepEqual(w, { id: 5, app: 'process:C:/x.exe', title: 'X', pid: 42, nativeOnly: true });
  assert.deepEqual(await provider.get_window({ id: 5, app: 'process:C:/x.exe' }), w);
  await assert.rejects(provider.get_window({ id: 6 }), /no longer listed/);
  await provider.activate_window({ window: w });
  assert.deepEqual(activated, [[5, 'activate']]);
  await assert.rejects(provider.click({}), error => error instanceof NoSkyError && error.beforeInput && error.refused);
});

test('a named window is bound again even when the session followed a dialog, and close goes to that window', async () => {
  const binds = [], closed = [];
  let current = null;
  const session = {
    async windows() { return [{ id: 10, app: 'process:C:/app.exe', title: 'Main' }]; },
    async bind(w) { binds.push(w.id); current = w.id; return { ...w }; },
    async observe() { current = 20; return { window: { id: 20, title: 'Dialog', app: 'process:C:/app.exe' }, elements: [], images: [], source: 'native-uia' }; },
    async closeWindow() { closed.push(current); return { status: 'verified', state: 'closed', prompts: [] }; },
  };
  const tools = new WindowsTools(session);
  await tools.call('look', { window: 10 }); // la session suit le dialogue 20
  const [line] = await tools.call('window', { action: 'close', window: 10 });
  assert.deepEqual(binds, [10, 10]);
  assert.deepEqual(closed, [10]);
  assert.match(line.text, /^✓ close — closed/);
});

test('arguments are checked against the schema before any action: an unknown window action never closes', async () => {
  const calls = [];
  const tools = { async call(name, args) { calls.push([name, args]); return [{ type: 'text', text: 'done' }]; } };
  const [maximize, missing, extra, badStep, ok] = await exchange(tools, [
    { id: 1, method: 'tools/call', params: { name: 'window', arguments: { action: 'maximize', window: 10 } } },
    { id: 2, method: 'tools/call', params: { name: 'window', arguments: { window: 10 } } },
    { id: 3, method: 'tools/call', params: { name: 'look', arguments: { window: 1, zoom: 2 } } },
    { id: 4, method: 'tools/call', params: { name: 'act', arguments: { steps: [{ kind: 'click', expect: { selector: { name: 'OK' }, field: 'exists' } }] } } },
    { id: 5, method: 'tools/call', params: { name: 'window', arguments: { action: 'close', window: 10 } } },
  ]);
  for (const r of [maximize, missing, extra, badStep]) {
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /^✗ \w+ — invalid arguments, nothing was sent/);
  }
  assert.deepEqual(calls, [['window', { action: 'close', window: 10 }]]);
  assert.equal(ok.result.content[0].text, 'done');
  // Appel direct (hors serveur) : l'action est relue aussi par l'outil lui-même.
  await assert.rejects(new WindowsTools({}).call('window', { action: 'maximize', window: 10 }), /only close; nothing was sent/);
});

test('malformed requests get -32600 instead of silence', async () => {
  const replies = await exchange({}, [{ id: 7, method: null }, { id: 8, method: 42 }, { id: 9 }]);
  assert.deepEqual(replies.map(r => [r.id, r.error?.code]), [[7, -32600], [8, -32600], [9, -32600]]);
  // Sans jsonrpc "2.0" : refus, jamais exécuté.
  const input = new PassThrough(), output = new PassThrough(); let out = '';
  output.setEncoding('utf8'); output.on('data', c => { out += c; });
  const done = serve({ tools: { async call() { throw new Error('must not run'); } }, version: '1', input, output });
  input.end(JSON.stringify({ id: 10, method: 'tools/call', params: { name: 'windows', arguments: {} } }) + '\n'); await done;
  assert.equal(JSON.parse(out).error.code, -32600);
});

test('launch drops the previous observation and binds a hidden Settings page for look', async () => {
  const observation = { window: { id: 1, title: 'Notes', app: 'process:C:/notes.exe' }, elements: [], images: [], source: 'native-uia' };
  const observed = [];
  const session = {
    async windows() { return [{ id: 1, app: 'process:C:/notes.exe', title: 'Notes' }]; },
    async bind(w) { return w; },
    async observe() { observed.push('observe'); return observation; },
    async launch() { return { status: 'opened', window: null, hidden: true, bindable: 'bindOpenedSettings', nativeWindow: 20 }; },
    async bindOpenedSettings() { return { id: 20, app: 'process:C:/SystemSettings.exe', title: 'Settings', nativeOnly: true, pid: 7 }; },
    async returnToRoot(id) { observed.push(['root', id]); return { id, app: 'process:C:/SystemSettings.exe', title: 'Settings', nativeOnly: true, pid: 7 }; },
  };
  const tools = new WindowsTools(session);
  await tools.call('look', { window: 1 });
  const [, detail] = await tools.call('launch', { app: 'ms-settings:display' });
  assert.match(detail.text, /"bound": 20/);
  await assert.rejects(tools.call('act', { steps: [{ kind: 'click' }] }), /Look at the window first/);
  await tools.call('look', { window: 20 }); // absente de l'inventaire, mais liée par launch
  assert.deepEqual(observed, ['observe', ['root', 20], 'observe']);
});

test('act with refresh image returns the refreshed capture', async () => {
  const dir = await import('node:fs/promises').then(fs => fs.mkdtemp(path.join(os.tmpdir(), 'nwc-')));
  const png = path.join(dir, 'after.png');
  await writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const before = { window: { id: 1, title: 'Notes', app: 'process:C:/notes.exe' }, elements: [], images: [], source: 'native-uia' };
  const after = { ...before, images: [{ path: png }] };
  const session = {
    async windows() { return [{ id: 1, app: 'process:C:/notes.exe', title: 'Notes' }]; },
    async bind(w) { return w; },
    async observe() { return before; },
    async act() { return { status: 'verified', observation: after }; },
  };
  const tools = new WindowsTools(session);
  await tools.call('look', { window: 1 });
  const content = await tools.call('act', { steps: [{ kind: 'click', refresh: 'image' }] });
  assert.ok(content.some(c => c.type === 'image' && c.mimeType === 'image/png'));
  await rm(dir, { recursive: true, force: true });
});

test('a hidden Settings root named again is brought back from a followed dialog before close', async () => {
  let current = 10;
  const closed = [];
  const session = {
    async windows() { return []; },
    async launch() { return { status: 'opened', hidden: true, bindable: 'bindOpenedSettings', nativeWindow: 10 }; },
    async bindOpenedSettings() { current = 10; return { id: 10, app: 'process:C:/SystemSettings.exe', nativeOnly: true, pid: 42 }; },
    async returnToRoot(id) { current = id; return { id, app: 'process:C:/SystemSettings.exe', nativeOnly: true, pid: 42 }; },
    async observe() { return { window: { id: current, title: 'Settings', app: 'process:C:/SystemSettings.exe' }, elements: [], images: [], source: 'native-uia' }; },
    async act() { current = 20; return { status: 'verified', observation: null }; }, // dialogue 20 suivi par la session
    async closeWindow() { closed.push(current); return { status: 'verified', state: 'closed', prompts: [] }; },
  };
  const tools = new WindowsTools(session);
  await tools.call('launch', { app: 'ms-settings:display' });
  await tools.call('look', { window: 10 });
  await tools.call('act', { steps: [{ kind: 'click' }] });
  await tools.call('window', { action: 'close', window: 10 });
  assert.deepEqual(closed, [10]);
});
