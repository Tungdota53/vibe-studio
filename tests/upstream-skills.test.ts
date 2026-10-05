import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SkillLibrary } from '../src/skills.js';
import { recommendationScore } from '../src/skill-routing.js';

async function removeTemp(root: string) {
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    if (process.platform !== 'win32') throw error;
    await new Promise(resolve => setTimeout(resolve, 100));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
const roots: string[] = [];
function workspace() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-upstream-skills-')); roots.push(dir); return dir; }
afterEach(async () => {
  for (const dir of roots.splice(0)) await removeTemp(dir);
});
describe('Reviewed upstream skill adapters', () => {
  it('retains exact source commits, MIT licenses, adapter attribution and verified references', () => {
    const library = new SkillLibrary(workspace());
    const sources = library.list().filter(skill => /github:(agency|agent-reach|orca)\//.test(skill.id));
    expect(sources).toHaveLength(10);
    for (const skill of sources) {
      expect(skill.provenance).toMatchObject({ license: 'MIT', integrity: true, adaptation: expect.stringContaining('Vibe-authored') });
      expect(skill.provenance?.commit).toMatch(/^[a-f0-9]{40}$/);
      expect(skill.provenance?.sourcePaths?.length).toBeGreaterThan(0);
      const instructions = library.load(skill.id, sources).instructions;
      expect(instructions).toContain('User instructions and Vibe role/tool permissions govern execution.');
      expect(instructions).toContain(skill.provenance!.commit);
      expect(library.resource(skill.id, 'LICENSE.txt')).toContain('MIT License');
    }
    expect(library.resource('github:agent-reach/public-web-research', 'references/source-1.py')).toContain('active_backend');
    expect(library.resource('github:orca/isolated-agent-workflows', 'references/source-2.md')).toContain('immutable version');
  });
  it('selects domain adapters for applicable roles while respecting the existing prompt and count bounds', () => {
    const library = new SkillLibrary(workspace());
    const cases = [
      ['coder', 'frontend component accessibility keyboard state management responsive animation', 'github:agency/frontend-engineering'],
      ['coder', 'backend api contract transaction idempotency database persistence', 'github:agency/backend-architecture'],
      ['tester', 'test automation flaky fixture deterministic integration', 'github:agency/test-automation'],
      ['reviewer', 'appsec ssrf path traversal authorization credential exposure', 'github:agency/application-security'],
      ['planner', 'multi-agent parallel fan-out orchestration context budget teamwork', 'github:agency/multi-agent-architecture'],
      ['planner', 'worktree isolated workspace task dag worker completion skill provenance', 'github:orca/isolated-agent-workflows'],
      ['general', 'public web internet web research github source', 'github:agent-reach/public-web-research']
    ] as const;
    for (const [role, task, expected] of cases) {
      const skills = library.select(role, task);
      expect(skills.map(skill => skill.id)).toContain(expected);
      expect(skills.length).toBeLessThanOrEqual(8);
      expect(skills.reduce((sum, skill) => sum + skill.instructions.length, 0)).toBeLessThanOrEqual(24000);
    }
    expect(recommendationScore('github:agency/application-security', 'tester', 'appsec ssrf')).toBe(0);
    expect(library.select('general', 'internet', { agentProfiles: { general: { autoSkills: false } } }).map(skill => skill.id)).not.toContain('github:agent-reach/public-web-research');
  }, 15000);
  it('rejects modified source references and excludes them from automatic recommendations', () => {
    const dir = workspace();
    const builtins = path.join(dir, 'skills');
    fs.mkdirSync(builtins);
    const destination = path.join(dir, 'vendor-skills', 'agent-reach', 'public-web-research');
    fs.cpSync('src/vendor-skills/agent-reach/public-web-research', destination, { recursive: true });
    const library = new SkillLibrary(dir, path.join(dir, 'absent'), builtins);
    expect(library.load('github:agent-reach/public-web-research').provenance?.integrity).toBe(true);
    fs.appendFileSync(path.join(destination, 'references/source-1.py'), '\n# modified source');
    expect(() => library.load('github:agent-reach/public-web-research')).toThrow('checksum');
    expect(library.select('general', 'public web internet', { agentProfiles: { general: { skills: [] } } }).map(skill => skill.id)).not.toContain('github:agent-reach/public-web-research');
  });
});
