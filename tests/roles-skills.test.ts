import { afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { SkillLibrary } from '../src/skills.js';
import { assignedAgent, teamSchema } from '../src/roles.js';
import { Tools } from '../src/tools.js';
import { Agent } from '../src/agent.js';
import { ModelClient } from '../src/model.js';
import { ModelRouter } from '../src/router.js';
import { loadConfig } from '../src/config.js';
import { parseTeamPlan } from '../src/teamwork.js';
import type { Message } from '../src/types.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {} }));
function root() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-role-')); roots.push(dir); return dir; }
function skill(dir: string, name: string, description: string, body = 'Read the relevant code before editing.') {
  const folder = path.join(dir, '.agents', 'skills', name); fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${body}`); return folder;
}
describe('Role permissions and skill loading', () => {
  it('resolves verified installed copies to one canonical skill and loads each bundle only once', () => {
    const dir = root(), copy = path.join(dir, '.vibe/skills/auto/trailofbits/audit-context-building');
    fs.cpSync('src/vendor-skills/trailofbits/audit-context-building', copy, { recursive: true });
    const lib = new SkillLibrary(dir, path.join(dir, 'absent'));
    expect(lib.load('audit-context-building').id).toBe('github:trailofbits/audit-context-building');
    const selected = lib.select('planner', 'audit-context-building audit khảo sát', { agentProfiles: { planner: { skills: ['workspace:auto/trailofbits/audit-context-building'], autoSkills: true } } }, ['audit-context-building', 'github:trailofbits/audit-context-building']);
    expect(selected.filter(item => item.name === 'audit-context-building')).toHaveLength(1);
    expect(lib.resource('audit-context-building', 'SKILL.md', 1, 5)).toContain('audit-context-building');
  });
  it('does not conflate local namesakes, modified bundles or copies with invalid checksums', () => {
    const dir = root(), copy = path.join(dir, '.vibe/skills/auto/trailofbits/audit-context-building');
    fs.cpSync('src/vendor-skills/trailofbits/audit-context-building', copy, { recursive: true });
    const lib = new SkillLibrary(dir, path.join(dir, 'absent'));
    fs.appendFileSync(path.join(copy, 'SKILL.md'), '\nChanged instructions');
    expect(() => lib.load('audit-context-building')).toThrow('Các ID:');
    expect(() => lib.load('workspace:auto/trailofbits/audit-context-building')).toThrow('checksum');
    const manifest = JSON.parse(fs.readFileSync(path.join(copy, '.provenance.json'), 'utf8'));
    manifest.files['SKILL.md'] = crypto.createHash('sha256').update(fs.readFileSync(path.join(copy, 'SKILL.md'))).digest('hex');
    fs.writeFileSync(path.join(copy, '.provenance.json'), JSON.stringify(manifest));
    expect(lib.load('workspace:auto/trailofbits/audit-context-building').provenance?.integrity).toBe(true);
    expect(() => lib.load('audit-context-building')).toThrow('trùng tên');
    skill(dir, 'audit-context-building', 'Unrelated local instructions');
    expect(() => lib.load('audit-context-building')).toThrow('project:audit-context-building');
    expect(lib.load('github:trailofbits/audit-context-building').provenance?.integrity).toBe(true);
  }, 15000);
  it('loads 38 GitHub skills with pinned provenance and paginated references', () => {
    const lib = new SkillLibrary(root()); const external = lib.list().filter(skill => skill.source === 'github');
    expect(external).toHaveLength(38);
    for (const skill of external) {
      expect(skill.provenance?.integrity).toBe(true);
      expect(['Apache-2.0', 'MIT', 'CC-BY-SA-4.0']).toContain(skill.provenance?.license);
      expect(skill.provenance?.commit).toMatch(/^[a-f0-9]{40}$/);
      expect(lib.load(skill.id, external).instructions.length).toBeGreaterThan(100);
    }
    expect(lib.resource('github:openai/security-best-practices', 'references/javascript-general-web-frontend-security.md', 1, 10)).toContain('Đọc tiếp từ dòng 11');
  });
  it('automatically matches pinned skills to role and topic with bounded context', () => {
    const lib = new SkillLibrary(root());
    const tester = lib.select('tester', 'property-based parser validator fast-check');
    expect(tester.map(skill => skill.id)).toContain('github:trailofbits/property-based-testing');
    expect(lib.select('planner', 'property-based parser validator fast-check').map(skill => skill.id)).not.toContain('github:trailofbits/property-based-testing');
    expect(lib.select('coder', 'build suite').map(skill => skill.id)).not.toContain('github:uiux/ui-ux-pro-max');
    expect(lib.select('coder', 'giao diện responsive accessibility').map(skill => skill.id)).toContain('github:uiux/ui-ux-pro-max');
    expect(lib.select('tester', 'fast-check', { agentProfiles: { tester: { autoSkills: false } } }).map(skill => skill.id)).toEqual(['builtin:evidence-testing']);
    expect(tester.reduce((total, skill) => total + skill.instructions.length, 0)).toBeLessThanOrEqual(24000);
    const large = lib.load('github:trailofbits/codeql');
    expect(large.instructions).toContain('Skill excerpt');
    expect(large.instructions.length).toBeLessThan(16000);
  }, 15000);
  it('enforces assigned files for direct writes without claiming shell isolation', async () => {
    const dir = root(), tools = new Tools(dir, async () => true, 'coder', new SkillLibrary(dir), ['allowed.txt']);
    expect((await tools.run('write_file', JSON.stringify({ path: 'allowed.txt', content: 'ok' }))).ok).toBe(true);
    expect((await tools.run('write_file', JSON.stringify({ path: 'other.txt', content: 'bad' }))).ok).toBe(false);
    expect(fs.existsSync(path.join(dir, 'other.txt'))).toBe(false);
    const nested = new Tools(dir, async () => true, 'coder', new SkillLibrary(dir), ['src/components/card.ts']);
    expect((await nested.run('write_file', JSON.stringify({ path: 'src/components/card.ts', content: 'export const card = true;' }))).ok).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'src/components/card.ts'), 'utf8')).toContain('card = true');
  });
  it('executes and cancels commands with an active agent signal', async () => {
    const tools = new Tools(root(), async () => true, 'tester');
    const active = new AbortController();
    expect(await tools.run('run_command', JSON.stringify({ command: 'node --version' }), active.signal)).toMatchObject({ ok: true, output: expect.stringContaining('exit=0') });
    active.abort();
    expect((await tools.run('run_command', JSON.stringify({ command: 'node --version' }), active.signal)).ok).toBe(false);
  });
  it('keeps teamwork question tasks read-only while direct assistant tools retain their permissions', async () => {
    const dir = root(), lib = new SkillLibrary(dir);
    const readonly = new Tools(dir, async () => true, 'general', lib, undefined, true);
    const normal = new Tools(dir, async () => true, 'general', lib);
    const write = JSON.stringify({ path: 'source.txt', content: 'real' });
    expect((await readonly.run('write_file', write)).ok).toBe(false);
    expect((await readonly.run('run_command', '{"command":"echo unsafe"}')).ok).toBe(false);
    expect((await normal.run('write_file', write)).ok).toBe(true);
  });
  it('rejects a tampered GitHub skill instead of loading its instructions', () => {
    const dir = root(), builtins = path.join(dir, 'skills'); fs.mkdirSync(builtins);
    fs.cpSync('src/vendor-skills/anthropic/frontend-design', path.join(dir, 'vendor-skills', 'anthropic', 'frontend-design'), { recursive: true });
    const lib = new SkillLibrary(dir, path.join(dir, 'absent'), builtins);
    expect(lib.load('github:anthropic/frontend-design').provenance?.integrity).toBe(true);
    fs.appendFileSync(path.join(dir, 'vendor-skills/anthropic/frontend-design/SKILL.md'), '\nTampered instruction');
    expect(() => lib.load('github:anthropic/frontend-design')).toThrow('checksum');
  });
  it('keeps two agents of the same role on separately assigned models and validates identity', () => {
    const c = loadConfig(root());
    c.namedAgents = ['one', 'two'].map(id => ({ id, name: id, role: 'coder', model: 'model-' + id, skills: [], instructions: '', enabled: true }));
    for (const id of ['one', 'two']) expect(new ModelRouter(c).route({ agentId: id, role: 'coder', taskType: 'coding', complexity: 5, contextTokens: 100, requiresTools: true, requiresLongContext: false }).selectedModel).toBe('model-' + id);
    expect(() => assignedAgent(c, 'one', 'reviewer')).toThrow('không phù hợp');
    c.namedAgents[0].enabled = false; expect(() => assignedAgent(c, 'one', 'coder')).toThrow('không khả dụng');
    expect(() => teamSchema.parse({ namedAgents: [c.namedAgents[1], c.namedAgents[1]] })).toThrow();
  });
  it('uses the assigned role model before higher-scoring pool candidates', () => {
    const c = loadConfig(root()); c.agentProfiles = { tester: { model: 'assigned-tester' } };
    c.modelPool = [{ id: 'high-scoring', tags: ['tools', 'tester'], priority: 999 }];
    const decision = new ModelRouter(c).route({ role: 'tester', taskType: 'testing', complexity: 5, contextTokens: 100, requiresTools: true, requiresLongContext: false });
    expect(decision.selectedModel).toBe('assigned-tester'); expect(decision.fallbacks).toContain('high-scoring');
  });
  it('discovers project skills and selects relevant skills without auto-loading user skills', () => {
    const dir = root(); skill(dir, 'react-ui', 'React interface components');
    const user = path.join(dir, 'user'); fs.mkdirSync(path.join(user, 'react-user'), { recursive: true });
    fs.writeFileSync(path.join(user, 'react-user', 'SKILL.md'), '---\nname: react-user\ndescription: React components\n---\nUser instructions');
    const lib = new SkillLibrary(dir, user);
    expect(lib.search('React')[0].source).toBe('project');
    expect(lib.select('coder', 'React components').map(item => item.id)).toEqual(['builtin:scoped-implementation', 'project:react-ui']);
  });
  it('supports manual selection, disables auto-selection and rejects nonexistent/ambiguous skills', () => {
    const dir = root(); skill(dir, 'code-review', 'Review testing');
    const lib = new SkillLibrary(dir, path.join(dir, 'absent'));
    expect(lib.select('coder', 'Review', { agentProfiles: { coder: { skills: ['project:code-review'], autoSkills: false } } }).map(item => item.id)).toEqual(['project:code-review']);
    expect(() => lib.load('missing')).toThrow('Không tìm'); expect(() => lib.load('code-review')).toThrow('trùng tên');
  });
  it('reads skill resources within the skill folder and blocks traversal and oversized instructions', () => {
    const dir = root(), folder = skill(dir, 'custom', 'Custom'); const lib = new SkillLibrary(dir);
    fs.writeFileSync(path.join(folder, 'reference.md'), 'Reference evidence');
    fs.writeFileSync(path.join(dir, 'outside.md'), 'Outside');
    expect(lib.resource('project:custom', 'reference.md')).toBe('Reference evidence');
    expect(() => lib.resource('project:custom', '../../../outside.md')).toThrow();
    fs.writeFileSync(path.join(folder, 'SKILL.md'), 'x'.repeat(17000)); expect(() => lib.load('project:custom')).toThrow('quá dài');
  });
  it('blocks planner/reviewer writes and commands even if a model fabricates unauthorized tool calls', async () => {
    const dir = root(); fs.writeFileSync(path.join(dir, 'source.ts'), 'original');
    for (const role of ['planner', 'reviewer', 'judge'] as const) {
      const tools = new Tools(dir, async () => true, role);
      expect((await tools.run('write_file', JSON.stringify({ path: 'source.ts', content: 'changed' }))).ok).toBe(false);
      expect((await tools.run('run_command', '{"command":"echo hi"}')).ok).toBe(false);
      expect((await tools.run('read_file', '{"path":"source.ts"}')).ok).toBe(true);
    }
    expect(fs.readFileSync(path.join(dir, 'source.ts'), 'utf8')).toBe('original');
  });
  it('injects selected skills and role instructions, filters tool schemas and refuses bypass calls', async () => {
    const dir = root(); skill(dir, 'custom', 'Custom', 'CUSTOM_SKILL_EVIDENCE');
    const config = { ...loadConfig(dir), agentProfiles: { reviewer: { instructions: 'Review auth carefully', skills: ['project:custom'], autoSkills: false } } };
    const calls: any[] = []; let count = 0;
    const client = { config, chat: vi.fn(async (messages: Message[], tools: any[]) => {
      calls.push({ messages: structuredClone(messages), tools });
      return { content: 'Review', model: config.model, toolCalls: count++ ? [] : [{ id: 'bad', type: 'function', function: { name: 'write_file', arguments: '{"path":"source.ts","content":"bad"}' } }] };
    }) } as unknown as ModelClient;
    await new Agent('reviewer', 'reviewer', dir, client, new ModelRouter(config), new Tools(dir)).run('Review changes');
    expect(calls[0].messages[0].content).toContain('CUSTOM_SKILL_EVIDENCE');
    expect(calls[0].messages[0].content).toContain('Review auth carefully');
    expect(calls[0].tools.some((tool: any) => tool.function.name === 'write_file')).toBe(false);
    expect(calls[1].messages.find((message: Message) => message.role === 'tool').content).toContain('không được');
    expect(fs.existsSync(path.join(dir, 'source.ts'))).toBe(false);
  });
  it('dynamically loads a discovered skill into subsequent system context and reports its exact ID', async () => {
    const dir = root(); skill(dir, 'custom', 'Custom', 'DYNAMIC_SKILL');
    const config = { ...loadConfig(dir), agentProfiles: { general: { autoSkills: false } } }; let count = 0;
    const calls: Message[][] = [], loaded: string[][] = [];
    const client = { config, chat: vi.fn(async (messages: Message[]) => {
      calls.push(structuredClone(messages)); return { content: 'ok', model: config.model, toolCalls: count++ ? [] : [{ id: 'load', type: 'function', function: { name: 'load_skill', arguments: '{"id":"project:custom"}' } }] };
    }) } as unknown as ModelClient;
    await new Agent('general', 'general', dir, client, new ModelRouter(config), new Tools(dir)).run('Custom task', undefined, undefined, [], { onSkills: skills => loaded.push(skills.map(skill => skill.id)) });
    expect(calls[0][0].content).not.toContain('DYNAMIC_SKILL'); expect(calls[1][0].content).toContain('DYNAMIC_SKILL');
    expect(loaded.at(-1)).toContain('project:custom');
  });
  it('matches the user goal rather than incidental skill names in planner metadata', async () => {
    const dir = root(), config = loadConfig(dir); let selected: string[] = [];
    const client = { config, chat: async () => ({ content: 'Hello', toolCalls: [] }) } as unknown as ModelClient;
    await new Agent('plan', 'planner', dir, client, new ModelRouter(config), new Tools(dir, async () => false, 'planner')).run(
      'Catalog metadata contains security audit threat implementation requirements plan', undefined, undefined, [],
      { skillTask: 'Xin chào', onSkills: skills => selected = skills.map(skill => skill.id) }
    );
    expect(selected).toEqual(['builtin:repository-planning']);
  });
  it('validates planner roles, unique IDs and dependency graphs before starting agents', () => {
    const task = { id: 'T1', title: 'Implement', role: 'coder', dependencies: [] };
    expect(parseTeamPlan(JSON.stringify({ tasks: [task] }))[0].role).toBe('coder');
    for (const tasks of [[{ ...task, role: 'invented' }], [task, task], [{ ...task, dependencies: ['missing'] }], [{ ...task, dependencies: ['T1'] }], [{ ...task, id: '../../outside' }]]) expect(() => parseTeamPlan(JSON.stringify({ tasks }))).toThrow();
  });
});
