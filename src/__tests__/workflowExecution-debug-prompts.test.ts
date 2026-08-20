/**
 * Integration tests: debug prompt log wiring in executeWorkflow().
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest';
import type { WorkflowConfig } from '../core/models/index.js';
import { buildPhaseExecutionId } from '../shared/utils/phaseExecutionId.js';

const {
  disabledObservability,
  mockIsDebugEnabled,
  mockInitNdjsonLog,
  mockAppendNdjsonLine,
  traceWriterCalls,
  traceFullState,
  MockWorkflowEngine,
} = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: EE } = require('node:events') as typeof import('node:events');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path');

  const mockIsDebugEnabled = vi.fn().mockReturnValue(true);
  const traceWriterCalls: Array<{ tracePath: string; promptLogPath?: string }> = [];
  const traceFullState = { enabled: false };
  const mockInitNdjsonLog = vi.fn((
    sessionId: string,
    task: string,
    workflowName: string,
    options: { logsDir: string; startTime: string },
  ) => {
    fs.mkdirSync(options.logsDir, { recursive: true });
    const filePath = path.join(options.logsDir, `${sessionId}.jsonl`);
    fs.writeFileSync(filePath, `${JSON.stringify({
      type: 'workflow_start',
      task,
      workflowName,
      startTime: options.startTime,
    })}\n`);
    return filePath;
  });
  const mockAppendNdjsonLine = vi.fn((filePath: string, record: unknown) => {
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`);
  });

  class MockWorkflowEngine extends EE {
    private config: WorkflowConfig;
    private task: string;
    private cwd: string;

    constructor(config: WorkflowConfig, cwd: string, task: string, _options: unknown) {
      super();
      if (task === 'constructor-throw-task') {
        throw new Error('mock constructor failure');
      }
      this.config = config;
      this.task = task;
      this.cwd = cwd;
    }

    abort(): void {}

    async run(): Promise<{ status: string; iteration: number }> {
      const step = this.config.steps[0]!;
      const timestamp = new Date('2026-02-07T00:00:00.000Z');
      const shouldAbort = this.task === 'abort-task';
      const shouldAbortBeforeComplete = this.task === 'abort-before-complete-task';
      const shouldDuplicatePhase = this.task === 'duplicate-phase-task';
      const shouldEmitSensitive = this.task === 'sensitive-content-task';
      const shouldRepeatStep = this.task === 'repeat-step-task';
      const shouldReversePhaseCompletion = this.task === 'reverse-phase-complete-task';
      const providerInfo = { provider: undefined, model: undefined };
      const executePhaseId = buildPhaseExecutionId({
        step: step.name,
        iteration: 1,
        phase: 1,
        sequence: 1,
      });
      const executePhaseSecondId = buildPhaseExecutionId({
        step: step.name,
        iteration: 1,
        phase: 1,
        sequence: 2,
      });
      const judgePhaseId = buildPhaseExecutionId({
        step: step.name,
        iteration: 1,
        phase: 3,
        sequence: 1,
      });
      this.emit('step:start', step, 1, 'step instruction', providerInfo, this.config.name, step.name, 1);
      if (shouldReversePhaseCompletion) {
        this.emit('phase:start', step, 1, 'execute', 'phase prompt first', {
          systemPrompt: '../agents/coder.md',
          userInstruction: 'phase prompt first',
        }, executePhaseId, 1);
        this.emit('phase:start', step, 1, 'execute', 'phase prompt second', {
          systemPrompt: '../agents/coder.md',
          userInstruction: 'phase prompt second',
        }, executePhaseSecondId, 1);
      } else {
        this.emit('phase:start', step, 1, 'execute', shouldEmitSensitive ? 'token=plain-secret' : `phase prompt for ${this.task}`, {
          systemPrompt: shouldEmitSensitive ? 'Authorization: Bearer super-secret-token' : `system prompt for ${this.task}`,
          userInstruction: shouldEmitSensitive ? 'api_key=plain-secret' : `user instruction for ${this.task}`,
        }, executePhaseId, 1);
      }
      this.emit('phase:start', step, 3, 'judge', 'phase3 prompt', {
        systemPrompt: 'conductor',
        userInstruction: 'phase3 prompt',
      }, judgePhaseId, 1);
      this.emit('phase:judge_stage', step, 3, 'judge', {
        stage: 1,
        method: 'structured_output',
        status: 'done',
        instruction: 'judge stage prompt',
        response: 'judge stage response',
      }, judgePhaseId, 1);
      this.emit('phase:complete', step, 3, 'judge', '[IMPLEMENT:1]', 'done', undefined, judgePhaseId, 1);
      if (shouldAbortBeforeComplete) {
        this.emit(
          'workflow:abort',
          { status: 'aborted', iteration: 1 },
          'user_interrupted',
          'interrupt',
          {
            kind: 'interrupt',
            step: step.name,
            reason: 'user_interrupted',
            error: 'user_interrupted',
          },
        );
        return { status: 'aborted', iteration: 1 };
      }
      if (shouldReversePhaseCompletion) {
        this.emit('phase:complete', step, 1, 'execute', 'phase response second', 'done', undefined, executePhaseSecondId, 1);
        this.emit('phase:complete', step, 1, 'execute', 'phase response first', 'done', undefined, executePhaseId, 1);
      } else {
        this.emit('phase:complete', step, 1, 'execute', shouldEmitSensitive ? 'password=plain-secret' : `phase response for ${this.task} in ${this.cwd}`, 'done', undefined, executePhaseId, 1);
      }
      if (shouldDuplicatePhase) {
        this.emit('phase:start', step, 1, 'execute', 'phase prompt second', {
          systemPrompt: '../agents/coder.md',
          userInstruction: 'phase prompt second',
        }, executePhaseSecondId, 1);
        this.emit('phase:complete', step, 1, 'execute', 'phase response second', 'done', undefined, executePhaseSecondId, 1);
      }
      this.emit(
        'step:complete',
        step,
        {
          persona: step.personaDisplayName,
          status: 'done',
          content: `step response for ${this.task}`,
          timestamp,
        },
        'step instruction',
        step.name,
      );
      if (shouldRepeatStep) {
        this.emit(
          'step:start',
          step,
          2,
          'step instruction repeat',
          providerInfo,
          this.config.name,
          step.name,
          2,
        );
        this.emit(
          'step:complete',
          step,
          {
            persona: step.personaDisplayName,
            status: 'done',
            content: 'step response repeat',
            timestamp,
          },
          'step instruction repeat',
          step.name,
        );
      }
      if (shouldAbort) {
        this.emit(
          'workflow:abort',
          { status: 'aborted', iteration: 1 },
          'user_interrupted',
          'interrupt',
          {
            kind: 'interrupt',
            step: step.name,
            reason: 'user_interrupted',
            error: 'user_interrupted',
          },
        );
        return { status: 'aborted', iteration: shouldRepeatStep ? 2 : 1 };
      }
      this.emit('workflow:complete', { status: 'completed', iteration: 1 });
      return { status: 'completed', iteration: shouldRepeatStep ? 2 : 1 };
    }
  }

  return {
    disabledObservability: {
      enabled: false,
      monitor: false,
      sessionLogExporter: false,
      usageEventsPhase: false,
    },
    mockIsDebugEnabled,
    mockInitNdjsonLog,
    mockAppendNdjsonLine,
    traceWriterCalls,
    traceFullState,
    MockWorkflowEngine,
  };
});

vi.mock('../core/workflow/index.js', async () => {
  const errorModule = await import('../core/workflow/ask-user-question-error.js');
  return {
  WorkflowEngine: MockWorkflowEngine,
    createDenyAskUserQuestionHandler: errorModule.createDenyAskUserQuestionHandler,
  };
});

vi.mock('../features/tasks/execute/workflowRunLifecycle.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../features/tasks/execute/workflowRunLifecycle.js')
  >();
  const { createWorkflowRunLifecycleCompositionTestDouble } = await import(
    './helpers/run-lifecycle.js'
  );
  return {
    ...actual,
    createWorkflowRunLifecycle: (
      input: Parameters<typeof actual.createWorkflowRunLifecycle>[0],
    ) => createWorkflowRunLifecycleCompositionTestDouble(
      actual.createWorkflowRunLifecycle,
      input,
      {
        sessionId: 'test-session-id',
        startedAt: '2026-02-07T00:00:00.000Z',
        projectTerminalArtifacts: true,
      },
    ),
  };
});

vi.mock('../infra/claude/query-manager.js', () => ({
  interruptAllQueries: vi.fn(),
}));

vi.mock('../infra/config/index.js', () => ({
  loadPersonaSessions: vi.fn().mockReturnValue({}),
  updatePersonaSession: vi.fn(),
  loadWorktreeSessions: vi.fn().mockReturnValue({}),
  updateWorktreeSession: vi.fn(),
  loadProjectConfig: vi.fn(() => ({})),
  loadGlobalConfig: vi.fn(() => ({})),
  resolveWorkflowConfigValues: vi.fn().mockImplementation(() => ({
    notificationSound: true,
    notificationSoundEvents: {},
    provider: 'claude',
    runtime: undefined,
    preventSleep: false,
    model: undefined,
    logging: traceFullState.enabled ? { trace: true } : undefined,
    observability: disabledObservability,
  })),
  saveSessionState: vi.fn(),
  ensureDir: vi.fn(),
  writeFileAtomic: vi.fn(),
}));

vi.mock('../infra/config/resolveConfigValue.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveConfigValueWithSource: vi.fn((_cwd, key) => key === 'provider'
    ? { value: 'claude', source: 'global' }
    : { value: undefined, source: 'default' }),
}));

vi.mock('../features/tasks/execute/traceReportWriter.js', async () => {
  const { renderTraceReportFromLogs } = await import(
    '../features/tasks/execute/traceReport.js'
  );
  const { writeFileAtomic } = await import('../infra/config/index.js');
  return {
    writeTerminalTraceReport: (input: {
      tracePath: string;
      workflowName: string;
      task: string;
      runSlug: string;
      ndjsonLogPath: string;
      promptLogPath?: string;
      mode: 'off' | 'redacted' | 'full';
      terminal: {
        status: 'completed' | 'aborted' | 'failed';
        iterations: number;
        endTime: string;
        reason?: string;
      };
    }) => {
      traceWriterCalls.push({
        tracePath: input.tracePath,
        ...(input.promptLogPath === undefined ? {} : { promptLogPath: input.promptLogPath }),
      });
      const markdown = renderTraceReportFromLogs(
        {
          tracePath: input.tracePath,
          workflowName: input.workflowName,
          task: input.task,
          runSlug: input.runSlug,
          ...input.terminal,
        },
        input.ndjsonLogPath,
        input.promptLogPath,
        input.mode,
      );
      if (markdown !== undefined) {
        writeFileAtomic(input.tracePath, markdown);
      }
    },
  };
});

vi.mock('../shared/context.js', () => ({
  isQuietMode: vi.fn().mockReturnValue(true),
}));

vi.mock('../shared/ui/index.js', () => ({
  header: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  status: vi.fn(),
  blankLine: vi.fn(),
  StreamDisplay: vi.fn().mockImplementation(() => ({
    createHandler: vi.fn().mockReturnValue(vi.fn()),
    flush: vi.fn(),
  })),
}));

vi.mock('../infra/fs/index.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../infra/fs/index.js')
  >()),
  generateSessionId: vi.fn().mockReturnValue('test-session-id'),
  createSessionLog: vi.fn().mockImplementation((
    task,
    projectDir,
    workflowName,
    options,
  ) => ({
    task,
    projectDir,
    workflowName,
    startTime: options.startTime,
    iterations: 0,
    status: 'running',
    history: [],
  })),
  finalizeSessionLog: vi.fn().mockImplementation((log, status) => ({
    ...log,
    status,
    endTime: new Date().toISOString(),
  })),
  initNdjsonLog: mockInitNdjsonLog,
  appendNdjsonLine: mockAppendNdjsonLine,
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  preventSleep: vi.fn(),
  isDebugEnabled: mockIsDebugEnabled,
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
  isValidReportDirName: vi.fn().mockImplementation((value: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)),
}));

vi.mock('../shared/prompt/index.js', () => ({
  selectOption: vi.fn(),
  promptInput: vi.fn(),
}));

vi.mock('../shared/i18n/index.js', () => ({
  getLabel: vi.fn().mockImplementation((key: string) => key),
}));

vi.mock('../shared/exitCodes.js', () => ({
  EXIT_SIGINT: 130,
}));

import { executeWorkflow } from '../features/tasks/execute/workflowExecution.js';
import { ensureDir, writeFileAtomic } from '../infra/config/index.js';
import { appendNdjsonLine } from '../infra/fs/index.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';

describe('executeWorkflow debug prompts logging', () => {
  const TEST_SESSION_ID = 'test-session-id';
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(realpathSync(tmpdir()), 'takt-debug-prompts-'));
    vi.clearAllMocks();
    traceWriterCalls.length = 0;
    traceFullState.enabled = false;
    mockIsDebugEnabled.mockReturnValue(true);
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  function makeConfig(): WorkflowConfig {
    return {
      name: 'test-workflow',
      maxSteps: 5,
      initialStep: 'implement',
      steps: [
        {
          name: 'implement',
          persona: '../agents/coder.md',
          personaDisplayName: 'coder',
          instruction: 'Implement task',
          passPreviousResponse: true,
          rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
        },
      ],
    };
  }

  function runLogsDir(cwd: string, runSlug: string): string {
    return join(cwd, '.takt', 'runs', runSlug, 'logs');
  }

  function runPromptsLogPath(cwd: string, runSlug: string): string {
    return join(runLogsDir(cwd, runSlug), `${TEST_SESSION_ID}-prompts.jsonl`);
  }

  function readRunPromptRecords(cwd: string, runSlug: string): Array<Record<string, unknown>> {
    return readFileSync(runPromptsLogPath(cwd, runSlug), 'utf-8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  function readWrittenTrace(runSlug: string): string | undefined {
    const call = vi.mocked(writeFileAtomic).mock.calls.find(
      (entry) => String(entry[0]).endsWith(`${runSlug}/trace.md`),
    );
    return call === undefined ? undefined : String(call[1]);
  }

  function expectIsolatedRunArtifacts(alphaCwd: string, betaCwd: string): void {
    const alphaRecords = readRunPromptRecords(alphaCwd, 'run-alpha');
    const betaRecords = readRunPromptRecords(betaCwd, 'run-beta');
    expect(alphaRecords.length).toBeGreaterThan(0);
    expect(betaRecords.length).toBeGreaterThan(0);
    const alphaPhaseOne = alphaRecords.find((record) => record.phase === 1)!;
    const betaPhaseOne = betaRecords.find((record) => record.phase === 1)!;
    expect(alphaPhaseOne.scope).toBe(betaPhaseOne.scope);
    expect(alphaPhaseOne.phaseExecutionId).toBe(betaPhaseOne.phaseExecutionId);
    expect(JSON.stringify(alphaRecords)).toContain('alpha-task-body');
    expect(JSON.stringify(alphaRecords)).not.toContain('beta-task-body');
    expect(JSON.stringify(betaRecords)).toContain('beta-task-body');
    expect(JSON.stringify(betaRecords)).not.toContain('alpha-task-body');

    const alphaTrace = readWrittenTrace('run-alpha');
    const betaTrace = readWrittenTrace('run-beta');
    expect(alphaTrace).toBeDefined();
    expect(betaTrace).toBeDefined();
    expect(alphaTrace!).toContain('alpha-task-body');
    expect(alphaTrace!).not.toContain('beta-task-body');
    expect(alphaTrace!).not.toContain(betaCwd);
    expect(betaTrace!).toContain('beta-task-body');
    expect(betaTrace!).not.toContain('alpha-task-body');
    expect(betaTrace!).not.toContain(alphaCwd);

    const alphaTraceCall = traceWriterCalls.find((call) => call.tracePath.includes('run-alpha'));
    const betaTraceCall = traceWriterCalls.find((call) => call.tracePath.includes('run-beta'));
    expect(alphaTraceCall?.promptLogPath).toBe(runPromptsLogPath(alphaCwd, 'run-alpha'));
    expect(betaTraceCall?.promptLogPath).toBe(runPromptsLogPath(betaCwd, 'run-beta'));

    for (const [cwd, runSlug, task] of [
      [alphaCwd, 'run-alpha', 'alpha-task-body'],
      [betaCwd, 'run-beta', 'beta-task-body'],
    ] as const) {
      const sessionLines = readFileSync(join(runLogsDir(cwd, runSlug), `${TEST_SESSION_ID}.jsonl`), 'utf-8')
        .split('\n')
        .filter((line) => line.length > 0);
      const firstRecord = JSON.parse(sessionLines[0]!) as { type: string; task: string };
      expect(firstRecord.type).toBe('workflow_start');
      expect(firstRecord.task).toBe(task);
    }
  }

  it('should write prompt log records to the run-scoped prompts log when debug is enabled', async () => {
    await executeWorkflow(makeConfig(), 'task', projectDir, {
      projectCwd: projectDir,
      reportDirName: 'debug-run',
    });

    const records = readRunPromptRecords(projectDir, 'debug-run');
    expect(records).toHaveLength(2);
    const record = records.find((entry) => entry.phase === 1)!;
    expect(record.step).toBe('implement');
    expect(record.phase).toBe(1);
    expect(record.iteration).toBe(1);
    expect(record.prompt).toBeTypeOf('string');
    expect(record.response).toBeTypeOf('string');
    expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('should separate system prompt and user instruction in run-scoped prompt records', async () => {
    await executeWorkflow(makeConfig(), 'task', projectDir, {
      projectCwd: projectDir,
      reportDirName: 'debug-run',
    });

    const records = readRunPromptRecords(projectDir, 'debug-run');
    const record = records.find((entry) => entry.phase === 1)!;
    expect(record.systemPrompt).toBeTypeOf('string');
    expect(record.userInstruction).toBeTypeOf('string');
  });

  it('should not create a prompts log file when debug is disabled', async () => {
    mockIsDebugEnabled.mockReturnValue(false);

    await executeWorkflow(makeConfig(), 'task', projectDir, {
      projectCwd: projectDir,
      reportDirName: 'debug-disabled-run',
    });

    const logEntries = readdirSync(runLogsDir(projectDir, 'debug-disabled-run'));
    expect(logEntries.filter((entry) => entry.endsWith('-prompts.jsonl'))).toEqual([]);
    const traceCall = traceWriterCalls.find((call) => call.tracePath.includes('debug-disabled-run'));
    expect(traceCall?.promptLogPath).toBeUndefined();
  });

  it('should keep repeated phase starts in the same run as distinct prompt records', async () => {
    await executeWorkflow(makeConfig(), 'duplicate-phase-task', projectDir, {
      projectCwd: projectDir,
      reportDirName: 'debug-run',
    });

    const records = readRunPromptRecords(projectDir, 'debug-run');
    expect(records).toHaveLength(3);
    const phase1Responses = records
      .filter((record) => record.phase === 1)
      .map((record) => record.response);
    expect(phase1Responses).toHaveLength(2);
    expect(phase1Responses.every((response) => typeof response === 'string' && response.length > 0)).toBe(true);
  });

  it('should write the run-scoped prompts log as a private file with sanitized records', async () => {
    await executeWorkflow(makeConfig(), 'sensitive-content-task', projectDir, {
      projectCwd: projectDir,
      reportDirName: 'debug-sensitive-run',
    });

    const promptsPath = runPromptsLogPath(projectDir, 'debug-sensitive-run');
    expect(statSync(promptsPath).mode & 0o777).toBe(0o600);
    const content = readFileSync(promptsPath, 'utf-8');
    expect(content).toContain('[REDACTED]');
    expect(content).not.toContain('plain-secret');
    expect(content).not.toContain('super-secret-token');
  });

  it('should isolate prompt records and traces between sequential runs in the same process', async () => {
    const alphaCwd = join(projectDir, 'alpha-work');
    const betaCwd = join(projectDir, 'beta-work');
    mkdirSync(alphaCwd, { recursive: true });
    mkdirSync(betaCwd, { recursive: true });

    await executeWorkflow(makeConfig(), 'alpha-task-body', alphaCwd, {
      projectCwd: projectDir,
      reportDirName: 'run-alpha',
    });
    await executeWorkflow(makeConfig(), 'beta-task-body', betaCwd, {
      projectCwd: projectDir,
      reportDirName: 'run-beta',
    });

    expectIsolatedRunArtifacts(alphaCwd, betaCwd);
  });

  it('should isolate prompt records and traces between concurrent runs in the same process', async () => {
    const alphaCwd = join(projectDir, 'alpha-work');
    const betaCwd = join(projectDir, 'beta-work');
    mkdirSync(alphaCwd, { recursive: true });
    mkdirSync(betaCwd, { recursive: true });

    await Promise.all([
      executeWorkflow(makeConfig(), 'alpha-task-body', alphaCwd, {
        projectCwd: projectDir,
        reportDirName: 'run-alpha',
      }),
      executeWorkflow(makeConfig(), 'beta-task-body', betaCwd, {
        projectCwd: projectDir,
        reportDirName: 'run-beta',
      }),
    ]);

    expectIsolatedRunArtifacts(alphaCwd, betaCwd);
  });

  it('should not mix task body, cwd, or response across runs in full trace mode', async () => {
    traceFullState.enabled = true;
    const alphaCwd = join(projectDir, 'alpha-work');
    const betaCwd = join(projectDir, 'beta-work');
    mkdirSync(alphaCwd, { recursive: true });
    mkdirSync(betaCwd, { recursive: true });

    await executeWorkflow(makeConfig(), 'alpha-task-body', alphaCwd, {
      projectCwd: projectDir,
      reportDirName: 'run-alpha',
    });
    await executeWorkflow(makeConfig(), 'beta-task-body', betaCwd, {
      projectCwd: projectDir,
      reportDirName: 'run-beta',
    });

    expectIsolatedRunArtifacts(alphaCwd, betaCwd);

    const alphaTrace = readWrittenTrace('run-alpha');
    const betaTrace = readWrittenTrace('run-beta');
    expect(alphaTrace!).toContain(`phase response for alpha-task-body in ${alphaCwd}`);
    expect(alphaTrace!).not.toContain('phase response for beta-task-body');
    expect(betaTrace!).toContain(`phase response for beta-task-body in ${betaCwd}`);
    expect(betaTrace!).not.toContain('phase response for alpha-task-body');
  });

  it('should fail fast when taskPrefix is provided without taskColorIndex', async () => {
    await expect(
      executeWorkflow(makeConfig(), 'task', projectDir, {
        projectCwd: projectDir,
        taskPrefix: 'override-persona-provider',
      })
    ).rejects.toThrow('taskPrefix and taskColorIndex must be provided together');
  });

  it('should fail fast for invalid reportDirName before run directory writes', async () => {
    await expect(
      executeWorkflow(makeConfig(), 'task', projectDir, {
        projectCwd: projectDir,
        reportDirName: '..',
      })
    ).rejects.toThrow('Invalid reportDirName: ..');

    expect(vi.mocked(ensureDir)).not.toHaveBeenCalled();
    expect(vi.mocked(writeFileAtomic)).not.toHaveBeenCalled();
  });

  it('should update meta status from running to completed', async () => {
    await executeWorkflow(makeConfig(), 'task', projectDir, {
      projectCwd: projectDir,
      reportDirName: 'test-report-dir',
    });

    const metaCalls = vi.mocked(writeFileAtomic).mock.calls.filter(
      (call) => String(call[0]).endsWith('/meta.json')
    );
    expect(metaCalls.length).toBeGreaterThanOrEqual(3);

    const firstMeta = JSON.parse(String(metaCalls[0]![1])) as { status: string; endTime?: string };
    const stepMeta = metaCalls
      .map((call) => JSON.parse(String(call[1])) as {
        status: string;
        currentStep?: string;
        currentIteration?: number;
        phase?: number;
        endTime?: string;
      })
      .find((meta) => meta.currentStep === 'implement' && meta.currentIteration === 1 && meta.phase === undefined);
    const finalMeta = JSON.parse(String(metaCalls[metaCalls.length - 1]![1])) as {
      status: string;
      currentStep?: string;
      currentIteration?: number;
      endTime?: string;
    };
    expect(firstMeta.status).toBe('running');
    expect(firstMeta.endTime).toBeUndefined();
    expect(stepMeta).toMatchObject({
      status: 'running',
      currentStep: 'implement',
      currentIteration: 1,
    });
    expect(stepMeta?.endTime).toBeUndefined();
    expect(finalMeta.status).toBe('completed');
    expect(finalMeta.currentStep).toBe('implement');
    expect(finalMeta.currentIteration).toBe(1);
    expect(finalMeta.endTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('should update meta status from running to aborted', async () => {
    await executeWorkflow(makeConfig(), 'abort-task', projectDir, {
      projectCwd: projectDir,
      reportDirName: 'test-report-dir',
    });

    const metaCalls = vi.mocked(writeFileAtomic).mock.calls.filter(
      (call) => String(call[0]).endsWith('/meta.json')
    );
    expect(metaCalls.length).toBeGreaterThanOrEqual(3);

    const firstMeta = JSON.parse(String(metaCalls[0]![1])) as { status: string; endTime?: string };
    const stepMeta = metaCalls
      .map((call) => JSON.parse(String(call[1])) as {
        status: string;
        currentStep?: string;
        currentIteration?: number;
        phase?: number;
        endTime?: string;
      })
      .find((meta) => meta.currentStep === 'implement' && meta.currentIteration === 1 && meta.phase === undefined);
    const finalMeta = JSON.parse(String(metaCalls[metaCalls.length - 1]![1])) as {
      status: string;
      currentStep?: string;
      currentIteration?: number;
      endTime?: string;
    };
    expect(firstMeta.status).toBe('running');
    expect(firstMeta.endTime).toBeUndefined();
    expect(stepMeta).toMatchObject({
      status: 'running',
      currentStep: 'implement',
      currentIteration: 1,
    });
    expect(stepMeta?.endTime).toBeUndefined();
    expect(finalMeta.status).toBe('aborted');
    expect(finalMeta.currentStep).toBe('implement');
    expect(finalMeta.currentIteration).toBe(1);
    expect(finalMeta.endTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('should finalize meta as aborted when WorkflowEngine constructor throws', async () => {
    await expect(
      executeWorkflow(makeConfig(), 'constructor-throw-task', projectDir, {
        projectCwd: projectDir,
        reportDirName: 'test-report-dir',
      })
    ).rejects.toThrow('mock constructor failure');

    const metaCalls = vi.mocked(writeFileAtomic).mock.calls.filter(
      (call) => String(call[0]).endsWith('/meta.json')
    );
    expect(metaCalls).toHaveLength(2);

    const firstMeta = JSON.parse(String(metaCalls[0]![1])) as { status: string; endTime?: string };
    const secondMeta = JSON.parse(String(metaCalls[1]![1])) as { status: string; endTime?: string };
    expect(firstMeta.status).toBe('running');
    expect(firstMeta.endTime).toBeUndefined();
    expect(secondMeta.status).toBe('failed');
    expect(secondMeta.endTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('should write trace.md on workflow completion', async () => {
    await executeWorkflow(makeConfig(), 'task', projectDir, {
      projectCwd: projectDir,
      reportDirName: 'test-report-dir',
    });

    const traceCalls = vi.mocked(writeFileAtomic).mock.calls.filter(
      (call) => String(call[0]).endsWith('/trace.md')
    );
    expect(traceCalls.length).toBeGreaterThan(0);
  });

  it('should write trace.md on workflow abort', async () => {
    await executeWorkflow(makeConfig(), 'abort-task', projectDir, {
      projectCwd: projectDir,
      reportDirName: 'test-report-dir',
    });

    const traceCalls = vi.mocked(writeFileAtomic).mock.calls.filter(
      (call) => String(call[0]).endsWith('/trace.md')
    );
    expect(traceCalls.length).toBeGreaterThan(0);
  });

  it('should sanitize sensitive fields before writing session NDJSON when trace mode is default', async () => {
    await executeWorkflow(makeConfig(), 'token=plain-secret', projectDir, {
      projectCwd: projectDir,
      reportDirName: 'test-report-dir',
      interactiveMetadata: {
        confirmed: true,
        task: 'api_key=plain-secret',
      },
    });
    await executeWorkflow(makeConfig(), 'sensitive-content-task', projectDir, {
      projectCwd: projectDir,
      reportDirName: 'test-report-dir-2',
    });

    const records = vi.mocked(appendNdjsonLine).mock.calls.map((call) => call[1]);
    const recordText = JSON.stringify(records);
    expect(recordText).toContain('[REDACTED]');
    expect(recordText).not.toContain('plain-secret');
    expect(recordText).not.toContain('super-secret-token');
  });

  it('should keep phaseExecutionId bindings consistent in trace when completions arrive in reverse order', async () => {
    await executeWorkflow(makeConfig(), 'reverse-phase-complete-task', projectDir, {
      projectCwd: projectDir,
      reportDirName: 'test-report-dir',
    });

    const traceCall = vi.mocked(writeFileAtomic).mock.calls.find(
      (call) => String(call[0]).endsWith('/trace.md')
    );
    expect(traceCall).toBeDefined();
    const traceContent = String(traceCall?.[1]);
    const firstPromptIndex = traceContent.indexOf('phase prompt first');
    const firstResponseIndex = traceContent.indexOf('phase response first');
    const secondPromptIndex = traceContent.indexOf('phase prompt second');
    const secondResponseIndex = traceContent.indexOf('phase response second');

    expect(firstPromptIndex).toBeGreaterThan(-1);
    expect(firstResponseIndex).toBeGreaterThan(firstPromptIndex);
    expect(secondPromptIndex).toBeGreaterThan(firstResponseIndex);
    expect(secondResponseIndex).toBeGreaterThan(secondPromptIndex);
  });
});
