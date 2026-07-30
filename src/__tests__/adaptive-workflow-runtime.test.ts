import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentResponse, WorkflowStep } from '../core/models/index.js';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../core/workflow/phase-runner.js', () => ({
  runReportPhase: vi.fn(),
  runStatusJudgmentPhase: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateReportDir: vi.fn(),
}));

import { runAgent } from '../agents/runner.js';
import { WorkflowEngine } from '../core/workflow/index.js';
import { runReportPhase, runStatusJudgmentPhase } from '../core/workflow/phase-runner.js';
import {
  invalidateAllResolvedConfigCache,
  invalidateGlobalConfigCache,
} from '../infra/config/index.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';
import { getBuiltinWorkflowsDir } from '../infra/config/paths.js';
import { generateReportDir } from '../shared/utils/index.js';

type WorkType = 'frontend' | 'dual';

interface PlannedStep {
  readonly step: string;
  readonly semantic?: string;
  readonly workType?: WorkType;
}

interface CompletedStep {
  readonly step: string;
  readonly matchedRuleIndex: number | undefined;
}

const REPORT_DIR = 'adaptive-runtime';

function createRunDirectories(projectDir: string): void {
  const runDir = join(projectDir, '.takt', 'runs', REPORT_DIR);
  for (const relativePath of [
    'reports',
    'context/knowledge',
    'context/policy',
    'context/previous_responses',
    'logs',
  ]) {
    mkdirSync(join(runDir, relativePath), { recursive: true });
  }
}

function makeResponse(outcome: PlannedStep): AgentResponse {
  return {
    persona: outcome.step,
    status: 'done',
    content: `${outcome.step} completed`,
    timestamp: new Date(0),
    ...(outcome.workType === undefined
      ? {}
      : {
        structuredOutput: {
          work_type: outcome.workType,
          rationale: `classified as ${outcome.workType}`,
        },
      }),
  };
}

describe('adaptive builtin workflow runtime', () => {
  let projectDir: string;
  let configDir: string;
  let previousConfigDir: string | undefined;
  let engine: WorkflowEngine | undefined;

  beforeEach(() => {
    vi.resetAllMocks();
    projectDir = mkdtempSync(join(tmpdir(), 'takt-adaptive-runtime-project-'));
    configDir = mkdtempSync(join(tmpdir(), 'takt-adaptive-runtime-config-'));
    previousConfigDir = process.env.TAKT_CONFIG_DIR;
    process.env.TAKT_CONFIG_DIR = configDir;
    createRunDirectories(projectDir);
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    vi.mocked(generateReportDir).mockReturnValue(REPORT_DIR);
    vi.mocked(runReportPhase).mockImplementation(async (step, _iteration, context) => {
      for (const contract of step.outputContracts ?? []) {
        writeFileSync(
          join(context.reportDir, contract.name),
          `# ${contract.name}\n\n${step.name} completed`,
          'utf-8',
        );
      }
      return undefined;
    });
  });

  afterEach(() => {
    engine?.removeAllListeners();
    engine = undefined;
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
    if (previousConfigDir === undefined) delete process.env.TAKT_CONFIG_DIR;
    else process.env.TAKT_CONFIG_DIR = previousConfigDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  async function runScenario(plan: readonly PlannedStep[]): Promise<{
    state: Awaited<ReturnType<WorkflowEngine['run']>>;
    visited: string[];
    completed: CompletedStep[];
  }> {
    const workflowPath = join(getBuiltinWorkflowsDir('ja'), 'adaptive.yaml');
    const workflow = loadWorkflowFromFile(workflowPath, projectDir);
    const visited: string[] = [];
    const completed: CompletedStep[] = [];
    let activeOutcome: PlannedStep | undefined;

    engine = new WorkflowEngine(workflow, projectDir, 'implement adaptive scenario', {
      projectCwd: projectDir,
      provider: 'mock',
      language: 'ja',
      bypassPermissions: true,
    });
    engine.on('step:start', (step: WorkflowStep) => {
      activeOutcome = plan[visited.length];
      if (activeOutcome?.step !== step.name) {
        throw new Error(`Expected step "${activeOutcome?.step ?? '<none>'}", received "${step.name}"`);
      }
      visited.push(step.name);
    });
    engine.on('step:complete', (step, response) => {
      completed.push({ step: step.name, matchedRuleIndex: response.matchedRuleIndex });
    });

    vi.mocked(runAgent).mockImplementation(async (persona, task, options) => {
      if (activeOutcome === undefined) {
        throw new Error('Agent ran without an active planned step');
      }
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: task,
      });
      return makeResponse(activeOutcome);
    });
    vi.mocked(runStatusJudgmentPhase).mockImplementation(async (step) => {
      if (activeOutcome?.step !== step.name || activeOutcome.semantic === undefined) {
        throw new Error(`Missing semantic result for step "${step.name}"`);
      }
      return { label: activeOutcome.semantic, method: 'structured_output' };
    });

    const state = await engine.run();

    expect(visited).toEqual(plan.map((entry) => entry.step));
    expect(runAgent).toHaveBeenCalledTimes(plan.length);
    return { state, visited, completed };
  }

  it('runs the normal frontend path through its supervisor to COMPLETE', async () => {
    const result = await runScenario([
      { step: 'plan', semantic: '要件が明確で実装可能' },
      { step: 'write_tests', semantic: 'テスト作成が完了した' },
      { step: 'classify_implementation_scope', workType: 'frontend' },
      { step: 'implement_frontend', semantic: '実装が完了した' },
      { step: 'classify_review_scope', workType: 'frontend' },
      { step: 'review_frontend', semantic: 'approved' },
      { step: 'supervise_frontend', semantic: 'approved' },
    ]);

    expect(result.state.status).toBe('completed');
    expect(result.completed.at(-1)).toEqual({
      step: 'supervise_frontend',
      matchedRuleIndex: 1,
    });
  });

  it('routes needs_fix through fix and reclassification, then expands frontend review to dual', async () => {
    const result = await runScenario([
      { step: 'plan', semantic: '要件が明確で実装可能' },
      { step: 'write_tests', semantic: 'テスト作成が完了した' },
      { step: 'classify_implementation_scope', workType: 'frontend' },
      { step: 'implement_frontend', semantic: '実装が完了した' },
      { step: 'classify_review_scope', workType: 'frontend' },
      { step: 'review_frontend', semantic: 'needs_fix' },
      { step: 'fix_frontend', semantic: '修正完了' },
      { step: 'reclassify_review_scope_from_frontend', workType: 'dual' },
      { step: 'review_dual', semantic: 'approved' },
      { step: 'supervise_dual', semantic: 'approved' },
    ]);

    expect(result.state.status).toBe('completed');
    expect(result.completed).toEqual(expect.arrayContaining([
      { step: 'review_frontend', matchedRuleIndex: 1 },
      { step: 'fix_frontend', matchedRuleIndex: 0 },
      { step: 'reclassify_review_scope_from_frontend', matchedRuleIndex: 1 },
      { step: 'supervise_dual', matchedRuleIndex: 1 },
    ]));
    const reclassificationIndex = result.visited.indexOf('reclassify_review_scope_from_frontend');
    expect(result.visited.slice(reclassificationIndex + 1)).toEqual([
      'review_dual',
      'supervise_dual',
    ]);
  });
});
