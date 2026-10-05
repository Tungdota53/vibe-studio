import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { roleProfile } from './roles.js';
import type { Role } from './types.js';
import type { Config } from './config.js';
import { safePath, isSensitivePath } from './security.js';
import crypto from 'node:crypto';
import { recommendationScore, skillRoutes } from './skill-routing.js';

export interface Skill { id: string; name: string; description: string; source: string; file: string; recommendedRoles?: Role[]; requires?: string[]; provenance?: { repository: string; commit: string; license: string; url: string; integrity: boolean; bundleDigest?: string; adaptation?: string; sourcePaths?: string[] } }
// Copies are equivalent only after every manifest file has been verified. A
// matching name or upstream URL alone cannot identify a local instruction set.
function sameBundle(a: Skill, b: Skill) {
  const x = a.provenance, y = b.provenance;
  return Boolean(x?.integrity && y?.integrity && x.bundleDigest && x.bundleDigest === y.bundleDigest);
}
// Bundled builds place the same assets next to desktop-host.mjs.
const bundled = path.join(path.dirname(fileURLToPath(import.meta.url)), 'skills');
export class SkillLibrary {
  constructor(private workspace: string, private userRoot = path.join(os.homedir(), '.codex', 'skills'), private builtins = bundled) {}
  list(onlyId?: string): Skill[] {
    const result: Skill[] = [];
    for (const [source, root] of [['project', path.join(this.workspace, '.agents', 'skills')], ['workspace', path.join(this.workspace, '.vibe', 'skills')], ['user', this.userRoot], ['builtin', this.builtins], ['github', path.join(path.dirname(this.builtins), 'vendor-skills')]]) {
      if (['project', 'workspace'].includes(source)) {
        try { safePath(this.workspace, path.relative(this.workspace, root)); } catch { continue; }
      }
      const walk = (dir: string, depth: number) => {
        if (depth > 3 || result.length >= 300) return;
        try {
          for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!item.isDirectory() || item.isSymbolicLink()) continue;
            const folder = path.join(dir, item.name), file = path.join(folder, 'SKILL.md');
            if (fs.existsSync(file)) {
              const id = `${source}:${path.relative(root, folder).split(path.sep).join('/')}`;
              // Resource reads verify the requested bundle without rehashing
              // every unrelated vendor reference on each tool call.
              if (onlyId?.includes(':') && id !== onlyId) continue;
              try {
                safePath(root, path.relative(root, file));
                if (fs.statSync(file).size > 64000) continue;
                const content = fs.readFileSync(file, 'utf8');
                const metadata = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
                const field = (name: string) => metadata?.[1].match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1].trim().replace(/^['"]|['"]$/g, '');
                let provenance: Skill['provenance'];
                if (source === 'github' || (source === 'workspace' && id.startsWith('workspace:auto/'))) {
                  const manifest = JSON.parse(fs.readFileSync(path.join(folder, '.provenance.json'), 'utf8'));
                  const integrity = Boolean(manifest.files?.['SKILL.md'] && manifest.files?.['LICENSE.txt']) && Object.entries(manifest.files as Record<string, string>).every(([name, expected]) => crypto.createHash('sha256').update(fs.readFileSync(safePath(folder, name))).digest('hex') === expected);
                  const bundleDigest = crypto.createHash('sha256').update(JSON.stringify({ repository: manifest.repository, commit: manifest.commit, license: manifest.license, url: manifest.url, adaptation: manifest.adaptation, sourcePaths: manifest.sourcePaths, files: Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b)) })).digest('hex');
                  provenance = { repository: manifest.repository, commit: manifest.commit, license: manifest.license, url: manifest.url, integrity, bundleDigest, ...(typeof manifest.adaptation === 'string' ? { adaptation: manifest.adaptation } : {}), ...(Array.isArray(manifest.sourcePaths) && manifest.sourcePaths.every((item: unknown) => typeof item === 'string') ? { sourcePaths: manifest.sourcePaths } : {}) };
                }
                result.push({ id, name: field('name') || item.name, description: (field('description') || '').slice(0, 1200), source, file, provenance, recommendedRoles: skillRoutes[id]?.roles, requires: skillRoutes[id]?.requires });
              } catch { /* Skip invalid or escaped skill paths. */ }
            } else walk(folder, depth + 1);
          }
        } catch { /* Optional directories may be absent. */ }
      };
      walk(root, 0);
    }
    return result;
  }
  resolve(id: string, list = this.list()) {
    const exact = list.find(skill => skill.id === id);
    if (exact) return exact;
    const named = list.filter(skill => skill.name === id);
    if (named.length > 1 && named.every(skill => sameBundle(skill, named[0]))) {
      // Prefer the bundled ID so saved plans do not depend on a copied folder.
      return named.find(skill => skill.source === 'github') || named.slice().sort((a, b) => a.id.localeCompare(b.id))[0];
    }
    if (named.length !== 1) throw new Error(named.length ? `Skill trùng tên; dùng ID đầy đủ: ${id}. Các ID: ${named.map(skill => skill.id).join(', ')}` : `Không tìm thấy skill: ${id}`);
    return named[0];
  }
  load(id: string, catalog?: Skill[]) {
    const skill = this.resolve(id, catalog);
    if (skill.provenance && !skill.provenance.integrity) throw new Error(`Skill ${id} không khớp checksum nguồn GitHub`);
    if (fs.statSync(skill.file).size > 64000) throw new Error('Skill vượt giới hạn 64 KB');
    let instructions = fs.readFileSync(skill.file, 'utf8');
    if (instructions.length > 16000) {
      if (!skill.provenance) throw new Error(`Skill ${skill.id} quá dài để nạp; chia thành tài nguyên tham chiếu.`);
      const lines = instructions.split(/\r?\n/); let excerpt = '', next = 0;
      while (next < lines.length && excerpt.length + lines[next].length + 1 <= 12000) excerpt += lines[next++] + '\n';
      instructions = excerpt + `\n[Skill excerpt. Read the remaining SKILL.md with read_skill_resource, startLine=${next + 1}. Do not infer omitted instructions.]`;
    }
    return { ...skill, instructions };
  }
  resource(id: string, resource: string, startLine = 1, endLine = startLine + 299) {
    const skill = this.resolve(id, this.list(id));
    if (skill.provenance && !skill.provenance.integrity) throw new Error('Skill không khớp checksum');
    if (isSensitivePath(resource)) throw new Error('Tài nguyên chứa thông tin nhạy cảm bị chặn');
    const file = safePath(path.dirname(skill.file), resource);
    if (skill.provenance) {
      const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(skill.file), '.provenance.json'), 'utf8'));
      if (!manifest.files[path.relative(path.dirname(skill.file), file).split(path.sep).join('/')]) throw new Error('Tài nguyên không có trong manifest nguồn GitHub');
    }
    if (!Number.isInteger(startLine) || startLine < 1 || !Number.isInteger(endLine) || endLine < startLine || endLine - startLine > 499) throw new Error('Chọn tối đa 500 dòng tài nguyên');
    if (!fs.statSync(file).isFile() || fs.statSync(file).size > 1024000) throw new Error('Tài nguyên phải là tệp văn bản tối đa 1 MB');
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    return lines.slice(startLine - 1, endLine).join('\n').slice(0, 30000) + (lines.length > endLine ? `\n[Đọc tiếp từ dòng ${endLine + 1}; tổng ${lines.length} dòng]` : '');
  }
  search(query: string, catalog = this.list()) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return catalog.map(skill => ({ ...skill, score: terms.reduce((score, term) => score + (skill.name.toLowerCase().includes(term) ? 3 : skill.description.toLowerCase().includes(term) ? 1 : 0), 0) })).filter(skill => !terms.length || skill.score > 0).sort((a, b) => b.score - a.score).slice(0, 20);
  }
  select(role: Role, task: string, config?: Partial<Config>, explicit: string[] = [], catalog = this.list()) {
    const profile = roleProfile(role, config);
    const selected = [...new Set([...profile.skills, ...explicit])].map(id => this.load(id, catalog)).filter((skill,index,list)=>!list.slice(0,index).some(prior=>prior.id === skill.id || sameBundle(prior, skill)));
    // Add relevant, pinned role recommendations without overflowing the prompt budget.
    if (profile.autoSkills) {
      const recommended = catalog.map(skill => ({ skill, score: recommendationScore(skill.id, role, task) }))
        .filter(item => item.score > 0 && (item.skill.source === 'builtin' || item.skill.provenance?.integrity)).sort((a, b) => b.score - a.score);
      let added = 0;
      for (const { skill } of recommended) {
        if (added >= 2 || selected.length >= 8) break;
        if (selected.some(item => item.id === skill.id || sameBundle(item, skill))) continue;
        const loaded = this.load(skill.id, catalog);
        if (selected.reduce((n, item) => n + item.instructions.length, 0) + loaded.instructions.length > 24000) continue;
        selected.push(loaded); added++;
      }
    }
    // User/system skills still require explicit selection.
    if (profile.autoSkills) for (const skill of this.search(task, catalog).filter(skill => ['project', 'workspace'].includes(skill.source) && skill.score >= 3)) {
      if (selected.length >= 4) break;
      if (!selected.some(item => item.id === skill.id || sameBundle(item, skill))) {
        const loaded = this.load(skill.id, catalog);
        if (selected.reduce((n, item) => n + item.instructions.length, 0) + loaded.instructions.length <= 24000) selected.push(loaded);
      }
    }
    if (selected.length > 8) throw new Error('Tối đa 8 skill cho mỗi agent; chọn lại các skill cần thiết.');
    return selected;
  }
}
