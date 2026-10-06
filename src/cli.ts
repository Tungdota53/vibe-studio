#!/usr/bin/env node
import { BackgroundProcesses } from './background-processes.js';
import readline from 'node:readline/promises';
import process from 'node:process';
import { loadConfig, assertConfigured } from './config.js';
import { Store } from './db.js';
import { ModelClient } from './model.js';
import { ModelRouter } from './router.js';
import { Tools, toolDefinitions } from './tools.js';
import { Agent } from './agent.js';
import { Teamwork } from './teamwork.js';
import { SshManager } from './ssh.js';
import {
  renderBanner,
  renderApprovalCard,
  renderHelp,
  renderTable,
  completer,
  formatDiff,
  formatTestResults,
  renderMarkdown,
  TeamworkDashboard,
  SequentialFallbackLogger,
  isInteractiveEnvironment,
} from './ui/index.js';
import { startStudio, type StudioServerInstance } from './studio/server.js';
import crypto from 'node:crypto';
import { ConversationContext } from './conversation.js';
import { systemPrompt } from './prompts.js';
import { SkillLibrary } from './skills.js';
import { roles, roleCatalog, roleProfile } from './roles.js';


let c = loadConfig();
const db = new Store(`${c.workspace}/.vibe`);
let client = new ModelClient(c);
let router = new ModelRouter(c);
let chatSession = `chat-${crypto.randomUUID()}`;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  completer,
});

let teamwork: Teamwork | undefined;
let studioInstance: StudioServerInstance | undefined;

const approve = async (cmd: string): Promise<boolean> => {
  console.log(renderApprovalCard(cmd));
  const answer = await rl.question('Nhập APPROVE để cho phép một lần: ');
  return answer.trim() === 'APPROVE';
};

