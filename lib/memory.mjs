import { mkdir, readFile, writeFile, rename, unlink, open, stat, link } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, validateSelector, validateExpectation } from './tree.mjs';

function validateRecord(data, app, name) {
  const fields = ['schema', 'appHash', 'name', 'structureHash', 'revision', 'kind', 'selector', 'expect', 'verifiedAt', 'verifiedCount', 'action'];
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(k => !fields.includes(k)) ||
      data.schema !== 1 || data.appHash !== digest(app) || data.name !== name || !/^[a-f0-9]{64}$/.test(data.structureHash) ||
      (data.revision !== null && (typeof data.revision !== 'string' || !/^[a-f0-9]{64}$/.test(data.revision))) ||
      !Number.isSafeInteger(data.verifiedCount) || data.verifiedCount < 1 ||
      typeof data.verifiedAt !== 'string' || !Number.isFinite(Date.parse(data.verifiedAt))) {
    throw new Error('Invalid application memory; inspect or relearn it');
  }
  if (!['click', 'secondary'].includes(data.kind)) throw new Error('Unsupported learned action');
  validateSelector(data.selector); validateExpectation(data.expect);
  if (data.kind === 'secondary' ? typeof data.action !== 'string' || !data.action.trim() : Object.hasOwn(data, 'action')) {
    throw new Error('Invalid secondary action');
  }
  return data;
}

// Verrou d'écriture d'une recette : fichier `.lock` créé en exclusif, qui porte le pid de son détenteur et l'instant de
// sa prise. Un processus mort entre la prise et la libération laissait un verrou orphelin définitif (revue du 16/10).
// Il est repris s'il est périmé : détenteur mort, ou verrou plus vieux que LOCK_STALE_MS (pid réutilisé, horloge), ou
// contenu illisible au-delà de LOCK_WRITE_MS (prise interrompue avant l'écriture du pid). Une écriture tient le verrou
// quelques millisecondes : ces délais ne coupent jamais une écriture vivante.
export const LOCK_STALE_MS = 16180, LOCK_WRITE_MS = 1618;
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
async function staleLock(lockPath) {
  let text, info;
  try { [text, info] = await Promise.all([readFile(lockPath, 'utf8'), stat(lockPath)]); }
  catch (e) { if (e.code === 'ENOENT') return { gone: true }; throw e; }
  let owner = null;
  try { owner = JSON.parse(text); } catch { /* prise interrompue avant l'écriture du pid */ }
  const age = Date.now() - (Number.isFinite(owner?.at) ? owner.at : info.mtimeMs);
  const valid = owner && Number.isSafeInteger(owner.pid) && owner.pid > 0;
  const stale = valid ? !alive(owner.pid) || age > LOCK_STALE_MS : age > LOCK_WRITE_MS;
  return { stale, text, owner: valid ? owner.pid : null };
}
// Reprise atomique : le verrou périmé est renommé (un seul processus y parvient), puis relu ; si ce n'était plus lui (un
// autre l'a repris entre-temps), il est remis en place sans écraser un verrou plus récent.
async function breakLock(lockPath, seenText) {
  const grave = lockPath + '.' + randomUUID() + '.stale';
  try { await rename(lockPath, grave); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  const moved = await readFile(grave, 'utf8').catch(() => null);
  if (moved !== seenText) await link(grave, lockPath).catch(() => {});
  await unlink(grave);
}
async function takeLock(lockPath) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lockPath, 'wx');
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() })); }
      catch (e) { await handle.close().finally(() => unlink(lockPath)); throw e; }
      return handle;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const state = await staleLock(lockPath);
      if (state.gone) continue;
      if (!state.stale) {
        throw Object.assign(new Error(`Application memory is being written by another session${state.owner ? ` (pid ${state.owner})` : ''}; retry later`), { code: 'EEXIST' });
      }
      await breakLock(lockPath, state.text);
    }
  }
  throw Object.assign(new Error('Application memory lock is contended; retry later'), { code: 'EEXIST' });
}

export class ApplicationMemory {
  constructor(root) {
    if (!root || !path.isAbsolute(root)) throw new Error('An absolute local state directory is required');
    this.root = root;
  }
  file(app, name) {
    if (typeof app !== 'string' || !app || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(name)) throw new Error('Invalid application or recipe name');
    return path.join(this.root, 'recipes', digest(app), name + '.json');
  }
  async read(app, name) {
    try {
      const data = JSON.parse(await readFile(this.file(app, name), 'utf8'));
      return validateRecord(data, app, name);
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }
  async save(app, name, recipe) {
    const file = this.file(app, name);
    const data = validateRecord({ ...recipe, schema: 1, appHash: digest(app), name }, app, name);
    await mkdir(path.dirname(file), { recursive: true });
    // Jamais le verrou vivant d'une autre session, jamais une écriture concurrente partielle ; un verrou orphelin est repris.
    const lock = await takeLock(file + '.lock');
    const tmp = file + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
      await rename(tmp, file);
    } finally {
      try {
        await unlink(tmp).catch(e => { if (e.code !== 'ENOENT') throw e; });
      } finally {
        try { await lock.close(); }
        finally { await unlink(file + '.lock'); }
      }
    }
  }
}
