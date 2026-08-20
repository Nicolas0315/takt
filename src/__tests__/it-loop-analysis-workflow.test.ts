/**
 * Loop-analysis builtin workflow IT (order.md §3/§4).
 *
 * Runs the real builtin `loop-analysis` workflow through WorkflowEngine with the
 * mock provider. The report phase is the real one, so the analysis report is
 * persisted through the actual output-contract machinery; only the Phase 3 status
 * judgment is replaced with deterministic tag detection.
 *
 * Covered contracts:
 * - a rejected review feeds back into the analyzer and the loop terminates
 *   (approve -> COMPLETE, permanent rejection -> bounded iteration-limit abort)
 * - the reviewer prompt embeds the analyzer's actual report via {report:...}
 * - the final report file always exists under the run's reports/ directory with
 *   the required sections, finalized by the review step (including the last
 *   rejection at the iteration limit)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setMockScenario, resetScenario } from '../infra/mock/index.js';
import { ProviderNeutralStructuredCaller } from '../agents/structured-caller.js';
import type { WorkflowStep } from '../core/models/index.js';
import { semanticRuleCandidatesOf } from '../core/models/workflow-rule-condition.js';
import { RuleDetectionExhaustedError } from '../core/workflow/evaluation/RuleDetectionExhaustedError.js';
import { detectCandidateIndex } from '../shared/utils/ruleIndex.js';

const mockCallLog = vi.hoisted(() => ({
  calls: [] as { persona: string; prompt: string }[],
}));

vi.mock('../infra/mock/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/mock/client.js')>();
  return {
    ...actual,
    callMock: (personaName: string, prompt: string, options: Parameters<typeof actual.callMock>[2]) => {
      mockCallLog.calls.push({ persona: personaName, prompt });
      return actual.callMock(personaName, prompt, options);
    },
    callMockCustom: (
      personaName: string,
      prompt: string,
      systemPrompt: string,
      options: Parameters<typeof actual.callMockCustom>[3],
    ) => {
      mockCallLog.calls.push({ persona: personaName, prompt });
      return actual.callMockCustom(personaName, prompt, systemPrompt, options);
    },
  };
});

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

import { WorkflowEngine } from '../core/workflow/index.js';
import { loadWorkflowByIdentifier } from '../infra/config/index.js';

const RUN_SLUG = 'loop-analysis-it-run';

function buildReportContent(marker: string): string {
  return [
    '# Loop Analysis Report',
    '',
    '## Source Run',
    '/project/.takt/runs/source-run',
    '',
    '## Observed Loops',
    '| Loop | Evidence | Prompt-level cause |',
    '|------|----------|--------------------|',
    '| repeated reads | logs/session-1.jsonl | missing stop condition |',
    '',
    '## Adopted Proposals',
    '| Facet file | Amendment |',
    '|------------|-----------|',
    '| builtins/en/facets/instructions/example.md | Add a stop condition |',
    '',
    '## Rejected Proposals',
    '| Facet file | Proposal | Rejection reason |',
    '|------------|----------|------------------|',
    `| ${marker} | proposal | rejection reason |`,
    '',
  ].join('\n');
}

const REQUIRED_REPORT_SECTIONS = [
  '## Source Run',
  '## Observed Loops',
  '## Adopted Proposals',
  '## Rejected Proposals',
];

const REQUIRED_REPORT_VALUES = [
  'builtins/en/facets/instructions/example.md',
  'Add a stop condition',
  'rejection reason',
];

describe('loop-analysis builtin workflow IT', () => {
  let testDir: string;
  let globalConfigDir: string;
  let originalTaktConfigDir: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCallLog.calls.length = 0;
    testDir = mkdtempSync(join(tmpdir(), 'takt-it-loop-analysis-'));
    globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-it-loop-analysis-global-'));
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
    rmSync(testDir, { recursive: true, force: true });
    rmSync(globalConfigDir, { recursive: true, force: true });
  });

  function loadLoopAnalysisWorkflow() {
    const workflow = loadWorkflowByIdentifier('loop-analysis', testDir);
    if (workflow === null) {
      throw new Error('builtin loop-analysis workflow did not load');
    }
    return workflow;
  }

  function runLoopAnalysis() {
    const workflow = loadLoopAnalysisWorkflow();
    const engine = new WorkflowEngine(workflow, testDir, 'Analyze the finished run', {
      projectCwd: testDir,
      provider: 'mock',
      reportDirName: RUN_SLUG,
      structuredCaller: new ProviderNeutralStructuredCaller(),
    });
    return engine.run();
  }

  function reportPath(): string {
    return join(testDir, '.takt', 'runs', RUN_SLUG, 'reports', 'loop-analysis.md');
  }

  it('Given a rejected first review, When the loop feeds back and the second review approves, Then the run completes and the final report is persisted with all required sections', async () => {
    const reportV1 = buildReportContent('v1-report-marker');
    const reportV2 = buildReportContent('v2-report-marker');
    const finalReport = buildReportContent('final-report-marker');
    setMockScenario([
      { persona: 'loop-analyzer', status: 'done', content: '[ANALYZE:1]\n\nAnalysis complete.' },
      { persona: 'loop-analyzer', status: 'done', content: reportV1 },
      { persona: 'loop-analysis-reviewer', status: 'done', content: '[REVIEW:2]\n\nrejected: over-specialized proposal.' },
      { persona: 'loop-analysis-reviewer', status: 'done', content: reportV1 },
      { persona: 'loop-analyzer', status: 'done', content: '[ANALYZE:1]\n\nRevised analysis complete.' },
      { persona: 'loop-analyzer', status: 'done', content: reportV2 },
      { persona: 'loop-analysis-reviewer', status: 'done', content: '[REVIEW:1]\n\napproved.' },
      { persona: 'loop-analysis-reviewer', status: 'done', content: finalReport },
    ]);

    const state = await runLoopAnalysis();

    expect(state.status).toBe('completed');
    expect(state.iteration).toBe(4);
    const analyzerCalls = mockCallLog.calls.filter((call) => call.persona === 'loop-analyzer');
    const reviewerCalls = mockCallLog.calls.filter((call) => call.persona === 'loop-analysis-reviewer');
    expect(analyzerCalls).toHaveLength(4);
    expect(reviewerCalls).toHaveLength(4);
    expect(reviewerCalls[0]!.prompt).toContain('v1-report-marker');
    const secondReviewerPrompt = reviewerCalls[2]!.prompt;
    expect(secondReviewerPrompt).toContain('v2-report-marker');

    const finalReportPath = reportPath();
    expect(existsSync(finalReportPath)).toBe(true);
    const persisted = readFileSync(finalReportPath, 'utf-8');
    for (const section of REQUIRED_REPORT_SECTIONS) {
      expect(persisted).toContain(section);
    }
    for (const value of REQUIRED_REPORT_VALUES) {
      expect(persisted).toContain(value);
    }
    expect(persisted).toContain('final-report-marker');
  });

  it('Given reviews that always reject, When the rework loop reaches its bound, Then the run aborts at the iteration limit and the final report keeps the last rejection', async () => {
    const analysisReport = buildReportContent('analysis-report-marker');
    const reviewReport = buildReportContent('review-report-marker');
    const finalRejectionReport = buildReportContent('final-rejection-marker');
    setMockScenario([
      { persona: 'loop-analyzer', status: 'done', content: '[ANALYZE:1]\n\nAnalysis 1.' },
      { persona: 'loop-analyzer', status: 'done', content: analysisReport },
      { persona: 'loop-analysis-reviewer', status: 'done', content: '[REVIEW:2]\n\nrejected 1.' },
      { persona: 'loop-analysis-reviewer', status: 'done', content: reviewReport },
      { persona: 'loop-analyzer', status: 'done', content: '[ANALYZE:1]\n\nAnalysis 2.' },
      { persona: 'loop-analyzer', status: 'done', content: analysisReport },
      { persona: 'loop-analysis-reviewer', status: 'done', content: '[REVIEW:2]\n\nrejected 2.' },
      { persona: 'loop-analysis-reviewer', status: 'done', content: reviewReport },
      { persona: 'loop-analyzer', status: 'done', content: '[ANALYZE:1]\n\nAnalysis 3.' },
      { persona: 'loop-analyzer', status: 'done', content: analysisReport },
      { persona: 'loop-analysis-reviewer', status: 'done', content: '[REVIEW:2]\n\nrejected 3.' },
      { persona: 'loop-analysis-reviewer', status: 'done', content: finalRejectionReport },
    ]);

    const state = await runLoopAnalysis();

    expect(state.status).toBe('aborted');
    expect(state.iteration).toBe(6);
    const analyzerCalls = mockCallLog.calls.filter((call) => call.persona === 'loop-analyzer');
    const reviewerCalls = mockCallLog.calls.filter((call) => call.persona === 'loop-analysis-reviewer');
    expect(analyzerCalls).toHaveLength(6);
    expect(reviewerCalls).toHaveLength(6);

    const finalReportPath = reportPath();
    expect(existsSync(finalReportPath)).toBe(true);
    const persisted = readFileSync(finalReportPath, 'utf-8');
    for (const section of REQUIRED_REPORT_SECTIONS) {
      expect(persisted).toContain(section);
    }
    for (const value of REQUIRED_REPORT_VALUES) {
      expect(persisted).toContain(value);
    }
    expect(persisted).toContain('final-rejection-marker');
  });
});
