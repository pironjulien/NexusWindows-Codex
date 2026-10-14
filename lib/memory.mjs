import { mkdir, readFile, writeFile, rename, unlink, open } from 'node:fs/promises';
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
    // Never break another session's lock or overwrite a partial concurrent update.
    const lock = await open(file + '.lock', 'wx');
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
