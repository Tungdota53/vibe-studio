import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isSensitivePath, redact } from './security.js';
const excluded = new Set(['.vibe', '.git', 'node_modules', 'dist', 'build', 'release', '.ssh', '.codex']);
const digest = (value: Buffer) => crypto.createHash('sha256').update(value).digest('hex');
interface FileImage { path: string; hash: string | null; data?: string; mode?: number }
export interface FileCheckpoint { id: string; sessionId?: string; scope: string; tool: string; createdAt: string; status: 'pending' | 'completed' | 'restored'; before: FileImage[]; scopedFiles?: boolean; warnings?: string[]; after?: FileImage[]; intended?: FileImage[]; restoredFiles?: string[] }
export function durableJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true }); const temp = file + '.' + crypto.randomUUID() + '.tmp';
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}
/** Bounded local undo: no Git requirement, no sensitive/generated files, no symlink traversal. */
export class CheckpointStore {
  private directory: string;
  private warnings: string[] = [];
  constructor(private workspace: string) { this.workspace = path.resolve(workspace); this.directory = path.join(this.workspace, '.vibe', 'checkpoints'); }
  private file(id: string) { if (!/^cp-[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid checkpoint ID'); return path.join(this.directory, id + '.json'); }
  private target(scope: string, relative: string) {
    if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => part === '..' || excluded.has(part)) || isSensitivePath(relative)) throw new Error('Protected checkpoint path');
    const root = path.resolve(scope), target = path.resolve(root, relative);
    if (!target.startsWith(root + path.sep)) throw new Error('Checkpoint outside workspace');
    for (let item = target; item !== root; item = path.dirname(item)) if (fs.existsSync(item) && fs.lstatSync(item).isSymbolicLink()) throw new Error('Checkpoint symlink blocked');
    if (fs.lstatSync(root).isSymbolicLink()) throw new Error('Checkpoint workspace symlink blocked');
    return target;
  }
  private image(scope: string, relative: string): FileImage {
    const target = this.target(scope, relative);
    if (!fs.existsSync(target)) return { path: relative, hash: null };
    const stat = fs.statSync(target); if (stat.nlink > 1) throw new Error('Checkpoint hardlink alias blocked'); if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('Checkpoint requires regular files <= 2 MiB');
    const data = fs.readFileSync(target); return { path: relative, hash: digest(data), data: data.toString('base64'), mode: stat.mode };
  }
  private scan(scope: string) {
    const files: string[] = []; let bytes = 0, truncated = false;
    const walk = (directory: string) => { if (truncated) return; let entries: fs.Dirent[]; try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { this.warnings.push('Unreadable directory excluded from undo: ' + path.relative(scope, directory)); return; } for (const entry of entries) {
      if (truncated) return;
      const relative = path.relative(scope, path.join(directory, entry.name));
      if (excluded.has(entry.name) || isSensitivePath(relative)) continue;
      if (entry.isSymbolicLink()) { this.warnings.push('Symlink excluded from undo: ' + relative); continue; }
      if (entry.isDirectory()) walk(path.join(directory, entry.name));
      else if (entry.isFile()) { let stat: fs.Stats; try { stat = fs.statSync(path.join(directory, entry.name)); } catch { this.warnings.push('Unreadable file excluded from undo: ' + relative); continue; } if (stat.nlink > 1) { this.warnings.push('Hardlink alias excluded from undo: ' + relative); continue; } const size = stat.size; if (size > 2 * 1024 * 1024) { this.warnings.push('Large file excluded from undo: ' + relative); continue; } if (files.length >= 2000 || bytes + size > 80 * 1024 * 1024) { truncated = true; this.warnings.push('Undo coverage truncated at 2000 files/80 MiB; command may affect uncaptured files'); return; } bytes += size; files.push(relative); }
    } };
    walk(scope); return files;
  }
  private images(scope: string, paths: string[], skipUnreadable: boolean) { return paths.flatMap(file => { try { return [this.image(scope, file)]; } catch (error) { if (!skipUnreadable || !['EBUSY', 'EPERM', 'EACCES', 'ENOENT'].includes((error as NodeJS.ErrnoException).code || '')) throw error; this.warnings.push('Unreadable file excluded from undo: ' + file); return []; } }); }
  begin(options: { tool: string; scope?: string; files?: string[]; sessionId?: string; intendedContent?: Record<string, string> }) {
    const scope = path.resolve(options.scope || this.workspace);
    const allowed = scope === this.workspace || scope.startsWith(path.join(this.workspace, '.vibe', 'worktrees') + path.sep);
    if (!allowed) throw new Error('Checkpoint scope outside configured workspace');
    this.warnings = [];
    const paths = options.files || this.scan(scope), before = this.images(scope, paths, !options.files);
    const intended = options.intendedContent ? Object.entries(options.intendedContent).map(([file, content]) => { this.target(scope, file); const data = Buffer.from(content); if (data.length > 2 * 1024 * 1024) throw new Error('Checkpoint intended file exceeds 2 MiB'); return { path: file, hash: digest(data), data: data.toString('base64') }; }) : undefined;
    const checkpoint: FileCheckpoint = { id: 'cp-' + crypto.randomUUID(), sessionId: options.sessionId, scope, tool: options.tool, createdAt: new Date().toISOString(), status: 'pending', before, intended, scopedFiles: !!options.files, warnings: this.warnings.slice(0, 200) };
    durableJson(this.file(checkpoint.id), checkpoint); return checkpoint.id;
  }
  finish(id: string) {
    const checkpoint = this.read(id); const paths = checkpoint.scopedFiles ? checkpoint.before.map(file => file.path) : [...new Set([...checkpoint.before.map(file => file.path), ...this.scan(checkpoint.scope)])];
    checkpoint.after = this.images(checkpoint.scope, paths, !checkpoint.scopedFiles); checkpoint.warnings = [...new Set([...(checkpoint.warnings || []), ...this.warnings])].slice(0, 200); checkpoint.status = 'completed'; durableJson(this.file(id), checkpoint);
  }
  private read(id: string): FileCheckpoint { const checkpoint = JSON.parse(fs.readFileSync(this.file(id), 'utf8')); if (checkpoint.id !== id || (checkpoint.scope !== this.workspace && !checkpoint.scope.startsWith(path.join(this.workspace, '.vibe', 'worktrees') + path.sep))) throw new Error('Corrupt checkpoint scope'); return checkpoint; }
  list(sessionId?: string) {
    if (!fs.existsSync(this.directory)) return [];
    return fs.readdirSync(this.directory).filter(file => /^cp-[a-f0-9-]{36}\.json$/.test(file)).flatMap(file => { try {
      const checkpoint = this.read(file.slice(0, -5)); if (sessionId && checkpoint.sessionId !== sessionId) return [];
      const before = new Map(checkpoint.before.map(file => [file.path, file.hash]));
      const after = checkpoint.after || checkpoint.intended || [];
      return [{ id: checkpoint.id, sessionId: checkpoint.sessionId, tool: checkpoint.tool, createdAt: checkpoint.createdAt, status: checkpoint.status, warnings: checkpoint.warnings || [], files: [...new Set([...checkpoint.before.map(file => file.path), ...after.map(file => file.path)])].filter(file => before.get(file) !== after.find(image => image.path === file)?.hash), restoredFiles: checkpoint.restoredFiles || [] }];
    } catch { return []; } }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  diff(id: string, maxFiles = 2000, maxChars = 20000) { const checkpoint = this.read(id), after = checkpoint.after || checkpoint.intended || []; return { id, status: checkpoint.status, files: [...new Set([...checkpoint.before.map(file => file.path), ...after.map(file => file.path)])].filter(file=>(checkpoint.before.find(image=>image.path===file)?.hash??null)!==(after.find(image=>image.path===file)?.hash??null)).slice(0,maxFiles).map(file => {
    const before = checkpoint.before.find(image => image.path === file), next = after.find(image => image.path === file);
    const text = (image?: FileImage) => image?.data ? redact(Buffer.from(image.data, 'base64').toString('utf8').slice(0, maxChars)) : '';
    return { path: file, before: text(before), after: text(next), beforeHash: before?.hash ?? null, afterHash: next?.hash ?? null, changed: (before?.hash ?? null) !== (next?.hash ?? null) };
  }).filter(file => file.changed) }; }
  restore(id: string, files: string[]) {
    const checkpoint = this.read(id); if (!files.length || files.length > 2000) throw new Error('Select files to restore');
    const after = checkpoint.after || checkpoint.intended; if (!after) throw new Error('Interrupted command outcome unknown; automatic undo unavailable');
    const selected = [...new Set(files)].map(file => { const image = after.find(image => image.path === file); if (!image) throw new Error('File not in checkpoint'); const current = this.image(checkpoint.scope, file), before = checkpoint.before.find(image => image.path === file); if (current.hash !== image.hash && current.hash !== (before?.hash ?? null)) throw new Error(`Undo conflict: ${file} changed after this checkpoint`); return { file, before, current }; });
    // Preflight every selected file before changing any file.
    for (const { file, before, current } of selected) {
      if (current.hash === (before?.hash ?? null)) continue;
      const target = this.target(checkpoint.scope, file);
      if (before?.data === undefined) fs.unlinkSync(target);
      else { fs.mkdirSync(path.dirname(target), { recursive: true }); const temp = target + '.vibe-undo-' + crypto.randomUUID(); fs.writeFileSync(temp, Buffer.from(before.data, 'base64'), { mode: before.mode }); fs.renameSync(temp, target); }
    }
    checkpoint.restoredFiles = [...new Set([...(checkpoint.restoredFiles || []), ...files])]; checkpoint.status = 'restored'; durableJson(this.file(id), checkpoint); return { id, restored: files };
  }
}
