/**
 * Loop-analysis terminal dispatch coverage (order.md §2).
 *
 * A workflow run reaches its terminal publication through three distinct paths:
 * the normal executeWorkflow finalization, the bootstrap-failure terminalization,
 * and the force-fail storage. Each path must fire the loop-analysis terminal hook
 * exactly once so an enabled analysis launches for finished runs regardless of how
 * the run ended. The hook itself is replaced with a vi.mock double; its internal
 * eligibility rules are covered by loopAnalysisHook.test.ts.
 *
 * Uses the real executeWorkflow path with the mock provider and a real filesystem,
 * so this file stays in the integration gate.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { WorkflowConfig, WorkflowStep } from '../core/models/index.js';
import { semanticRuleCandidatesOf } from '../core/models/workflow-rule-condition.js';
import { RuleDetectionExhaustedError } from '../core/workflow/evaluation/RuleDetectionExhaustedError.js';
import { detectCandidateIndex } from '../shared/utils/ruleIndex.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';
import { setMockScenario, resetScenario } from '../infra/mock/index.js';

const hookMock = vi.hoisted(() => ({
  launch: vi.fn(),
}));

vi.mock('../features/tasks/execute/loopAnalysisHook.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/tasks/execute/loopAnalysisHook.js')>()),
  launchLoopAnalysisOnRunTerminal: hookMock.launch,
}));

vi.mock('../core/workflow/phase-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/workflow/phase-runner.js')>()),
  runStatusJudgmentPhase: vi.fn().mockImplementation((
    step: WorkflowStep,
    ctx: { lastResponse?: string },
  ) => {
    const candidateIndex = detectCandidateIndex(ctx.lastResponse ?? '', step.name);
    const candidate = semanticRuleCandidatesOf(step.rules ?? [], false)[candidateIndex];
    if (!candidate) {
      throw new RuleDetectionExhaustedError(step.name);
    }
    return { label: candidate.label, method: 'phase3_tag' as const };
  }),
}));

import { executeWorkflow } from '../features/tasks/execute/workflowExecution.js';
import { createTaskRunForceFailStorage } from '../features/tasks/list/taskRunForceFailStorage.js';
import {
  claimLoopAnalysisDispatch,
  onRunTerminal,
} from '../features/tasks/execute/loopAnalysisHook.js';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import { initNdjsonLog } from '../infra/fs/index.js';
import type { TaskListItem } from '../infra/task/types.js';

function makeConfig(): WorkflowConfig {
  return {
    name: 'loop-analysis-dispatch',
    maxSteps: 3,
    initialStep: 'implement',
    steps: [
      {
        name: 'implement',
        personaDisplayName: 'implement',
        instruction: 'Implement {task}',
        rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
      },
    ],
  };
}

function createRunningTask(
  projectDir: string,
  runSlug: string,
  overrides: { branch?: string; autoPr?: boolean } = {},
): TaskListItem {
  return {
    kind: 'running',
    name: 'running-task',
    createdAt: '2026-04-09T00:00:00.000Z',
    filePath: join(projectDir, '.takt', 'tasks.yaml'),
    content: 'Force fail me',
    taskDir: `.takt/tasks/${runSlug}`,
    runSlug,
    ownerPid: 4242,
    ...(overrides.branch === undefined ? {} : { branch: overrides.branch }),
    data: {
      task: 'Force fail me\nwith full prompt',
      ...(overrides.autoPr === undefined ? {} : { auto_pr: overrides.autoPr }),
    },
  };
}

function writeRunningRunMeta(projectDir: string, runSlug: string): void {
  const runPaths = buildRunPaths(projectDir, runSlug);
  const relativeRunRoot = join('.takt', 'runs', runSlug);
  mkdirSync(dirname(runPaths.metaAbs), { recursive: true });
  writeFileSync(runPaths.metaAbs, JSON.stringify({
    task: 'Force fail me',
    workflow: 'default',
    runSlug,
    runRoot: relativeRunRoot,
    reportDirectory: join(relativeRunRoot, 'reports'),
    contextDirectory: join(relativeRunRoot, 'context'),
    logsDirectory: join(relativeRunRoot, 'logs'),
    status: 'running',
    startTime: '2026-04-09T00:00:00.000Z',
    currentStep: 'implement',
    currentIteration: 2,
  }, null, 2), 'utf-8');
  initNdjsonLog('force-fail-session', 'Force fail me', 'default', {
    logsDir: runPaths.logsAbs,
    startTime: '2026-04-09T00:00:00.000Z',
  });
}

describe('loop-analysis terminal dispatch', () => {
  let projectDir: string;
  let globalConfigDir: string;
  let originalTaktConfigDir: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    projectDir = mkdtempSync(join(tmpdir(), 'takt-loop-analysis-dispatch-'));
    globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-loop-analysis-dispatch-global-'));
    originalTaktConfigDir = process.env.TAKT_CONFIG_DIR;
    process.env.TAKT_CONFIG_DIR = globalConfigDir;
  });

  afterEach(() => {
    resetScenario();
    if (originalTaktConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = originalTaktConfigDir;
    }
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(globalConfigDir, { recursive: true, force: true });
  });

  it('Given a workflow run that completes through the normal terminal path, When the run finishes, Then the terminal hook fires once with the completed status', async () => {
    setMockScenario([
      { status: 'done', content: '[IMPLEMENT:1]\n\ndone' },
    ]);

    const result = await executeWorkflow(makeConfig(), 'task', projectDir, {
      projectCwd: projectDir,
      provider: 'mock',
    });

    expect(result.success).toBe(true);
    expect(hookMock.launch).toHaveBeenCalledTimes(1);
    expect(hookMock.launch).toHaveBeenCalledWith(expect.objectContaining({
      projectCwd: projectDir,
      status: 'completed',
      sourceAutoPr: false,
    }));
  });

  it('Given a source run with autoPr, When the run finishes, Then the terminal hook receives the resolved autoPr flag', async () => {
    setMockScenario([
      { status: 'done', content: '[IMPLEMENT:1]\n\ndone' },
    ]);

    const result = await executeWorkflow(makeConfig(), 'task', projectDir, {
      projectCwd: projectDir,
      provider: 'mock',
      autoPr: true,
      traceTaskMetadata: { gitBranch: 'takt/dispatch-auto-pr' },
    });

    expect(result.success).toBe(true);
    expect(hookMock.launch).toHaveBeenCalledTimes(1);
    expect(hookMock.launch).toHaveBeenCalledWith(expect.objectContaining({
      projectCwd: projectDir,
      status: 'completed',
      gitBranch: 'takt/dispatch-auto-pr',
      sourceAutoPr: true,
    }));
  });

  it('Given a workflow run interrupted by a pre-aborted external signal, When the run reaches its terminal publication as cancelled, Then the terminal hook fires once with the cancelled status', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await executeWorkflow(makeConfig(), 'task', projectDir, {
      projectCwd: projectDir,
      provider: 'mock',
      abortSignal: controller.signal,
    });

    expect(result.success).toBe(false);
    expect(hookMock.launch).toHaveBeenCalledTimes(1);
    expect(hookMock.launch).toHaveBeenCalledWith(expect.objectContaining({
      projectCwd: projectDir,
      status: 'cancelled',
      sourceAutoPr: false,
    }));
  });

  it('Given a workflow run that fails during bootstrap, When the run is terminalized, Then the terminal hook fires once with the failed status', async () => {
    const runSlug = 'loop-analysis-bootstrap-failure';

    await expect(executeWorkflow(makeConfig(), 'failed target task', projectDir, {
      projectCwd: projectDir,
      provider: 'mock',
      reportDirName: runSlug,
      taskSpec: {
        runSlug,
        sourceTaskDir: join(projectDir, 'missing-task-source'),
        attachmentManifest: [{
          relativePath: 'attachments/missing.png',
          kind: 'file',
          contentSha256: 'a'.repeat(64),
        }],
        taskPrompt: 'missing task prompt',
        orderContent: 'missing task',
        stagedOrderContent: 'missing task',
      },
    })).rejects.toThrow();

    expect(hookMock.launch).toHaveBeenCalledTimes(1);
    expect(hookMock.launch).toHaveBeenCalledWith(expect.objectContaining({
      projectCwd: projectDir,
      runRootAbs: join(projectDir, '.takt', 'runs', runSlug),
      status: 'failed',
      sourceAutoPr: false,
    }));
  });

  it('Given a running task that is force-failed, When the run is terminalized, Then the terminal hook fires once with the failed status', async () => {
    const runSlug = 'loop-analysis-force-fail';
    writeRunningRunMeta(projectDir, runSlug);
    const runPaths = buildRunPaths(projectDir, runSlug);
    const storage = createTaskRunForceFailStorage({
      task: createRunningTask(projectDir, runSlug),
      projectDir,
      onWarning: vi.fn(),
    });

    expect(storage).toBeDefined();
    await expect(storage!.terminalize('manual force-fail')).resolves.toMatchObject({ issues: [] });

    expect(hookMock.launch).toHaveBeenCalledTimes(1);
    expect(hookMock.launch).toHaveBeenCalledWith(expect.objectContaining({
      projectCwd: projectDir,
      runRootAbs: runPaths.runRootAbs,
      reportsAbs: runPaths.reportsAbs,
      status: 'failed',
      sourceAutoPr: false,
    }));
  });

  it('Given a running task with a branch and auto_pr, When the run is force-failed, Then the terminal hook receives the branch and the resolved autoPr flag', async () => {
    const runSlug = 'loop-analysis-force-fail-auto-pr';
    writeRunningRunMeta(projectDir, runSlug);
    const storage = createTaskRunForceFailStorage({
      task: createRunningTask(projectDir, runSlug, { branch: 'takt/x', autoPr: true }),
      projectDir,
      onWarning: vi.fn(),
    });

    expect(storage).toBeDefined();
    await expect(storage!.terminalize('manual force-fail')).resolves.toMatchObject({ issues: [] });

    expect(hookMock.launch).toHaveBeenCalledTimes(1);
    expect(hookMock.launch).toHaveBeenCalledWith(expect.objectContaining({
      projectCwd: projectDir,
      status: 'failed',
      gitBranch: 'takt/x',
      sourceAutoPr: true,
    }));
  });

  it('Given a running task without auto_pr but with project config auto_pr, When the run is force-failed, Then the terminal hook receives the config-resolved autoPr flag', async () => {
    const runSlug = 'loop-analysis-force-fail-config-auto-pr';
    writeRunningRunMeta(projectDir, runSlug);
    mkdirSync(join(projectDir, '.takt'), { recursive: true });
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), 'auto_pr: true\n', 'utf-8');
    const storage = createTaskRunForceFailStorage({
      task: createRunningTask(projectDir, runSlug),
      projectDir,
      onWarning: vi.fn(),
    });

    expect(storage).toBeDefined();
    await expect(storage!.terminalize('manual force-fail')).resolves.toMatchObject({ issues: [] });

    expect(hookMock.launch).toHaveBeenCalledTimes(1);
    expect(hookMock.launch).toHaveBeenCalledWith(expect.objectContaining({
      projectCwd: projectDir,
      status: 'failed',
      sourceAutoPr: true,
    }));
  });

  it('Given the real dispatch claim on a shared run directory, When the terminal hook fires twice for the same run, Then only the first call spawns the analysis run', async () => {
    const runSlug = 'loop-analysis-claim-idempotent';
    writeRunningRunMeta(projectDir, runSlug);
    const runPaths = buildRunPaths(projectDir, runSlug);
    const spawn = vi.fn(() => ({ on: vi.fn(), unref: vi.fn() }));
    const deps = {
      resolveConfig: () => ({ enabled: true, output: 'file' as const }),
      spawn,
      env: {} as Record<string, string | undefined>,
      gitProvider: {
        findExistingPr: vi.fn(() => undefined),
        commentOnPr: vi.fn(() => ({ success: true })),
      },
      readFile: vi.fn(() => 'report'),
      sleep: vi.fn(async () => {}),
      logger: { error: vi.fn() },
      claimDispatch: claimLoopAnalysisDispatch,
    };
    const input = {
      projectCwd: projectDir,
      runRootAbs: runPaths.runRootAbs,
      reportsAbs: runPaths.reportsAbs,
      status: 'failed' as const,
    };

    await expect(onRunTerminal(deps, input)).resolves.toBeUndefined();
    await expect(onRunTerminal(deps, input)).resolves.toBeUndefined();

    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
