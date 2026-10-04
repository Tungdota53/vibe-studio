import type { Role } from './types.js';

/** Reviewed bundled sources only. Local/user skills keep their existing opt-in rules. */
export const skillRoutes: Record<string, { roles: Role[]; topics: string[]; requires?: string[] }> = {
  'builtin:project-assessment': { roles: ['planner','reviewer'], topics: ['audit','security','bảo mật','khảo sát','dependency','electron'] },
  'builtin:dependency-evidence': { roles: ['coder','tester','reviewer'], topics: ['dependency','npm audit','supply chain','chuỗi cung ứng','lỗ hổng'] },
  'builtin:electron-security-review': { roles: ['coder','tester','reviewer'], topics: ['electron','desktop','preload','ipc','asar'] },
  'github:anthropic/frontend-design': { roles: ['coder'], topics: ['frontend', 'interface', 'ui', 'giao diện', 'thiết kế'] },
  'github:anthropic/webapp-testing': { roles: ['tester'], topics: ['browser', 'playwright', 'website', 'web', 'giao diện'], requires: ['Project browser test runtime (Node or Python)', 'Playwright', 'browser binaries'] },
  'github:openai/security-best-practices': { roles: ['coder', 'reviewer'], topics: ['security', 'bảo mật', 'authentication', 'authorization'] },
  'github:openai/security-threat-model': { roles: ['planner', 'reviewer'], topics: ['threat', 'đe dọa', 'trust boundary', 'attack surface'] },
  'github:superpowers/writing-plans': { roles: ['planner'], topics: ['plan', 'kế hoạch', 'implementation', 'triển khai'] },
  'github:superpowers/brainstorming': { roles: ['planner'], topics: ['brainstorm', 'ý tưởng', 'requirements', 'yêu cầu'] },
  'github:superpowers/test-driven-development': { roles: ['coder'], topics: ['tdd', 'test first', 'viết test', 'test-driven'] },
  'github:superpowers/systematic-debugging': { roles: ['coder', 'tester'], topics: ['debug', 'bug', 'lỗi', 'failed', 'regression'] },
  'github:superpowers/verification-before-completion': { roles: ['tester', 'judge'], topics: ['verify', 'verification', 'xác minh', 'nghiệm thu'] },
  'github:superpowers/receiving-code-review': { roles: ['coder'], topics: ['review feedback', 'review findings', 'phản hồi review'] },
  'github:superpowers/requesting-code-review': { roles: ['reviewer'], topics: ['review', 'rà soát', 'code review'] },
  'github:trailofbits/audit-context-building': { roles: ['planner', 'reviewer'], topics: ['audit', 'security', 'bảo mật', 'khảo sát'] },
  'github:trailofbits/differential-review': { roles: ['reviewer'], topics: ['diff', 'security review', 'review bảo mật'] },
  'github:trailofbits/sharp-edges': { roles: ['reviewer'], topics: ['unsafe', 'dangerous', 'configuration', 'cấu hình', 'footgun'] },
  'github:trailofbits/supply-chain-risk-auditor': { roles: ['reviewer'], topics: ['dependency', 'dependencies', 'supply chain', 'npm', 'chuỗi cung ứng'] },
  'github:trailofbits/variant-analysis': { roles: ['reviewer'], topics: ['variant', 'vulnerability', 'lỗ hổng', 'similar bugs'] },
  'github:trailofbits/semgrep': { roles: ['tester'], topics: ['semgrep', 'static analysis', 'phân tích tĩnh'], requires: ['Semgrep CLI'] },
  'github:trailofbits/codeql': { roles: ['tester'], topics: ['codeql'], requires: ['CodeQL CLI', 'CodeQL databases'] },
  'github:trailofbits/sarif-parsing': { roles: ['tester', 'reviewer'], topics: ['sarif'], requires: ['SARIF report'] },
  'github:trailofbits/property-based-testing': { roles: ['coder', 'tester'], topics: ['property-based', 'fast-check', 'hypothesis', 'invariant', 'parser', 'validator'] },
  'github:trailofbits/mutation-testing': { roles: ['tester'], topics: ['mutation', 'mutant', 'stryker', 'kiểm thử đột biến'], requires: ['Project mutation-testing runner'] },
  'github:trailofbits/post-patch-validation': { roles: ['tester'], topics: ['patch', 'regression', 'bản vá', 'hồi quy'] },
  'github:trailofbits/coverage-analysis': { roles: ['tester'], topics: ['coverage', 'độ phủ'], requires: ['Project coverage runner'] },
  'github:trailofbits/harness-writing': { roles: ['coder', 'tester'], topics: ['fuzz', 'harness'], requires: ['Project fuzzing toolchain'] },
  'github:uiux/ui-ux-pro-max': { roles: ['coder', 'reviewer'], topics: ['ux', 'ui', 'giao diện', 'accessibility', 'responsive', 'thiết kế'], requires: ['Python 3 for optional data search'] },
  'github:uiux/ui-styling': { roles: ['coder'], topics: ['tailwind', 'shadcn', 'styling', 'css'] },
  'github:uiux/design-system': { roles: ['coder', 'reviewer'], topics: ['design system', 'design tokens', 'hệ thống thiết kế', 'typography'] },
  'github:agency/frontend-engineering': { roles: ['coder'], topics: ['frontend', 'component', 'accessibility', 'keyboard', 'state management', 'responsive', 'animation'] },
  'github:agency/backend-architecture': { roles: ['planner', 'coder'], topics: ['backend', 'api contract', 'transaction', 'idempotency', 'database', 'persistence'] },
  'github:agency/ux-architecture': { roles: ['planner', 'coder', 'reviewer'], topics: ['user journey', 'navigation', 'ux architecture', 'information architecture', 'reduced motion', 'luồng người dùng'] },
  'github:agency/application-security': { roles: ['coder', 'reviewer'], topics: ['appsec', 'ssrf', 'authorization', 'path traversal', 'credential exposure', 'prompt injection'] },
  'github:agency/test-automation': { roles: ['tester'], topics: ['test automation', 'flaky', 'fixture', 'deterministic', 'integration', 'kiểm thử tự động'] },
  'github:agency/verification-evidence': { roles: ['tester', 'judge'], topics: ['acceptance evidence', 'exit status', 'unverified', 'verification evidence', 'bằng chứng nghiệm thu'] },
  'github:agency/multi-agent-architecture': { roles: ['orchestrator', 'planner'], topics: ['multi-agent', 'parallel', 'fan-out', 'orchestration', 'context budget', 'đa luồng', 'teamwork'] },
  'github:agency/code-review': { roles: ['reviewer'], topics: ['source diff', 'correctness regression', 'review finding', 'code review', 'rà soát mã'] },
  'github:agent-reach/public-web-research': { roles: ['general', 'planner', 'reviewer'], topics: ['public web', 'internet', 'web research', 'github source', 'nghiên cứu tài liệu', 'nguồn công khai'], requires: ['Vibe read_public_url or another available public-source tool'] },
  'github:orca/isolated-agent-workflows': { roles: ['orchestrator', 'planner'], topics: ['worktree', 'isolated workspace', 'task dag', 'worker completion', 'skill provenance', 'cô lập workspace'] }
};

export function recommendationScore(id: string, role: Role, task: string) {
  const route = skillRoutes[id];
  if (!route?.roles.includes(role)) return 0;
  const text = task.toLowerCase();
  // ASCII words such as UI must not accidentally match "build" or "suite".
  return route.topics.reduce((score, topic) => score + (new RegExp(`(^|[^a-z0-9])${topic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`, 'iu').test(text) ? 1 : 0), 0);
}
