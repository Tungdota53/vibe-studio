import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  TeamworkDashboard,
  SequentialFallbackLogger,
  isInteractiveEnvironment,
  isNonInteractive,
} from '../src/ui/index.js';
import type { TeamworkEvent } from '../src/types.js';
import { Teamwork } from '../src/teamwork.js';
import { Store } from '../src/db.js';
import { ModelRouter } from '../src/router.js';
import { loadConfig, type Config } from '../src/config.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g;
const stripAnsi = (str: string): string => str.replace(ANSI_REGEX, '');

describe('Milestone M3: Live Dashboard & Non-TTY Fallback', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...savedEnv };
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  /* -------------------------------------------------------------------------- */
  /* Fallback Environment Detection                                             */
  /* -------------------------------------------------------------------------- */
  describe('Environment Detection (fallback.ts)', () => {
    it('detects interactive environment when TTY is true and no CI flags', () => {
      delete process.env.CI;
      delete process.env.CONTINUOUS_INTEGRATION;
      process.env.TERM = 'xterm-256color';
      const mockStream = { isTTY: true } as any;

      expect(isInteractiveEnvironment(mockStream)).toBe(true);
      expect(isNonInteractive(mockStream)).toBe(false);
    });

    it('detects non-interactive environment when CI is true', () => {
      process.env.CI = '1';
      const mockStream = { isTTY: true } as any;

      expect(isInteractiveEnvironment(mockStream)).toBe(false);
      expect(isNonInteractive(mockStream)).toBe(true);
    });

    it('detects non-interactive environment when CONTINUOUS_INTEGRATION is true', () => {
      delete process.env.CI;
      process.env.CONTINUOUS_INTEGRATION = 'true';
      const mockStream = { isTTY: true } as any;

      expect(isInteractiveEnvironment(mockStream)).toBe(false);
      expect(isNonInteractive(mockStream)).toBe(true);
    });

    it('detects non-interactive environment when TERM is dumb', () => {
      delete process.env.CI;
      delete process.env.CONTINUOUS_INTEGRATION;
      process.env.TERM = 'dumb';
      const mockStream = { isTTY: true } as any;

      expect(isInteractiveEnvironment(mockStream)).toBe(false);
      expect(isNonInteractive(mockStream)).toBe(true);
    });

    it('detects non-interactive environment when stream is not TTY', () => {
      delete process.env.CI;
      delete process.env.CONTINUOUS_INTEGRATION;
      process.env.TERM = 'xterm-256color';
      const mockStream = { isTTY: false } as any;

      expect(isInteractiveEnvironment(mockStream)).toBe(false);
      expect(isNonInteractive(mockStream)).toBe(true);
    });
  });

  /* -------------------------------------------------------------------------- */
  /* SequentialFallbackLogger                                                   */
  /* -------------------------------------------------------------------------- */
  describe('SequentialFallbackLogger', () => {
    it('initializes and logs sequential timestamped start line', () => {
      const logger = new SequentialFallbackLogger({ silent: true });
      expect(logger.isRunning).toBe(false);

      logger.start({ id: 'session-test-01', goal: 'Test goal execution' });
      expect(logger.isRunning).toBe(true);

      const lines = logger.getLines();
      expect(lines.length).toBe(1);
      expect(lines[0]).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] \[SESSION_START\]/);
      expect(lines[0]).toContain('session-test-01');
      expect(lines[0]).toContain('Test goal execution');
    });

    it('produces zero ANSI escape sequences across all logged lines', () => {
      const logger = new SequentialFallbackLogger({ silent: true });
      logger.start({ id: 's1' });

      logger.onEvent({
        type: 'planner_start',
        agentId: 'planner-01',
        role: 'planner',
        message: 'Planning DAG',
      });
      logger.onEvent({
        type: 'task_start',
        agentId: 'coder-01',
        role: 'coder',
        message: 'Implementing feature',
      });
      logger.log('Detailed agent log entry without colors');
      logger.onEvent({
        type: 'task_complete',
        agentId: 'coder-01',
        role: 'coder',
        message: 'Feature implemented',
      });
      logger.stop({ status: 'completed', tasksCompleted: 1, verified: true });

      for (const line of logger.getLines()) {
        expect(line).not.toMatch(ANSI_REGEX);
      }
    });

    it('formats string events cleanly with [INFO] tag', () => {
      const logger = new SequentialFallbackLogger({ silent: true });
      logger.onEvent('Legacy string event message');

      const lines = logger.getLines();
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain('[INFO] Legacy string event message');
      expect(lines[0]).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/);
    });

    it('handles task failure event with [TASK_FAILED] and status tag', () => {
      const logger = new SequentialFallbackLogger({ silent: true });
      logger.onEvent({
        type: 'task_failed',
        agentId: 'tester-01',
        role: 'tester',
        status: 'failed',
        message: 'Vitest assertion failed at line 42',
      });

      const lines = logger.getLines();
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain('[TASK_FAILED]');
      expect(lines[0]).toContain('[tester]');
      expect(lines[0]).toContain('tester-01');
      expect(lines[0]).toContain('[status: failed]');
      expect(lines[0]).toContain('Vitest assertion failed at line 42');
    });

    it('renders clean plaintext summary table on stop()', () => {
      const logger = new SequentialFallbackLogger({ silent: true });
      logger.start({ id: 's-summary' });
      logger.stop({
        id: 's-summary',
        status: 'completed',
        tasksCompleted: 4,
        tasks: [{}, {}, {}, {}],
        verified: true,
      });

      const output = logger.getLines().join('\n');
      expect(output).toContain('[SESSION_COMPLETE]');
      expect(output).toContain('Metric');
      expect(output).toContain('Value');
      expect(output).toContain('Tasks Completed');
      expect(output).toContain('4');
      expect(output).not.toMatch(ANSI_REGEX);
    });
  });

  /* -------------------------------------------------------------------------- */
  /* TeamworkDashboard                                                          */
  /* -------------------------------------------------------------------------- */
  describe('TeamworkDashboard (dual-zone viewport & state)', () => {
    it('tracks active agents and transitions through planner -> coder -> tester lifecycle', () => {
      const dash = new TeamworkDashboard({ isTTY: false, silent: true });
      dash.start();

      dash.onEvent({ type: 'session_start', message: 'Session started' });
      dash.onEvent({ type: 'planner_start', agentId: 'planner-01', role: 'planner' });
      expect(dash.agents.get('planner-01')?.status).toBe('running');

      dash.onEvent({ type: 'planner_done', agentId: 'planner-01', role: 'planner' });
      expect(dash.agents.get('planner-01')?.status).toBe('idle');

      dash.onEvent({ type: 'task_start', agentId: 'coder-01', role: 'coder', message: 'T1' });
      expect(dash.agents.get('coder-01')?.status).toBe('running');

      dash.onEvent({ type: 'task_complete', agentId: 'coder-01', role: 'coder', message: 'T1 done' });
      expect(dash.agents.get('coder-01')?.status).toBe('completed');

      dash.stop({ status: 'completed', tasksCompleted: 1 });
      expect(dash.isRunning).toBe(false);
      expect(dash.summary.status).toBe('completed');
    });

    it('correctly records failed agent state and error message', () => {
      const dash = new TeamworkDashboard({ isTTY: false, silent: true });
      dash.start();

      dash.onEvent({ type: 'task_start', agentId: 'coder-01', role: 'coder', message: 'Compile TS' });
      dash.onEvent({
        type: 'task_failed',
        agentId: 'coder-01',
        role: 'coder',
        message: 'Compilation error: cannot find module',
      });

      const agent = dash.agents.get('coder-01');
      expect(agent?.status).toBe('failed');
      expect(agent?.error).toBe('Compilation error: cannot find module');

      dash.stop({ status: 'failed' });
      expect(dash.summary.status).toBe('failed');
    });

    it('handles cancellation path correctly', () => {
      const dash = new TeamworkDashboard({ isTTY: false, silent: true });
      dash.start();

      dash.onEvent({ type: 'task_start', agentId: 'coder-02', role: 'coder', message: 'Long build' });
      dash.onEvent({
        type: 'task_failed',
        agentId: 'coder-02',
        role: 'coder',
        status: 'cancelled',
        message: 'Operation aborted by user',
      });

      const agent = dash.agents.get('coder-02');
      expect(agent?.status).toBe('cancelled');
      expect(agent?.error).toBe('Operation aborted by user');
      dash.stop();
    });

    it('safely buffers logs without modifying event count', () => {
      const dash = new TeamworkDashboard({ isTTY: false, silent: true });
      dash.start();

      dash.onEvent({ type: 'task_start', agentId: 'coder-01', role: 'coder', message: 'T1' });
      dash.log('Upper zone message 1');
      dash.log('Upper zone message 2');
      dash.onEvent({ type: 'task_complete', agentId: 'coder-01', role: 'coder' });

      expect(dash.logs).toEqual(['Upper zone message 1', 'Upper zone message 2']);
      expect(dash.events.length).toBe(2);
      dash.stop();
    });

    it('tick() cycles spinner frames without crashing', () => {
      const dash = new TeamworkDashboard({ isTTY: false, silent: true });
      dash.start();

      // Tick multiple times to test frame rotation
      for (let i = 0; i < 20; i++) {
        dash.tick();
      }

      dash.stop();
      expect(dash.isRunning).toBe(false);
    });

    it('renderStatusMatrix() outputs table with all active agents and actions', () => {
      const dash = new TeamworkDashboard({ isTTY: false, silent: true });
      dash.onEvent({ type: 'planner_start', agentId: 'planner-01', role: 'planner', message: 'Decomposing task' });
      dash.onEvent({ type: 'task_start', agentId: 'coder-01', role: 'coder', message: 'Writing code' });
      dash.onEvent({ type: 'task_failed', agentId: 'tester-01', role: 'tester', message: 'Test failure' });

      const matrix = dash.renderStatusMatrix();
      const raw = stripAnsi(matrix);

      expect(raw).toContain('planner-01');
      expect(raw).toContain('coder-01');
      expect(raw).toContain('tester-01');
      expect(raw).toContain('Decomposing task');
      expect(raw).toContain('Writing code');
      expect(raw).toContain('Test failure');
    });

    it('renderExecutionSummary() formats comprehensive summary table', () => {
      const dash = new TeamworkDashboard({ isTTY: false, silent: true });
      dash.onEvent({ type: 'session_start', message: 'Init' });
      dash.onEvent({ type: 'task_start', agentId: 'coder-01', role: 'coder', message: 'T1' });
      dash.onEvent({ type: 'task_complete', agentId: 'coder-01', role: 'coder' });

      const summaryTable = dash.renderExecutionSummary({
        id: 'session-xyz',
        status: 'completed',
        tasksCompleted: 1,
        verified: true,
      });

      const raw = stripAnsi(summaryTable);
      expect(raw).toContain('Session ID');
      expect(raw).toContain('session-xyz');
      expect(raw).toContain('Session Status');
      expect(raw).toContain('COMPLETED');
      expect(raw).toContain('Tasks Completed');
      expect(raw).toContain('Verified');
    });
  });

  /* -------------------------------------------------------------------------- */
  /* TeamworkEngine Structured Events & Bug Fix Verification                     */
  /* -------------------------------------------------------------------------- */
  describe('TeamworkEngine Events & Agent State Consistency', () => {
    it('emits lifecycle events and marks agent status as failed on error', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-teamwork-test-'));
      let dbInstance: Store | null = null;

      try {
        const baseConfig = loadConfig(tmpDir);
        const config: Config = {
          ...baseConfig, teamManager:false,
          workspace: tmpDir,
          maxAgents: 2,
          useWorktrees: false,
        };

        const db = new Store(path.join(tmpDir, '.vibe'));
        dbInstance = db;
        const router = new ModelRouter(config);

        // Mock client that returns a valid 2-task plan from planner,
        // but fails during coder execution
        let callCount = 0;
        const mockClient = {
          chat: async () => {
            callCount++;
            if (callCount === 1) {
              // Planner call
              return {
                content: JSON.stringify({
                  summary: 'Plan with 2 tasks',
                  tasks: [
                    { id: 'T1', title: 'Code task', description: 'Write module', role: 'coder', dependencies: [] },
                    { id: 'T2', title: 'Test task', description: 'Verify module', role: 'tester', dependencies: ['T1'] },
                  ],
                }),
                toolCalls: [],
              };
            }
            // Agent execution throws error
            throw new Error('LLM provider timeout error');
          },
        } as any;

        const teamwork = new Teamwork(config, db, mockClient, router, async () => true);
        const emittedEvents: TeamworkEvent[] = [];

        const result = await teamwork.run('Goal with expected failure', (event) => {
          if (typeof event !== 'string') {
            emittedEvents.push(event);
          }
        });

        // 1. Verify structured events were emitted
        const types = emittedEvents.map((e) => e.type);
        expect(types).toContain('session_start');
        expect(types).toContain('planner_start');
        expect(types).toContain('planner_done');
        expect(types).toContain('task_start');
        expect(types).toContain('task_failed');

        // 2. Verify bug fix: failed agent is updated in this.agents map
        const coderAgent = teamwork.agents.get('agent-coder-01');
        expect(coderAgent).toBeDefined();
        expect(coderAgent?.status).toBe('failed');
        expect(coderAgent?.status).not.toBe('running');

        // 3. Verify task failed event has error details
        const failedEvent = emittedEvents.find((e) => e.type === 'task_failed');
        expect(failedEvent?.agentId).toBe('agent-coder-01');
        expect(failedEvent?.role).toBe('coder');
        expect(failedEvent?.status).toBe('failed');
        expect(failedEvent?.message).toContain('LLM provider timeout error');

        // 4. Verify result object
        expect(result.status).toBe('failed');
        expect(result.verified).toBe(false);
        expect(result.failures.length).toBeGreaterThan(0);
      } finally {
        if (dbInstance) dbInstance.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('correctly handles cancellation on abort()', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-teamwork-cancel-'));
      let dbInstance: Store | null = null;

      try {
        const baseConfig = loadConfig(tmpDir);
        const config: Config = {
          ...baseConfig, teamManager:false,
          workspace: tmpDir,
          maxAgents: 2,
          useWorktrees: false,
        };

        const db = new Store(path.join(tmpDir, '.vibe'));
        dbInstance = db;
        const router = new ModelRouter(config);

        let callCount = 0;
        let twInstance: Teamwork;

        const mockClient = {
          chat: async (_msgs: any, _tools: any, _model: any, signal?: AbortSignal) => {
            callCount++;
            if (callCount === 1) {
              return {
                content: JSON.stringify({
                  summary: 'Plan',
                  tasks: [
                    { id: 'T1', title: 'Task to cancel', description: 'Run task', role: 'coder', dependencies: [] },
                  ],
                }),
                toolCalls: [],
              };
            }
            // During coder task, trigger stop
            twInstance.stop();
            // Check signal
            if (signal?.aborted) {
              const err = new Error('Aborted');
              err.name = 'AbortError';
              throw err;
            }
            throw new Error('Aborted');
          },
        } as any;

        twInstance = new Teamwork(config, db, mockClient, router, async () => true);
        const emittedEvents: TeamworkEvent[] = [];

        const result = await twInstance.run('Goal cancelled', (event) => {
          if (typeof event !== 'string') {
            emittedEvents.push(event);
          }
        });

        // Verify task and agent status is cancelled
        const coderAgent = twInstance.agents.get('agent-coder-01');
        expect(coderAgent?.status).toBe('cancelled');
        expect(result.tasks[0].status).toBe('cancelled');

        const failedEvent = emittedEvents.find((e) => e.type === 'task_failed');
        expect(failedEvent?.status).toBe('cancelled');
      } finally {
        if (dbInstance) dbInstance.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
