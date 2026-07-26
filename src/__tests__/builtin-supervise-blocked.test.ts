import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  WorkflowConfigRawSchema,
  type AgentResponse,
  type WorkflowState,
  type WorkflowStep,
} from '../core/models/index.js';
import { RuleEvaluator } from '../core/workflow/evaluation/RuleEvaluator.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';
import { makeStep } from './test-helpers.js';

type Locale = 'en' | 'ja';
type RawWorkflow = ReturnType<typeof WorkflowConfigRawSchema.parse>;
type RawStep = RawWorkflow['steps'][number];

const locales: Locale[] = ['en', 'ja'];

function loadBuiltinWorkflow(locale: Locale, name: string): RawWorkflow {
  const path = join(process.cwd(), 'builtins', locale, 'workflows', `${name}.yaml`);
  return WorkflowConfigRawSchema.parse(parseYaml(readFileSync(path, 'utf8')));
}

function findRawStep(steps: RawStep[], name: string): RawStep {
  const step = steps.find((candidate) => candidate.name === name);
  if (step === undefined) {
    throw new Error(`Missing step: ${name}`);
  }
  return step;
}

function toRuleStep(step: RawStep): WorkflowStep {
  return makeStep({
    name: step.name,
    rules: step.rules?.map(normalizeRule),
    parallel: step.parallel?.map(toRuleStep),
  });
}

function createState(stepOutputs = new Map<string, AgentResponse>()): WorkflowState {
  return {
    workflowName: 'builtin-supervise-blocked',
    currentStep: 'reviewers',
    iteration: 1,
    status: 'running',
    stepOutputs,
    structuredOutputs: new Map(),
    systemContexts: new Map(),
    effectResults: new Map(),
    userInputs: [],
    personaSessions: new Map(),
    stepIterations: new Map(),
  };
}

function outputFor(step: WorkflowStep, selection: string): AgentResponse {
  const match = new RuleEvaluator(step, { state: createState() }).evaluate({
    label: selection,
    method: 'structured_output',
  });
  if (match === undefined) {
    throw new Error(`No rule matched for ${step.name}: ${selection}`);
  }
  return {
    persona: step.name,
    status: 'done',
    content: selection,
    timestamp: new Date(0),
    matchedRuleIndex: match.index,
    matchedRuleMethod: match.method,
  };
}

function selectedNext(step: WorkflowStep, state: WorkflowState): string | undefined {
  const match = new RuleEvaluator(step, { state }).evaluate(undefined);
  return match === undefined ? undefined : step.rules?.[match.index]?.next;
}

function visitSteps(
  steps: RawStep[],
  visitor: (step: RawStep, parent?: RawStep) => void,
  parent?: RawStep,
): void {
  for (const step of steps) {
    visitor(step, parent);
    visitSteps(step.parallel ?? [], visitor, step);
  }
}

describe('builtin supervise environment blocker routing', () => {
  it.each(locales)(
    'should make BLOCKED the highest-priority ABORT route for every shared supervise consumer in %s',
    (locale) => {
      const workflowsDir = join(process.cwd(), 'builtins', locale, 'workflows');
      let superviseConsumers = 0;

      for (const filename of readdirSync(workflowsDir).filter((name) => name.endsWith('.yaml'))) {
        const workflow = loadBuiltinWorkflow(locale, filename.slice(0, -'.yaml'.length));
        visitSteps(workflow.steps, (step, parent) => {
          if (step.instruction !== 'supervise') return;
          superviseConsumers++;

          const summary = step.output_contracts?.report?.find((report) => report.name === 'summary.md');
          expect(summary?.format, `${filename}:${step.name}:summary.md`).toBe('supervisor-summary');
          expect(step.rules?.[0]?.condition, `${filename}:${step.name}`).toBe('BLOCKED');
          if (parent === undefined) {
            expect(step.rules?.[0]?.next, `${filename}:${step.name}`).toBe('ABORT');
            return;
          }

          expect(parent.rules?.[0], `${filename}:${parent.name}`).toEqual({
            condition: 'any("BLOCKED")',
            next: 'ABORT',
          });
        });
      }

      expect(superviseConsumers).toBeGreaterThan(0);
    },
  );

  it.each([
    {
      locale: 'en' as const,
      noAiIssue: 'No AI-specific issues',
      aiIssue: 'AI-specific issues found',
      verificationFailure: 'Requirements unmet, tests failing',
    },
    {
      locale: 'ja' as const,
      noAiIssue: 'AI特有の問題なし',
      aiIssue: 'AI特有の問題あり',
      verificationFailure: '要求未達成、テスト失敗、ビルドエラー',
    },
  ])(
    'should prioritize BLOCKED over remediation while retaining normal remediation in $locale',
    ({ locale, noAiIssue, aiIssue, verificationFailure }) => {
      const rawReviewers = findRawStep(loadBuiltinWorkflow(locale, 'frontend-mini').steps, 'reviewers');
      const reviewers = toRuleStep(rawReviewers);
      const rawAiReview = rawReviewers.parallel?.find((step) => (
        step.rules?.some((rule) => rule.condition === aiIssue)
      ));
      const supervise = reviewers.parallel?.find((step) => step.name === 'supervise');
      const aiReview = reviewers.parallel?.find((step) => step.name === rawAiReview?.name);
      if (aiReview === undefined || supervise === undefined) {
        throw new Error(`frontend-mini ${locale} is missing reviewer sub-steps`);
      }

      const blockedState = createState(new Map([
        [aiReview.name, outputFor(aiReview, aiIssue)],
        [supervise.name, outputFor(supervise, 'BLOCKED')],
      ]));
      expect(selectedNext(reviewers, blockedState)).toBe('ABORT');

      const implementationFailureState = createState(new Map([
        [aiReview.name, outputFor(aiReview, noAiIssue)],
        [supervise.name, outputFor(supervise, verificationFailure)],
      ]));
      expect(selectedNext(reviewers, implementationFailureState)).toBe('supervise_fix');
    },
  );
});