async function command(line: string): Promise<boolean> {
  const [cmd, ...parts] = line.slice(1).split(' ');
  const arg = parts.join(' ').trim();

  switch (cmd) {
    case 'skills': {
      console.log(renderTable(['Skill ID', 'Description'], new SkillLibrary(c.workspace).search(arg).map(skill => [skill.id, skill.description])));
      break;
    }
    case 'roles': {
      console.log(renderTable(['Role', 'Responsibility', 'Model', 'Skills'], roles.map(role => [role, roleCatalog[role].responsibility, roleProfile(role, c).model || c.model, roleProfile(role, c).skills.join(', ')])));
      break;
    }
    case 'studio': {
      if (studioInstance) {
        console.log(`Vibe Studio đang chạy tại: ${studioInstance.url}`);
        break;
      }
      const parsedPort = arg ? parseInt(arg, 10) : undefined;
      const port = parsedPort && !isNaN(parsedPort) ? parsedPort : 3840;
      try {
        studioInstance = await startStudio({
          port,
          openBrowser: isInteractiveEnvironment(),
        });
        console.log(`\n🚀 Vibe Studio (Codex & Antigravity Style) đã khởi chạy!`);
        console.log(`🌐 Đường dẫn: ${studioInstance.url}\n`);
      } catch (err: any) {
        console.error(`Không thể khởi chạy Vibe Studio: ${err?.message || err}`);
      }
      break;
    }
    case 'help': {
      console.log(renderHelp());
      break;
    }
    case 'model': {
      if (arg) {
        c = { ...c, model: arg, models: {}, modelPool: [{ id: arg, priority: 100, tags: ['coding', 'tools', 'reasoning'] }] };
        client = new ModelClient(c); router = new ModelRouter(c);
      }
      console.log(c.model);
      break;
    }
    case 'models': {
      assertConfigured(c);
      console.log((await client.models()).join('\n'));
      break;
    }
    case 'model-role': {
      const [r, m] = parts;
      c.models[r] = m;
      console.log(`${r}: ${m}`);
      break;
    }
    case 'model-pool': {
      const head = ['Model ID', 'Priority', 'Tags', 'Context', 'Latency', 'Cost'];
      const rows = (c.modelPool || []).map(m => [
        m.id,
        m.priority,
        m.tags?.join(', ') || '-',
        m.maxContext ?? '-',
        m.estimatedLatencyClass ?? '-',
        m.estimatedCostClass ?? '-',
      ]);
      console.log(renderTable(head, rows));
      break;
    }
    case 'router-status': {
      const head = ['Model', 'Success', 'Fail', 'Avg Latency'];
      const rows = router.status().map(([model, x]) => [
        model,
        x.ok,
        x.fail,
        `${Math.round(x.latency)}ms`,
      ]);
      console.log(renderTable(head, rows));
      break;
    }
    case 'quality': {
      if (['fast', 'balanced', 'high', 'max'].includes(arg)) {
        c = { ...c, quality: arg as any };
        console.log(`Quality: ${arg}`);
      } else {
        console.log(c.quality);
      }
      break;
    }
    case 'teamwork': {
      assertConfigured(c);
      teamwork = new Teamwork(c, db, client, router, approve);
      if (isInteractiveEnvironment()) {
        const dashboard = new TeamworkDashboard();
        dashboard.start();
        try {
          const res = await teamwork.run(arg, (event) => dashboard.onEvent(event));
          dashboard.stop(res);
        } catch (err) {
          dashboard.stop({ status: 'failed', error: String(err) });
          throw err;
        }
      } else {
        const fallbackLogger = new SequentialFallbackLogger();
        fallbackLogger.start({ goal: arg });
        try {
          const res = await teamwork.run(arg, (event) => fallbackLogger.onEvent(event));
          fallbackLogger.stop(res);
        } catch (err) {
          fallbackLogger.stop({ status: 'failed', error: String(err) });
          throw err;
        }
      }
      break;
    }
    case 'agents': {
      const head = ['Agent ID', 'Role', 'Status', 'Model'];
      const rows = teamwork
        ? [...teamwork.agents.entries()].map(([id, x]) => [id, x.role, x.status, x.model])
        : [];
      console.log(renderTable(head, rows));
      break;
    }
    case 'tasks': {
      const head = ['Task ID', 'Role', 'Status', 'Title', 'Dependencies'];
      const rows = (teamwork?.tasks || []).map(t => [
        t.id,
        t.role,
        t.status,
        t.title,
        (t.dependencies || []).join(', ') || '-',
      ]);
      console.log(renderTable(head, rows));
      break;
    }
    case 'status': {
      console.log(`Model: ${c.model} Quality: ${c.quality} Workspace: ${c.workspace}`);
      break;
    }
    case 'plan': {
      const head = ['Task ID', 'Role', 'Status', 'Title', 'Dependencies'];
      const rows = (teamwork?.tasks || []).map(t => [
        t.id,
        t.role,
        t.status,
        t.title,
        (t.dependencies || []).join(', ') || '-',
      ]);
      console.log(renderTable(head, rows));
      break;
    }
    case 'diff': {
      const res = await new Tools(c.workspace, approve).run('git_diff', '{}');
      if (!res.ok) {
        console.error(res.error || 'Lỗi khi lấy git diff');
      } else {
        console.log(formatDiff(res.output || ''));
      }
      break;
    }
    case 'test': {
      const res = await new Tools(c.workspace, approve).run('run_tests', '{}');
      console.log(formatTestResults(res));
      break;
    }
    case 'review': {
      assertConfigured(c);
      const findings = await new Agent(
        'agent-review-manual',
        'reviewer',
        c.workspace,
        client,
        router,
        new Tools(c.workspace, approve)
      ).run('Review current git diff and test evidence. Return structured severity findings.');
      console.log(renderMarkdown(findings));
      break;
    }
    case 'logs': {
      console.log(`${c.workspace}/.vibe/sessions`);
      break;
    }
    case 'stop': {
      teamwork?.stop();
      console.log('Đã gửi cancellation signal');
      break;
    }
    case 'clear': {
      console.clear();
      chatSession = `chat-${crypto.randomUUID()}`;
      break;
    }
    case 'resume': {
      if (!arg.startsWith('chat-') || !db.db.prepare('SELECT id FROM sessions WHERE id=?').get(arg)) throw new Error('Dùng /resume <chat-session-id> từ /sessions.');
      chatSession = arg;
      console.log(`Đã mở lại ngữ cảnh ${chatSession}.`);
      break;
    }
    case 'compact': {
      assertConfigured(c);
      const manager = new ConversationContext(c, db.conversation(chatSession), undefined, memory => db.saveConversation(chatSession, memory));
      await manager.prepare(systemPrompt('general', c.workspace), toolDefinitions, client, c.model, undefined, true);
      console.log(`Ngữ cảnh: ~${manager.stats(systemPrompt('general', c.workspace), toolDefinitions).percent}%; số lần nén: ${manager.state.compactions}`);
      break;
    }
    case 'sessions': {
      const head = ['Session ID', 'Status', 'Model', 'Task', 'Updated'];
      const sessions = db.sessions() as Array<{
        id: string;
        status: string;
        model: string;
        task?: string;
        updated_at?: string;
      }>;
      const rows = sessions.map(s => [
        s.id,
        s.status,
        s.model,
        s.task ? (s.task.length > 32 ? s.task.slice(0, 29) + '...' : s.task) : '-',
        s.updated_at || '-',
      ]);
      console.log(renderTable(head, rows));
      break;
    }
    case 'ssh': {
      const ssh = new SshManager(c);
      if (parts[0] === 'list') {
        console.log(ssh.list().join('\n'));
      } else if (parts[0] === 'exec') {
        const host = parts[1];
        const text = parts.slice(2).join(' ');
        console.log(await ssh.exec(host, text, undefined, false));
      } else {
        console.log('/ssh list | /ssh exec <host> <command>');
      }
      break;
    }
    case 'exit': {
      if (studioInstance) {
        await studioInstance.close();
        studioInstance = undefined;
      }
      return false;
    }
    default: {
      console.log('Lệnh không rõ. Gõ /help để xem danh sách lệnh.');
    }
  }
  return true;
}

