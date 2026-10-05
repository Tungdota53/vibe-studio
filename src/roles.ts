import { z } from 'zod';
import type { Role } from './types.js';
import type { Config } from './config.js';

export const roles = ['orchestrator', 'planner', 'coder', 'tester', 'reviewer', 'judge', 'general'] as const;
export const roleSchema = z.enum(roles);
export const profileSchema = z.object({
  instructions: z.string().max(6000),
  skills: z.array(z.string().min(1).max(120)).max(8),
  autoSkills: z.boolean(),
  model: z.string().max(200)
});
export type RoleProfile = z.infer<typeof profileSchema>;
export const namedAgentSchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), name: z.string().min(1).max(100), role: roleSchema, model: z.string().max(200).default(''), instructions: z.string().max(6000).default(''), skills: z.array(z.string().min(1).max(120)).max(8).default([]), enabled: z.boolean().default(true) });
export type NamedAgent = z.infer<typeof namedAgentSchema>;
export const teamSchema = z.object({ teamManager:z.boolean().optional(), profiles: z.partialRecord(roleSchema, profileSchema.partial()).optional(), namedAgents: z.array(namedAgentSchema).max(32).refine(items => new Set(items.map(item => item.id)).size === items.length, 'Agent ID bị trùng').optional(), maxAgents: z.number().int().min(1).max(16).optional(), maxAgentIterations: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(), maxAgentToolCalls: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional() });
export const roleCatalog: Record<Role, { label: string; responsibility: string; skill: string; readOnly: boolean }> = {
  orchestrator: { label: 'Điều phối', responsibility: 'Phân việc, theo dõi phụ thuộc và tổng hợp bằng chứng.', skill: 'team-orchestration', readOnly: true },
  planner: { label: 'Lập kế hoạch', responsibility: 'Khảo sát dự án, chia nhiệm vụ và xác định tiêu chí nghiệm thu.', skill: 'repository-planning', readOnly: true },
  coder: { label: 'Lập trình', responsibility: 'Thực hiện thay đổi trong phạm vi tệp được giao và kiểm tra kết quả.', skill: 'scoped-implementation', readOnly: false },
  tester: { label: 'Kiểm thử', responsibility: 'Chạy kiểm tra và báo cáo bằng chứng; không tự sửa mã nguồn.', skill: 'evidence-testing', readOnly: false },
  reviewer: { label: 'Rà soát', responsibility: 'Đọc diff, phát hiện lỗi và báo cáo mức độ ảnh hưởng.', skill: 'code-review', readOnly: true },
  judge: { label: 'Đánh giá', responsibility: 'Đối chiếu yêu cầu, bằng chứng kiểm thử và kết luận nghiệm thu.', skill: 'acceptance-check', readOnly: true },
  general: { label: 'Trợ lý', responsibility: 'Giải quyết yêu cầu và xác minh kết quả bằng công cụ.', skill: 'workspace-assistant', readOnly: false }
};
export function roleProfile(role: Role, config?: Partial<Config>): RoleProfile {
  return profileSchema.parse({ instructions: '', autoSkills: true, model: '', skills: [`builtin:${roleCatalog[role].skill}`], ...config?.agentProfiles?.[role] });
}
export function canUseTool(role: Role, name: string, readOnlyTask = false) {
  if (readOnlyTask && ['write_file', 'edit_file', 'run_command', 'run_tests'].includes(name)) return false;
  if (['write_file', 'edit_file'].includes(name)) return role === 'coder' || role === 'general';
  if (['run_command', 'run_tests'].includes(name)) return !roleCatalog[role].readOnly;
  return true;
}
export function assignedAgent(config: Partial<Config>, id: string | undefined, role: Role) {
  if (!id) return undefined;
  const agent = config.namedAgents?.find(item => item.id === id);
  if (!agent || !agent.enabled) throw new Error(`Agent không khả dụng: ${id}`);
  if (agent.role !== role) throw new Error(`Agent ${id} có vai ${agent.role}, không phù hợp vai ${role}`);
  return agent.instructions === 'Test web interfaces. Check Python and Playwright availability before browser tests.' ? { ...agent, instructions: defaultAgents.find(item => item.id === 'web-tester')!.instructions } : agent;
}
export const defaultAgents: NamedAgent[] = [
  { id:'team-manager',name:'Team Manager',role:'orchestrator',skills:[],instructions:'Manage only the existing goal and task contracts. Delegate necessary agents from evidence; do not rewrite completed work or claim acceptance without executed verification.',model:'',enabled:true },
  { id: 'frontend', name: 'Frontend', role: 'coder', skills: ['github:anthropic/frontend-design'], instructions: 'Build and refine user interfaces.', model: '', enabled: true },
  { id: 'backend', name: 'Backend', role: 'coder', skills: [], instructions: 'Implement backend and data logic.', model: '', enabled: true },
  { id: 'web-tester', name: 'Web Tester', role: 'tester', skills: ['github:anthropic/webapp-testing'], instructions: 'Test web interfaces using the project runtime and existing test scripts. Node Playwright does not require Python. Save JSON evidence with write_report.', model: '', enabled: true },
  { id: 'security-review', name: 'Security Reviewer', role: 'reviewer', skills: ['github:openai/security-best-practices'], instructions: 'Review security when assigned a security task. Report findings without changing code.', model: '', enabled: true },
  { id: 'planner', name: 'Planner', role: 'planner', skills: [], instructions: '', model: '', enabled: true },
  { id: 'assistant', name: 'Assistant', role: 'general', skills: [], instructions: '', model: '', enabled: true },
  { id: 'explorer', name: 'Explorer', role: 'planner', skills: ['github:trailofbits/audit-context-building'], instructions: 'Survey entry points, architecture, existing tests and constraints. Produce evidence with file paths; do not implement changes.', model: '', enabled: true },
  { id: 'ui-ux', name: 'UI/UX Designer', role: 'coder', skills: ['github:uiux/ui-ux-pro-max'], instructions: 'Own assigned interface files. Check accessibility, layout, typography and responsive behavior. Use references on demand.', model: '', enabled: true },
  { id: 'test-writer', name: 'Test Writer', role: 'coder', skills: ['github:trailofbits/property-based-testing'], instructions: 'Write meaningful tests in explicitly assigned test files. Demonstrate failure before the fix where appropriate. Do not edit production files unless separately assigned.', model: '', enabled: true },
  { id: 'challenger', name: 'Challenger', role: 'tester', skills: ['github:superpowers/verification-before-completion'], instructions: 'Try to refute implementation claims with malformed inputs, boundary cases and concurrency checks. Execute checks independently. Do not change source files; report reproductions and missing prerequisites.', model: '', enabled: true },
  { id: 'auditor', name: 'Independent Auditor', role: 'tester', skills: ['github:superpowers/verification-before-completion'], instructions: 'Audit the final artifact independently. Run fresh build/tests in the actual implementation workspace. Treat handoff claims as unverified. Cite commands, exit codes, findings and validation gaps. Do not change source files.', model: '', enabled: true },
  { id: 'acceptance', name: 'Acceptance Judge', role: 'judge', skills: ['github:superpowers/verification-before-completion'], instructions: 'Compare requirements with recorded evidence and reviewer findings. Never declare success solely from agent summaries. Report PASS, FAIL or UNVERIFIED with reasons.', model: '', enabled: true },
  { id: 'spec-backend', name: 'Backend Spec Miner', role: 'planner', skills: [], instructions: 'Extract requirements, API contracts, failure cases and acceptance criteria from the request and actual code. Produce a specification for implementers without editing source.', model: '', enabled: true },
  { id: 'spec-ui', name: 'UI Spec Miner', role: 'planner', skills: [], instructions: 'Extract UI requirements, interactions, accessibility constraints and acceptance criteria. Specify ownership and verification without editing source.', model: '', enabled: true },
  { id: 'victory-auditor', name: 'Final Victory Auditor', role: 'tester', skills: ['github:superpowers/verification-before-completion'], instructions: 'Run a final fresh audit: trace original requirements, inspect real implementation and test binding, then independently execute required build/tests. Prior verdicts are withheld. Any integrity finding vetoes success. Never modify source or accept another agent summary as proof.', model: '', enabled: true }
];
