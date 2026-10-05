import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';

const root = path.resolve(process.argv[2] || '.vibe/upstream-aitmpl');
const output = path.resolve('src/template-assets');
const repository = 'davila7/claude-code-templates';
const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const files = {}, shards = Array.from({ length: 64 }, () => ({}));
function walk(folder) {
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Symlink in upstream snapshot');
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) walk(file);
    else {
      const relative = path.relative(root, file).split(path.sep).join('/'), bytes = fs.readFileSync(file);
      const bucket = parseInt(hash(relative).slice(0, 2), 16) % 64;
      shards[bucket][relative] = bytes.toString('base64');
      files[relative] = { bucket, sha256: hash(bytes), size: bytes.length };
    }
  }
}
walk(path.join(root, 'cli-tool/components'));
walk(path.join(root, 'cli-tool/templates'));
for (const name of ['LICENSE', 'README.md', 'docs/components.json', 'dashboard/public/plugins.json']) {
  const bytes = fs.readFileSync(path.join(root, name)), bucket = parseInt(hash(name).slice(0, 2), 16) % 64;
  shards[bucket][name] = bytes.toString('base64'); files[name] = { bucket, sha256: hash(bytes), size: bytes.length };
}
const upstream = JSON.parse(fs.readFileSync(path.join(root, 'docs/components.json')));
const entries = [], seen = new Set();
function add(kind, item, base, primary, resources) {
  const key = item.path || item.id || item.slug || item.name;
  const originalId = `aitmpl:${kind}/${key.replace(/\.(md|json)$/i, '')}`;
  const id = originalId.length <= 120 ? originalId : originalId.slice(0, 100) + '-' + hash(originalId).slice(0, 16);
  if (seen.has(id)) return;
  seen.add(id);
  entries.push({ id, kind, name: item.name || key.split('/').at(-1), category: item.category || '', description: String(item.description || '').slice(0, 1600), license: item.license || 'See upstream LICENSE and resource attribution', primary, base, resources, url: `https://github.com/${repository}/tree/${commit}/${primary || base}`, externalUrl: item.github, keywords: item.keywords || item.tags || [] });
}
for (const kind of ['skills', 'agents', 'commands', 'mcps', 'settings', 'hooks', 'loops', 'mods', 'sandbox']) {
  for (const item of upstream[kind] || []) {
    const location = `cli-tool/components/${kind}/${item.path}`;
    const directory = fs.existsSync(path.join(root, location)) && fs.statSync(path.join(root, location)).isDirectory();
    const base = directory ? location : path.posix.dirname(location);
    const resources = directory ? Object.keys(files).filter(file => file.startsWith(location + '/')) : [location].filter(file => files[file]);
    const primary = directory ? resources.find(file => /\/(SKILL|README)\.md$/.test(file)) || resources.find(file => file.endsWith('.json')) || resources[0] : resources[0];
    add(kind, item, base, primary, resources);
  }
  // Include component files not yet reflected in the website's generated index.
  for (const file of Object.keys(files).filter(file => file.startsWith(`cli-tool/components/${kind}/`))) {
    const relative = file.slice(`cli-tool/components/${kind}/`.length);
    if (kind === 'skills' && relative.endsWith('/SKILL.md')) {
      const folder = relative.slice(0, -9), base = `cli-tool/components/skills/${folder}`;
      add(kind, { path: folder, name: folder.split('/').at(-1), category: folder.split('/')[0] }, base, file, Object.keys(files).filter(x => x.startsWith(base + '/')));
    } else if (!['skills', 'mods'].includes(kind) && /\.(md|json)$/.test(relative)) {
      add(kind, { path: relative, category: relative.split('/')[0] }, path.posix.dirname(file), file, [file]);
    }
  }
}
for (const item of upstream.templates || []) {
  const name = item.id;
  const base = name === 'common' ? 'cli-tool/templates/common' : item.subtype === 'language' ? `cli-tool/templates/${name}` : `cli-tool/templates/${item.language}/examples/${name}`;
  const resources = Object.keys(files).filter(file => file.startsWith(base + '/'));
  add('templates', item, base, resources.find(file => file.endsWith('/CLAUDE.md')) || resources[0], resources);
}
for (const item of JSON.parse(fs.readFileSync(path.join(root, 'dashboard/public/plugins.json')))) add('plugins', item, 'dashboard/public', 'dashboard/public/plugins.json', ['dashboard/public/plugins.json']);
fs.mkdirSync(output, { recursive: true });
const buckets = {};
for (let bucket = 0; bucket < shards.length; bucket++) {
  const bytes = gzipSync(JSON.stringify(shards[bucket]), { level: 9 });
  fs.writeFileSync(path.join(output, `${bucket}.json.gz`), bytes); buckets[bucket] = hash(bytes);
}
const index = { version: 1, repository, commit, importedAt: new Date().toISOString(), website: 'https://aitmpl.com/', entries, files, buckets };
const indexBytes = Buffer.from(JSON.stringify(index));
fs.writeFileSync(path.join(output, 'index.json'), indexBytes);
fs.writeFileSync(path.join(output, 'snapshot.json'), JSON.stringify({ repository, commit, indexSha256: hash(indexBytes), entryCount: entries.length, resourceCount: Object.keys(files).length, counts: Object.fromEntries([...new Set(entries.map(x => x.kind))].map(kind => [kind, entries.filter(x => x.kind === kind).length])) }, null, 2) + '\n');
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(output, 'LICENSE.txt'));
console.log(fs.readFileSync(path.join(output, 'snapshot.json'), 'utf8'));
