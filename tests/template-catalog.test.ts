import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TemplateCatalog, templateCatalog } from '../src/template-catalog.js';
import { SkillLibrary } from '../src/skills.js';
import { loadConfig } from '../src/config.js';
import { Tools } from '../src/tools.js';
import { Agent } from '../src/agent.js';
import { ModelRouter } from '../src/router.js';
import type { ModelClient } from '../src/model.js';
import type { Message } from '../src/types.js';

const roots: string[] = [];
function root() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-template-')); roots.push(dir); return dir; }
afterEach(() => roots.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
const skillId = 'aitmpl:skills/creative-design/frontend-design';
describe('AITMPL catalog and native adapters', () => {
  it('ships every indexed component type and all snapshot resources with exact IDs and pagination', () => {
    expect(templateCatalog.summary()).toMatchObject({ entries: 2043, resources: 7149, counts: { skills: 914, mcps: 105, plugins: 34, mods: 39 } });
    const first = templateCatalog.search('', '', 0), second = templateCatalog.search('', '', 24);
    expect(first.items).toHaveLength(24); expect(second.items).toHaveLength(24);
    expect(second.items.some(item => first.items.some(prior => prior.id === item.id))).toBe(false);
    expect(templateCatalog.search('frontend', 'skills').items.some(item => item.id === skillId)).toBe(true);
    expect(() => templateCatalog.search('', '', -1)).toThrow();
    expect(() => templateCatalog.get('frontend-design')).toThrow();
  });
  it('verifies catalog/archive digests, paginates original resources and rejects escaped resource paths', () => {
    const dir = root();
    for (const file of ['index.json', 'snapshot.json']) fs.copyFileSync(path.join('src/template-assets', file), path.join(dir, file));
    const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
    const entry = index.entries.find((item: any) => item.id === skillId), bucket = index.files[entry.primary].bucket;
    fs.writeFileSync(path.join(dir, `${bucket}.json.gz`), 'corrupt archive');
    expect(() => new TemplateCatalog(dir).read(skillId)).toThrow('checksum');
    fs.appendFileSync(path.join(dir, 'index.json'), ' ');
    expect(() => new TemplateCatalog(dir).summary()).toThrow('checksum');
    expect(templateCatalog.read(skillId, 'SKILL.md', 1, 5).nextLine).toBe(6);
    expect(() => templateCatalog.read(skillId, '../../LICENSE')).toThrow('outside');
    expect(() => templateCatalog.read(skillId, 'SKILL.md', 1, 501)).toThrow('500');
  });
  it('assigns template skills and specialist agents without changing models, permissions or existing settings', () => {
    const dir = root(), config = loadConfig(dir); config.model = 'one-model';
    fs.mkdirSync(path.join(dir, '.vibe'), { recursive: true }); fs.writeFileSync(path.join(dir, '.vibe/config.json'), '{"custom":"preserve"}');
    const result = templateCatalog.apply(dir, config, skillId, 'coder');
    expect(result.config.agentProfiles?.coder?.skills).toContain(skillId); expect(result.config.model).toBe('one-model');
    const named = templateCatalog.apply(dir, result.config, 'aitmpl:agents/programming-languages/react-specialist', 'coder');
    expect(named.config.namedAgents?.at(-1)).toMatchObject({ role: 'coder', model: '', skills: ['aitmpl:agents/programming-languages/react-specialist'] });
    expect(templateCatalog.apply(dir, named.config, 'aitmpl:agents/programming-languages/react-specialist').config.namedAgents).toHaveLength(named.config.namedAgents!.length);
    expect(JSON.parse(fs.readFileSync(path.join(dir, '.vibe/config.json'), 'utf8')).custom).toBe('preserve');
    expect(new SkillLibrary(dir).load(skillId).instructions).toContain('native role permissions');
  });
  it('imports MCP presets without launching them and exports engine-specific hooks as inert source', () => {
    const dir = root(), config = loadConfig(dir);
    config.mcpServers = { existing: { transport: 'http', url: 'https://example.com/mcp', enabled: false, timeoutMs: 30000 } };
    const result = templateCatalog.apply(dir, config, 'aitmpl:mcps/integration/github-integration');
    expect(result.config.mcpServers?.existing).toEqual(config.mcpServers.existing);
    const added = Object.entries(result.config.mcpServers!).filter(([key]) => key !== 'existing');
    expect(added).toHaveLength(1); expect(added[0][1]).toMatchObject({ enabled: false, transport: 'stdio', env: { GITHUB_PERSONAL_ACCESS_TOKEN: '<YOUR_TOKEN>' } });
    const hook = templateCatalog.apply(dir, result.config, 'aitmpl:hooks/git-workflow/auto-git-add');
    expect(hook.message).toContain('chưa được thực thi'); expect(hook.config.mcpServers).toEqual(result.config.mcpServers);
    const exports = fs.readdirSync(path.join(dir, '.vibe/templates')); expect(exports).toHaveLength(1);
    const source = JSON.parse(fs.readFileSync(path.join(dir, '.vibe/templates', exports[0], 'SOURCE.json'), 'utf8'));
    expect(source).toMatchObject({ compatible: false, mode: 'reference', kind: 'hooks' });
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(false);
  });
  it('lets the agent discover and actually load a catalog skill into its next model request', async () => {
    const dir = root(), config = { ...loadConfig(dir), autoIntegrations: false }; let calls = 0;
    const client = { config, chat: async (messages: Message[]) => {
      if (calls++ === 0) return { content: '', toolCalls: [{ id: 'load', type: 'function', function: { name: 'load_skill', arguments: JSON.stringify({ id: skillId }) } }] };
      expect(messages[0].content).toContain(skillId); expect(messages[0].content).toContain('native role permissions');
      return { content: 'Using actual template instructions', toolCalls: [] };
    } } as unknown as ModelClient;
    const tools = new Tools(dir, async () => false, 'reviewer');
    expect((await tools.run('search_templates', '{"query":"github","kind":"mcps"}')).ok).toBe(true);
    expect((await tools.run('read_template', JSON.stringify({ id: skillId }))).ok).toBe(true);
    await new Agent('review', 'reviewer', dir, client, new ModelRouter(config), tools).run('Review source');
    expect(calls).toBe(2);
    expect((await tools.run('write_file', '{"path":"source.txt","content":"bad"}')).ok).toBe(false);
  });
});
