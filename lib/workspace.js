import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const hidden = new Set(['.git', '.svn', 'node_modules', '.local-data', '.next', 'dist', 'build', '.venv', '__pycache__']);
const privatePart = /^(?:\.env(?:\..*)?|\.ssh|\.aws|\.codex|\.agents|\.local-data|\.git|credentials(?:\..*)?|auth\.json|id_rsa|id_ed25519|.*\.(?:pem|pfx|p12|key|dpapi))$/i;
const maxFile = 300_000;
export function allowedName(name) { return !privatePart.test(name); }
export function inside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
export async function projectRoot(folder) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new Error('Choose an absolute project folder.');
  const stat = await fs.lstat(folder);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Choose a regular folder, not a link or junction.');
  const root = await fs.realpath(folder);
  if (root === path.parse(root).root) throw new Error('Choose a project folder rather than an entire drive.');
  return root;
}
export class Workspace {
  constructor(root, dataDir, onChange = () => {}) { this.root = root; this.dataDir = dataDir; this.onChange = onChange; }
  async resolve(relative = '.', { create = false } = {}) {
    if (typeof relative !== 'string' || relative.includes('\0') || /[:]/.test(relative) || path.isAbsolute(relative)) throw new Error('Use a path relative to the project folder.');
    const target = path.resolve(this.root, relative);
    if (!inside(this.root, target)) throw new Error('Path is outside the selected project.');
    const parts = path.relative(this.root, target).split(path.sep).filter(Boolean);
    if (parts.some(p => !allowedName(p))) throw new Error('Credential, environment, and internal files are excluded from file tools.');
    // Check every existing ancestor, including the root, to reject symlinks/junctions.
    let current = this.root;
    const ancestors = [current];
    for (const part of parts) { current = path.join(current, part); ancestors.push(current); }
    for (const candidate of ancestors) {
      try {
        const s = await fs.lstat(candidate);
        if (s.isSymbolicLink()) throw new Error('Links and junctions are excluded from file tools.');
        if (!inside(this.root, await fs.realpath(candidate))) throw new Error('Resolved path is outside the project.');
      } catch (e) { if (!(create && e.code === 'ENOENT')) throw e; }
    }
    return target;
  }
  async list(relative = '.', depth = 2) {
    const start = await this.resolve(relative);
    const entries = []; let clipped = false;
    const walk = async (folder, level) => {
      const children = (await fs.readdir(folder, { withFileTypes: true })).sort((a,b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      for (const item of children) {
        if (!allowedName(item.name) || hidden.has(item.name) || item.isSymbolicLink()) continue;
        if (entries.length >= 500) { clipped = true; return; }
        const absolute = path.join(folder, item.name);
        entries.push({ path: path.relative(this.root, absolute).split(path.sep).join('/'), type: item.isDirectory() ? 'folder' : 'file' });
        if (item.isDirectory() && level < depth) await walk(absolute, level + 1);
      }
    };
    await walk(start, 1);
    return { entries, clipped };
  }
  async read(relative) {
    const target = await this.resolve(relative);
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > maxFile) throw new Error('Read a text file smaller than 300 KB.');
    const buffer = await fs.readFile(target);
    if (buffer.includes(0)) throw new Error('Binary files are not supported.');
    return { path: relative, content: buffer.toString('utf8'), hash: crypto.createHash('sha256').update(buffer).digest('hex') };
  }
  async changes() {
    try { return JSON.parse(await fs.readFile(path.join(this.dataDir, 'changes.json'), 'utf8')).filter(c => c.root === this.root); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  }
  async write(relative, content, expectedHash = null) {
    if(this.readOnly)throw new Error('This project is a read-only reference for the active goal.');
    if (typeof content !== 'string' || Buffer.byteLength(content) > maxFile || content.includes('\0')) throw new Error('Write text smaller than 300 KB.');
    const target = await this.resolve(relative, { create: true });
    let before = null;
    try { before = await this.read(relative); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (before && expectedHash !== before.hash) throw new Error('File changed or was not read first. Read it again and use its latest hash.');
    if (!before && expectedHash !== null) throw new Error('File no longer exists. Read the current project again.');
    if (before?.content === content) return { path: relative, unchanged: true };
    const id = crypto.randomUUID();
    const afterHash = crypto.createHash('sha256').update(content).digest('hex');
    const change = { id, root: this.root, path: relative, before: before?.content ?? null, after: content, afterHash, time: new Date().toISOString() };
    await fs.mkdir(this.dataDir, { recursive: true });
    let all = [];
    try { all = JSON.parse(await fs.readFile(path.join(this.dataDir, 'changes.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    // Persist the recoverable snapshot before touching the project file.
    await atomicJson(path.join(this.dataDir, 'changes.json'), [...all, change]);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await this.resolve(relative, { create: true });
    await fs.writeFile(target, content, 'utf8');
    this.onChange({ path: relative, id });
    return { path: relative, changeId: id, created: !before, hash: afterHash };
  }
  async undo(id) {
    if(this.readOnly)throw new Error('This project is a read-only reference for the active goal.');
    const change = (await this.changes()).find(c => c.id === id && !c.undone);
    if (!change) throw new Error('Change not found.');
    const current = await this.read(change.path);
    if (current.hash !== change.afterHash) throw new Error('The file has newer changes. Undo those first, or edit the file manually.');
    if (change.before === null) await fs.unlink(await this.resolve(change.path));
    else await fs.writeFile(await this.resolve(change.path), change.before, 'utf8');
    const filename = path.join(this.dataDir, 'changes.json');
    const all = JSON.parse(await fs.readFile(filename, 'utf8'));
    const record = all.find(c => c.id === id); record.undone = true;
    await atomicJson(filename, all);
    this.onChange({ path: change.path, undone: true });
    return { ok: true };
  }
  async search(query) {
    if (typeof query !== 'string' || !query.trim()) throw new Error('Enter search text.');
    const { entries } = await this.list('.', 8); const matches = [];
    for (const entry of entries.filter(e => e.type === 'file')) {
      try {
        const { content } = await this.read(entry.path);
        const lines = content.split('\n');
        for (let i = 0; i < lines.length && matches.length < 80; i++) if (lines[i].toLowerCase().includes(query.toLowerCase())) matches.push({ path: entry.path, line: i+1, text: lines[i].slice(0,400) });
      } catch { /* Skip binary and large files. */ }
      if (matches.length >= 80) break;
    }
    return { matches, limit: 80 };
  }
}
export async function atomicJson(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const tmp = filename + '.' + crypto.randomUUID() + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(value, null, 2));
  await fs.rename(tmp, filename);
}