async function main() {
  console.log(renderBanner(c));

  let interrupted = 0;
  process.on('SIGINT', async () => {
    if (++interrupted === 1) {
      teamwork?.stop();
      console.log('\nĐã yêu cầu dừng an toàn. Ctrl+C lần nữa để thoát.');
    } else {
      if (studioInstance) {
        await studioInstance.close();
        studioInstance = undefined;
      }
      db.close();
      await BackgroundProcesses.closeAll();
      process.exit(130);
    }
  });

  while (true) {
    const line = (await rl.question('> ')).trim();
    if (!line) continue;
    try {
      if (line.startsWith('/')) {
        if (!(await command(line))) break;
      } else {
        assertConfigured(c);
        const memory = db.conversation(chatSession);
        db.session(chatSession, 'running', c.model, line.slice(0, 100));
        const out = await new Agent(
          'agent-general',
          'general',
          c.workspace,
          client,
          router,
          new Tools(c.workspace, approve)
        ).run(line, undefined, undefined, [], {
          state: memory, sessionId:chatSession,
          checkpoint: state => db.saveConversation(chatSession, state),
          onItem: item => {
            db.archiveItem(chatSession, item);
            if (item.role === 'user' || (item.role === 'assistant' && !item.tool_calls?.length)) db.db.prepare('INSERT INTO messages(session_id,agent_id,ts,content) VALUES(?,?,?,?)').run(chatSession, item.role, new Date().toISOString(), item.content || '');
          }
        });
        db.session(chatSession, 'completed', c.model);
        if (out) {
          console.log(renderMarkdown(out));
        }
        console.log();
      }
    } catch (e) {
      if (!line.startsWith('/')) db.session(chatSession, 'failed', c.model);
      console.error(e instanceof Error ? e.message : e);
    } finally { await BackgroundProcesses.forWorkspace(c.workspace).stopSession(chatSession); }
  }
  if (studioInstance) {
    await studioInstance.close();
    studioInstance = undefined;
  }
  rl.close();
  db.close();
}

main().catch(async (e) => {
  console.error(e);
  if (studioInstance) {
    await studioInstance.close();
    studioInstance = undefined;
  }
  db.close();
  process.exitCode = 1;
});
