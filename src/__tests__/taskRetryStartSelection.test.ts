import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  WorkflowCallStep,
  WorkflowConfig,
  WorkflowRestartPoint,
  WorkflowResumePoint,
  WorkflowStep,
} from '../core/models/index.js';
import { MAX_WORKFLOW_CALL_DEPTH } from '../core/workflow/workflow-call-depth.js';
import {
  selectTaskRetryStart,
} from '../features/tasks/list/taskRetryStartSelection.js';
import { validateTaskRetryRestartPoint } from '../features/tasks/taskRetryStartPath.js';
import type { SelectOptionItem } from '../shared/prompt/index.js';
import { attachWorkflowOpaqueRef } from '../infra/config/loaders/workflowSourceMetadata.js';

const mockResolveWorkflowCallTarget = vi.hoisted(() => vi.fn());

vi.mock('../infra/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveWorkflowCallTarget: (...args: unknown[]) => mockResolveWorkflowCallTarget(...args),
}));

const pathContext = {
  projectCwd: '/project',
  lookupCwd: '/project/worktree',
};

type TreeOption = SelectOptionItem<string> & { leadingLines?: string[] };

function agentStep(name: string): WorkflowStep {
  return {
    name,
    persona: `${name}-persona`,
    personaDisplayName: name,
    instruction: `${name} instruction`,
  };
}

function synthesizedAgentStep(name: string): WorkflowStep {
  return { ...agentStep(name), engineSynthesized: true };
}

function callStep(name: string, call: string): WorkflowCallStep {
  return {
    name,
    kind: 'workflow_call',
    call,
    personaDisplayName: name,
    instruction: `${name} instruction`,
  };
}

function systemStep(name: string, effects?: WorkflowStep['effects']): WorkflowStep {
  return {
    name,
    kind: 'system',
    personaDisplayName: name,
    instruction: `${name} instruction`,
    ...(effects === undefined ? {} : { effects }),
  };
}

function parallelStep(name: string, parallel: WorkflowStep[] = [agentStep(`${name}-worker`)]): WorkflowStep {
  return {
    ...agentStep(name),
    parallel,
  };
}

function makeWorkflow(options: {
  name: string;
  ref: string;
  steps: WorkflowStep[];
  initialStep?: string;
  callable?: boolean;
}): WorkflowConfig {
  return attachWorkflowOpaqueRef({
    name: options.name,
    initialStep: options.initialStep ?? options.steps[0]!.name,
    maxSteps: 20,
    steps: options.steps,
    ...(options.callable ? { subworkflow: { callable: true } } : {}),
  }, options.ref);
}

function asTreeOptions(options: SelectOptionItem<string>[]): TreeOption[] {
  return options as TreeOption[];
}

function optionLabel(option: TreeOption): string {
  return option.label.trim();
}

function findLeaf(
  options: SelectOptionItem<string>[],
  label: string,
  occurrence = 0,
): SelectOptionItem<string> {
  const matches = options.filter((option) => option.label.trim() === label);
  const match = matches[occurrence];
  if (match === undefined) {
    throw new Error(`Missing leaf option: ${label} (#${occurrence})`);
  }
  return match;
}

function rootRestartPoint(step: string, kind: 'agent' | 'system' = 'agent'): WorkflowRestartPoint {
  return {
    stack: [{
      workflow: 'default',
      workflow_ref: 'project:root',
      step,
      kind,
    }],
  };
}

function resumePointWithStack(stack: WorkflowResumePoint['stack']): WorkflowResumePoint {
  return {
    version: 2,
    stack,
    iteration: 4,
    elapsed_ms: 1_000,
    workflow_call_invocations: {},
    workflow_step_participations: {},
  };
}

function rootResumePoint(
  step: string,
  kind: 'agent' | 'system' | 'parallel',
): WorkflowResumePoint {
  return resumePointWithStack([{
    workflow: 'default',
    workflow_ref: 'project:root',
    step,
    kind,
    occurrence: 1,
  }]);
}

beforeEach(() => {
  mockResolveWorkflowCallTarget.mockReset();
});

describe('task retry start tree selection', () => {
  it('should keep the initial picker window bounded for a large root workflow', async () => {
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: Array.from({ length: 100_000 }, (_, index) => agentStep(`step-${index}`)),
    });
    let observedOptions: TreeOption[] = [];
    let observedDefault = '';

    const result = await selectTaskRetryStart(root, pathContext, async (
      _message,
      options,
      defaultValue,
    ) => {
      observedOptions = asTreeOptions(options);
      observedDefault = defaultValue;
      return defaultValue;
    });

    expect(observedOptions.length).toBeLessThanOrEqual(50);
    expect(observedOptions).toHaveLength(50);
    expect(observedOptions.at(-1)?.label.trim()).toBe('step-49');
    expect(observedDefault).toBe(observedOptions[0]?.value);
    expect(mockResolveWorkflowCallTarget).not.toHaveBeenCalled();
    expect(result?.selection.kind).toBe('restart');
  });

  it('should include the preferred child leaf within the shared initial window', async () => {
    const child = makeWorkflow({
      name: 'child',
      ref: 'project:child',
      callable: true,
      steps: Array.from({ length: 6 }, (_, index) => agentStep(`review-${index}`)),
    });
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [
        ...Array.from({ length: 49 }, (_, index) => agentStep(`step-${index}`)),
        callStep('delegate', 'child'),
      ],
    });
    mockResolveWorkflowCallTarget.mockReturnValue(child);
    let observedOptions: TreeOption[] = [];
    let observedDefault = '';

    const result = await selectTaskRetryStart(root, {
      ...pathContext,
      preferredRootStep: 'delegate',
    }, async (_message, options, defaultValue) => {
      observedOptions = asTreeOptions(options);
      observedDefault = defaultValue;
      return defaultValue;
    });

    const preferredLeaf = findLeaf(observedOptions, 'review-0');
    expect(observedOptions.length).toBeLessThanOrEqual(50);
    expect(new Set(observedOptions.map((option) => option.value)).size).toBe(observedOptions.length);
    expect(observedDefault).toBe(preferredLeaf.value);
    expect(result?.selection.kind).toBe('restart');
    expect(result?.selection.kind === 'restart'
      ? result.selection.restartPoint.stack.at(-1)?.step
      : undefined).toBe('review-0');
  });

  it('should reserve the late Resume leaf when earlier root leaves fill the window', async () => {
    const child = makeWorkflow({
      name: 'child',
      ref: 'project:child',
      callable: true,
      steps: Array.from({ length: 100 }, (_, index) => agentStep(`review-${index}`)),
    });
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [
        ...Array.from({ length: 49 }, (_, index) => agentStep(`step-${index}`)),
        callStep('delegate', 'child'),
      ],
    });
    const resumePoint = resumePointWithStack([
      {
        workflow: 'default',
        workflow_ref: 'project:root',
        step: 'delegate',
        kind: 'workflow_call',
        occurrence: 1,
        call_instance: 1,
      },
      {
        workflow: 'child',
        workflow_ref: 'project:child',
        step: 'review-99',
        kind: 'agent',
        occurrence: 1,
      },
    ]);
    mockResolveWorkflowCallTarget.mockReturnValue(child);
    let observedOptions: TreeOption[] = [];

    const result = await selectTaskRetryStart(root, {
      ...pathContext,
      resumePoint,
    }, async (_message, options, defaultValue) => {
      observedOptions = asTreeOptions(options);
      expect(options.some((option) => option.value === 'resume-checkpoint')).toBe(true);
      expect(defaultValue).toBe('resume-checkpoint');
      return defaultValue;
    });

    expect(observedOptions.length).toBeLessThanOrEqual(50);
    expect(observedOptions.some((option) => option.label.trim() === 'delegate')).toBe(true);
    expect(observedOptions.some((option) => option.label.trim() === 'review-99')).toBe(true);
    expect(result?.selection).toEqual({ kind: 'resume', resumePoint });
  });

  it('should reserve the late preferred child leaf when earlier root leaves fill the window', async () => {
    const child = makeWorkflow({
      name: 'child',
      ref: 'project:child',
      callable: true,
      initialStep: 'review-99',
      steps: Array.from({ length: 100 }, (_, index) => agentStep(`review-${index}`)),
    });
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [
        ...Array.from({ length: 49 }, (_, index) => agentStep(`step-${index}`)),
        callStep('delegate', 'child'),
      ],
    });
    mockResolveWorkflowCallTarget.mockReturnValue(child);
    let observedOptions: TreeOption[] = [];

    const result = await selectTaskRetryStart(root, {
      ...pathContext,
      preferredRootStep: 'delegate',
    }, async (_message, options, defaultValue) => {
      observedOptions = asTreeOptions(options);
      const preferredLeaf = findLeaf(options, 'review-99');
      expect(defaultValue).toBe(preferredLeaf.value);
      return defaultValue;
    });

    expect(observedOptions.length).toBeLessThanOrEqual(50);
    expect(observedOptions.some((option) => option.label.trim() === 'delegate')).toBe(true);
    expect(observedOptions.some((option) => option.label.trim() === 'review-99')).toBe(true);
    expect(result?.selection.kind).toBe('restart');
    expect(result?.selection.kind === 'restart'
      ? result.selection.restartPoint.stack.at(-1)?.step
      : undefined).toBe('review-99');
  });

  it('should reserve every ancestor navigation for a late nested Resume leaf', async () => {
    const grandchild = makeWorkflow({
      name: 'grandchild',
      ref: 'project:grandchild',
      callable: true,
      steps: [agentStep('review-99')],
    });
    const child = makeWorkflow({
      name: 'child',
      ref: 'project:child',
      callable: true,
      steps: [
        ...Array.from({ length: 48 }, (_, index) => agentStep(`child-${index}`)),
        callStep('delegate-grandchild', 'grandchild'),
      ],
    });
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [
        ...Array.from({ length: 49 }, (_, index) => agentStep(`step-${index}`)),
        callStep('delegate-child', 'child'),
      ],
    });
    const resumePoint = resumePointWithStack([
      {
        workflow: 'default',
        workflow_ref: 'project:root',
        step: 'delegate-child',
        kind: 'workflow_call',
        occurrence: 1,
        call_instance: 1,
      },
      {
        workflow: 'child',
        workflow_ref: 'project:child',
        step: 'delegate-grandchild',
        kind: 'workflow_call',
        occurrence: 1,
        call_instance: 1,
      },
      {
        workflow: 'grandchild',
        workflow_ref: 'project:grandchild',
        step: 'review-99',
        kind: 'agent',
        occurrence: 1,
      },
    ]);
    mockResolveWorkflowCallTarget.mockImplementation(
      (_parent: WorkflowConfig, step: { call: string }) => (
        step.call === 'child' ? child : grandchild
      ),
    );
    let observedOptions: TreeOption[] = [];

    const result = await selectTaskRetryStart(root, {
      ...pathContext,
      resumePoint,
    }, async (_message, options, defaultValue) => {
      observedOptions = asTreeOptions(options);
      expect(options.some((option) => option.value === 'resume-checkpoint')).toBe(true);
      expect(defaultValue).toBe('resume-checkpoint');
      return defaultValue;
    });

    expect(observedOptions.length).toBeLessThanOrEqual(50);
    expect(observedOptions.some((option) => option.label.trim() === 'delegate-child')).toBe(true);
    expect(observedOptions.some((option) => option.label.trim() === 'delegate-grandchild')).toBe(true);
    expect(observedOptions.some((option) => option.label.trim() === 'review-99')).toBe(true);
    expect(result?.selection).toEqual({ kind: 'resume', resumePoint });
  });

  it('should keep a static parallel fanout within the initial picker window', async () => {
    const child = makeWorkflow({
      name: 'child',
      ref: 'project:child',
      callable: true,
      steps: [agentStep('review')],
    });
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [
        parallelStep(
          'reviewers',
          Array.from({ length: 100 }, (_, index) => callStep(`delegate-${index}`, 'child')),
        ),
        agentStep('finish'),
      ],
    });
    mockResolveWorkflowCallTarget.mockReturnValue(child);
    let observedOptions: TreeOption[] = [];

    const result = await selectTaskRetryStart(root, pathContext, async (
      _message,
      options,
      defaultValue,
    ) => {
      observedOptions = asTreeOptions(options);
      return defaultValue;
    });

    expect(observedOptions.length).toBeLessThanOrEqual(50);
    expect(observedOptions.map(optionLabel)).toEqual(['reviewers', 'finish']);
    expect(mockResolveWorkflowCallTarget).not.toHaveBeenCalled();
    expect(result?.selection.kind).toBe('restart');
  });

  it('should expose multiple static parallel parents without resolving their children', async () => {
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [
        parallelStep('reviewers-a', [callStep('delegate-a', 'child')]),
        parallelStep('reviewers-b', [callStep('delegate-b', 'child')]),
        agentStep('finish'),
      ],
    });
    const child = makeWorkflow({
      name: 'child',
      ref: 'project:child',
      callable: true,
      steps: [agentStep('review')],
    });
    mockResolveWorkflowCallTarget.mockReturnValue(child);
    let observedOptions: TreeOption[] = [];

    const result = await selectTaskRetryStart(root, pathContext, async (
      _message,
      options,
      defaultValue,
      callbacks,
    ) => {
      observedOptions = asTreeOptions(options);
      const firstParent = findLeaf(options, 'reviewers-a');
      const withFirstChildren = callbacks?.onKeyPress?.(
        '\x1B[B',
        firstParent.value,
        options.indexOf(firstParent),
      );
      expect(withFirstChildren?.some((option) => option.label.trim() === 'delegate-a')).toBe(true);
      const secondParent = withFirstChildren?.find((option) => option.label.trim() === 'reviewers-b');
      expect(secondParent).toBeDefined();
      const withSecondChildren = callbacks?.onKeyPress?.(
        '\x1B[B',
        secondParent!.value,
        withFirstChildren!.indexOf(secondParent!),
      );
      expect(withSecondChildren?.some((option) => option.label.trim() === 'delegate-b')).toBe(true);
      return defaultValue;
    });

    expect(observedOptions.map(optionLabel)).toEqual(['reviewers-a', 'reviewers-b', 'finish']);
    expect(mockResolveWorkflowCallTarget).not.toHaveBeenCalled();
    expect(result?.selection.kind).toBe('restart');
  });

  it('should keep static parallel child leaves out of authored restart selections', async () => {
    const child = makeWorkflow({
      name: 'child',
      ref: 'project:child',
      callable: true,
      steps: [agentStep('review')],
    });
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [parallelStep('reviewers', [callStep('delegate', 'child')]), agentStep('finish')],
    });
    mockResolveWorkflowCallTarget.mockReturnValue(child);
    let promptCount = 0;
    let observedOptions: TreeOption[] = [];

    const result = await selectTaskRetryStart(root, pathContext, async (
      _message,
      options,
      _defaultValue,
      callbacks,
    ) => {
      promptCount += 1;
      observedOptions = asTreeOptions(options);
      if (promptCount === 1) {
        const parent = findLeaf(options, 'reviewers');
        const updatedOptions = callbacks?.onKeyPress?.(
          '\x1B[B',
          parent.value,
          options.indexOf(parent),
        );
        expect(updatedOptions?.some((option) => option.label.trim() === 'delegate')).toBe(true);
        return updatedOptions!.find((option) => option.label.trim() === 'delegate')!.value;
      }

      expect(observedOptions.some((option) => option.label.trim() === 'review')).toBe(false);
      return findLeaf(options, 'reviewers').value;
    });

    expect(promptCount).toBe(2);
    expect(result?.selection.kind).toBe('restart');
    if (result?.selection.kind !== 'restart') {
      throw new Error('Expected an authored restart selection');
    }
    expect(result.selection.restartPoint.stack).toHaveLength(1);
    expect(() => validateTaskRetryRestartPoint(
      root,
      result.selection.restartPoint,
      pathContext,
    )).not.toThrow();
  });

  it('should keep a late static parallel Resume leaf in the initial window', async () => {
    const child = makeWorkflow({
      name: 'child',
      ref: 'project:child',
      callable: true,
      steps: [agentStep('review')],
    });
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [
        parallelStep(
          'reviewers',
          Array.from({ length: 100 }, (_, index) => callStep(`delegate-${index}`, 'child')),
        ),
      ],
    });
    const resumePoint = resumePointWithStack([
      {
        workflow: 'default',
        workflow_ref: 'project:root',
        step: 'reviewers',
        kind: 'parallel',
        occurrence: 1,
      },
      {
        workflow: 'default',
        workflow_ref: 'project:root',
        step: 'delegate-99',
        kind: 'workflow_call',
        occurrence: 1,
        call_instance: 1,
      },
      {
        workflow: 'child',
        workflow_ref: 'project:child',
        step: 'review',
        kind: 'agent',
        occurrence: 1,
      },
    ]);
    mockResolveWorkflowCallTarget.mockReturnValue(child);
    let observedOptions: TreeOption[] = [];
    let observedDefault = '';

    const result = await selectTaskRetryStart(root, {
      ...pathContext,
      resumePoint,
    }, async (_message, options, defaultValue) => {
      observedOptions = asTreeOptions(options);
      observedDefault = defaultValue;
      return defaultValue;
    });

    expect(observedOptions.length).toBeLessThanOrEqual(50);
    expect(observedOptions.some((option) => option.value === 'resume-checkpoint')).toBe(true);
    expect(observedDefault).toBe('resume-checkpoint');
    expect(result?.selection).toEqual({ kind: 'resume', resumePoint });
  });

  it('should choose a single initial window when Resume and default target different windows', async () => {
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: Array.from({ length: 100 }, (_, index) => agentStep(`step-${index}`)),
    });
    const resumePoint = rootResumePoint('step-10', 'agent');
    let observedOptions: TreeOption[] = [];
    let observedDefault = '';

    const result = await selectTaskRetryStart(root, {
      ...pathContext,
      resumePoint,
      preferredRootStep: 'step-90',
    }, async (_message, options, defaultValue) => {
      observedOptions = asTreeOptions(options);
      observedDefault = defaultValue;
      return defaultValue;
    });

    expect(observedOptions).toHaveLength(50);
    expect(observedOptions.some((option) => option.label.trim() === 'step-10')).toBe(true);
    expect(observedOptions.some((option) => option.label.trim() === 'step-90')).toBe(false);
    expect(observedDefault).toBe('resume-checkpoint');
    expect(result?.selection).toEqual({ kind: 'resume', resumePoint });
  });

  it('should not resolve an unopened workflow call in the initial picker window', async () => {
    const child = makeWorkflow({
      name: 'child',
      ref: 'project:child',
      callable: true,
      steps: [agentStep('review')],
    });
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [agentStep('plan'), callStep('delegate', 'child'), agentStep('finish')],
    });
    mockResolveWorkflowCallTarget.mockReturnValue(child);
    let observedOptions: TreeOption[] = [];

    const result = await selectTaskRetryStart(root, pathContext, async (
      _message,
      options,
      defaultValue,
    ) => {
      observedOptions = asTreeOptions(options);
      return defaultValue;
    });

    expect(observedOptions.map(optionLabel)).toEqual(['plan', 'delegate', 'finish']);
    expect(observedOptions.some((option) => option.label.trim() === 'review')).toBe(false);
    expect(mockResolveWorkflowCallTarget).not.toHaveBeenCalled();
    expect(result?.selection.kind).toBe('restart');
  });

  it('should show workflow calls as headings and expose only leaves in one tree', async () => {
    const child = makeWorkflow({
      name: 'peer-review',
      ref: 'project:peer-review',
      callable: true,
      steps: [agentStep('initial-reviewers'), agentStep('reviewers')],
    });
    const root = makeWorkflow({
      name: 'development-core',
      ref: 'project:root',
      steps: [agentStep('plan'), callStep('peer-review', 'peer-review')],
    });
    mockResolveWorkflowCallTarget.mockReturnValue(child);
    let observedOptions: TreeOption[] = [];
    let observedMessage = '';

    let promptCount = 0;
    const result = await selectTaskRetryStart(root, pathContext, async (message, options) => {
      observedMessage = message;
      observedOptions = asTreeOptions(options);
      promptCount += 1;
      if (promptCount === 1) {
        return options.find((option) => option.label.trim() === 'peer-review')!.value;
      }
      return findLeaf(options, 'reviewers').value;
    });

    expect(observedMessage).not.toContain('page');
    expect(observedOptions.map(optionLabel)).toEqual([
      'plan',
      'peer-review',
      'initial-reviewers',
      'reviewers',
    ]);
    expect(observedOptions.some((option) => (
      option.leadingLines?.some((line) => line.trim() === 'peer-review') === true
    ))).toBe(true);
    expect(observedOptions.map((option) => option.label).join('\n'))
      .not.toMatch(/Restart from:|Browse child workflow from:| > /);
    expect(result?.selection.kind).toBe('restart');
    expect(result?.selection.kind === 'restart'
      ? result.selection.restartPoint.stack.at(-1)
      : undefined).toEqual(expect.objectContaining({
      workflow_ref: 'project:peer-review',
      step: 'reviewers',
      kind: 'agent',
    }));
    expect(result?.selection.kind === 'restart'
      ? result.selection.restartPoint.stack.at(-1)?.kind
      : undefined).not.toBe('workflow_call');
  });

  it('should use the matching nested leaf as the default when the preferred step is a call', async () => {
    const child = makeWorkflow({
      name: 'coding',
      ref: 'project:child',
      callable: true,
      initialStep: 'implement',
      steps: [agentStep('implement'), agentStep('review')],
    });
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      initialStep: 'delegate',
      steps: [callStep('delegate', 'coding'), agentStep('review')],
    });
    mockResolveWorkflowCallTarget.mockReturnValue(child);
    let observedOptions: TreeOption[] = [];
    let observedDefault = '';

    const result = await selectTaskRetryStart(root, {
      ...pathContext,
      preferredRootStep: 'delegate',
    }, async (_message, options, defaultValue) => {
      observedOptions = asTreeOptions(options);
      observedDefault = defaultValue;
      return defaultValue;
    });

    const childInitial = findLeaf(observedOptions, 'implement');
    expect(observedDefault).toBe(childInitial.value);
    expect(result?.selection.kind).toBe('restart');
    expect(result?.selection.kind === 'restart'
      ? result.selection.restartPoint.stack.at(-1)?.step
      : undefined).toBe('implement');
  });

  it('should use the first restartable leaf after an unrestartable child initial step', async () => {
    const child = makeWorkflow({
      name: 'delegate-workflow',
      ref: 'project:child',
      callable: true,
      initialStep: 'publish',
      steps: [
        agentStep('prepare'),
        systemStep('publish', [{ type: 'merge_pr', pr: 42 }]),
        agentStep('implement'),
      ],
    });
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      initialStep: 'delegate',
      steps: [agentStep('plan'), callStep('delegate', 'delegate-workflow'), agentStep('finish')],
    });
    mockResolveWorkflowCallTarget.mockReturnValue(child);
    let observedOptions: TreeOption[] = [];
    let observedDefault = '';

    await selectTaskRetryStart(root, {
      ...pathContext,
      preferredRootStep: 'delegate',
    }, async (_message, options, defaultValue) => {
      observedOptions = asTreeOptions(options);
      observedDefault = defaultValue;
      return defaultValue;
    });

    const plan = findLeaf(observedOptions, 'plan');
    const prepare = findLeaf(observedOptions, 'prepare');
    const implement = findLeaf(observedOptions, 'implement');
    expect(observedDefault).toBe(implement.value);
    expect(observedDefault).not.toBe(plan.value);
    expect(observedDefault).not.toBe(prepare.value);
  });

  it('should fall back to the first leaf when a preferred child has no later restartable leaf', async () => {
    const child = makeWorkflow({
      name: 'delegate-workflow',
      ref: 'project:child',
      callable: true,
      initialStep: 'publish',
      steps: [agentStep('prepare'), systemStep('publish', [{ type: 'merge_pr', pr: 42 }])],
    });
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      initialStep: 'delegate',
      steps: [agentStep('plan'), callStep('delegate', 'delegate-workflow'), agentStep('finish')],
    });
    mockResolveWorkflowCallTarget.mockReturnValue(child);
    let observedOptions: TreeOption[] = [];
    let observedDefault = '';

    await selectTaskRetryStart(root, {
      ...pathContext,
      preferredRootStep: 'delegate',
    }, async (_message, options, defaultValue) => {
      observedOptions = asTreeOptions(options);
      observedDefault = defaultValue;
      return defaultValue;
    });

    const plan = findLeaf(observedOptions, 'plan');
    const prepare = observedOptions.find((option) => option.label.trim() === 'prepare');
    const finish = findLeaf(observedOptions, 'finish');
    expect(observedDefault).toBe(plan.value);
    expect(prepare).toBeUndefined();
    expect(observedDefault).not.toBe(finish.value);
  });

  it('should align a valid resume checkpoint with the default leaf', async () => {
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [agentStep('plan'), agentStep('review')],
    });
    const resumePoint = rootResumePoint('review', 'agent');
    let observedOptions: TreeOption[] = [];
    let observedDefault = '';

    const result = await selectTaskRetryStart(root, {
      ...pathContext,
      resumePoint,
    }, async (_message, options, defaultValue) => {
      observedOptions = asTreeOptions(options);
      observedDefault = defaultValue;
      return defaultValue;
    });

    const review = findLeaf(observedOptions, 'review');
    expect(observedDefault).toBe(review.value);
    expect(result).toEqual({
      label: review.label,
      selection: { kind: 'resume', resumePoint },
    });
  });

  it('should align a static parallel resume frame with its leaf', async () => {
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [parallelStep('reviewers'), agentStep('finish')],
    });
    const resumePoint = rootResumePoint('reviewers', 'parallel');
    let observedOptions: TreeOption[] = [];
    let observedDefault = '';

    const result = await selectTaskRetryStart(root, {
      ...pathContext,
      resumePoint,
    }, async (_message, options, defaultValue) => {
      observedOptions = asTreeOptions(options);
      observedDefault = defaultValue;
      return defaultValue;
    });

    const reviewers = findLeaf(observedOptions, 'reviewers');
    expect(observedDefault).toBe(reviewers.value);
    expect(result).toEqual({
      label: reviewers.label,
      selection: { kind: 'resume', resumePoint },
    });
  });

  it('should align a static parallel workflow-call descendant with its Resume leaf', async () => {
    const child = makeWorkflow({
      name: 'child',
      ref: 'project:child',
      callable: true,
      steps: [agentStep('review'), agentStep('finish')],
    });
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [parallelStep('reviewers', [callStep('delegate', 'child')]), agentStep('finish')],
    });
    const resumePoint = resumePointWithStack([
      {
        workflow: 'default',
        workflow_ref: 'project:root',
        step: 'reviewers',
        kind: 'parallel',
        occurrence: 1,
      },
      {
        workflow: 'default',
        workflow_ref: 'project:root',
        step: 'delegate',
        kind: 'workflow_call',
        occurrence: 1,
        call_instance: 1,
      },
      {
        workflow: 'child',
        workflow_ref: 'project:child',
        step: 'review',
        kind: 'agent',
        occurrence: 1,
      },
    ]);
    mockResolveWorkflowCallTarget.mockReturnValue(child);
    let observedOptions: TreeOption[] = [];
    let observedDefault = '';

    const result = await selectTaskRetryStart(root, {
      ...pathContext,
      resumePoint,
    }, async (_message, options, defaultValue) => {
      observedOptions = asTreeOptions(options);
      observedDefault = defaultValue;
      return defaultValue;
    });

    const review = findLeaf(observedOptions, 'review');
    expect(review.value).toBe('resume-checkpoint');
    expect(observedDefault).toBe(review.value);
    expect(result).toEqual({
      label: review.label,
      selection: { kind: 'resume', resumePoint },
    });
  });

  it('should not expose a static parallel descendant for a non-parallel Resume frame', async () => {
    const child = makeWorkflow({
      name: 'child',
      ref: 'project:child',
      callable: true,
      steps: [agentStep('review')],
    });
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [parallelStep('reviewers', [callStep('delegate', 'child')]), agentStep('finish')],
    });
    const resumePoint = resumePointWithStack([
      {
        workflow: 'default',
        workflow_ref: 'project:root',
        step: 'reviewers',
        kind: 'agent',
        occurrence: 1,
      },
      {
        workflow: 'default',
        workflow_ref: 'project:root',
        step: 'delegate',
        kind: 'workflow_call',
        occurrence: 1,
        call_instance: 1,
      },
      {
        workflow: 'child',
        workflow_ref: 'project:child',
        step: 'review',
        kind: 'agent',
        occurrence: 1,
      },
    ]);
    mockResolveWorkflowCallTarget.mockReturnValue(child);
    let observedOptions: TreeOption[] = [];
    let observedDefault = '';

    await selectTaskRetryStart(root, {
      ...pathContext,
      resumePoint,
    }, async (_message, options, defaultValue) => {
      observedOptions = asTreeOptions(options);
      observedDefault = defaultValue;
      return defaultValue;
    });

    expect(observedOptions.some((option) => option.label.trim() === 'review')).toBe(false);
    const reviewers = findLeaf(observedOptions, 'reviewers');
    expect(observedDefault).toBe(reviewers.value);
    expect(reviewers.value).not.toBe('resume-checkpoint');
  });

  it('should not treat an agent resume frame as a static parallel Resume', async () => {
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [parallelStep('reviewers'), agentStep('finish')],
    });
    let observedOptions: TreeOption[] = [];

    const result = await selectTaskRetryStart(root, {
      ...pathContext,
      resumePoint: rootResumePoint('reviewers', 'agent'),
    }, async (_message, options, defaultValue) => {
      observedOptions = asTreeOptions(options);
      return defaultValue;
    });

    expect(observedOptions.find((option) => option.label.trim() === 'reviewers')?.value)
      .not.toBe('resume-checkpoint');
    expect(result?.selection.kind).toBe('restart');
  });

  it('should align a terminal workflow call checkpoint with the child initial leaf', async () => {
    const grandchild = makeWorkflow({
      name: 'grandchild',
      ref: 'project:grandchild',
      callable: true,
      initialStep: 'review',
      steps: [agentStep('review'), agentStep('finish')],
    });
    const child = makeWorkflow({
      name: 'child',
      ref: 'project:child',
      callable: true,
      initialStep: 'delegate',
      steps: [callStep('delegate', 'grandchild'), agentStep('finish')],
    });
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [agentStep('plan'), callStep('delegate', 'child')],
    });
    const resumePoint = resumePointWithStack([{
      workflow: 'default',
      workflow_ref: 'project:root',
      step: 'delegate',
      kind: 'workflow_call',
      occurrence: 1,
      call_instance: 1,
    }]);
    mockResolveWorkflowCallTarget.mockImplementation(
      (_parent: WorkflowConfig, step: { call: string }) => (
        step.call === 'child' ? child : grandchild
      ),
    );
    let observedOptions: TreeOption[] = [];
    let observedDefault = '';

    const result = await selectTaskRetryStart(root, {
      ...pathContext,
      resumePoint,
    }, async (_message, options, defaultValue) => {
      observedOptions = asTreeOptions(options);
      observedDefault = defaultValue;
      return defaultValue;
    });

    const childInitial = findLeaf(observedOptions, 'review');
    expect(observedDefault).toBe(childInitial.value);
    expect(childInitial.leadingLines?.map((line) => line.trim())).toEqual([
      'default',
      'delegate',
      'child',
      'delegate',
      'grandchild',
    ]);
    expect(result).toEqual({
      label: childInitial.label,
      selection: { kind: 'resume', resumePoint },
    });
  });

  it('should not fall back to an unrelated first leaf for a terminal workflow call', async () => {
    const child = makeWorkflow({
      name: 'child',
      ref: 'project:child',
      callable: true,
      initialStep: 'review',
      steps: [agentStep('review')],
    });
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [agentStep('plan'), callStep('delegate', 'child')],
    });
    const resumePoint = resumePointWithStack([{
      workflow: 'default',
      workflow_ref: 'project:root',
      step: 'delegate',
      kind: 'workflow_call',
      occurrence: 1,
      call_instance: 1,
    }]);
    mockResolveWorkflowCallTarget.mockReturnValue(child);
    let observedOptions: TreeOption[] = [];
    let observedDefault = '';

    const result = await selectTaskRetryStart(root, {
      ...pathContext,
      resumePoint,
    }, async (_message, options, defaultValue) => {
      observedOptions = asTreeOptions(options);
      observedDefault = defaultValue;
      return defaultValue;
    });

    const firstLeaf = findLeaf(observedOptions, 'plan');
    const childInitial = findLeaf(observedOptions, 'review');
    expect(observedDefault).toBe(childInitial.value);
    expect(observedDefault).not.toBe(firstLeaf.value);
    expect(result?.selection.kind).toBe('resume');
  });

  it('should replace bounded windows while reaching a deep leaf without page actions', async () => {
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: Array.from({ length: 10_000 }, (_, index) => agentStep(`step-${index}`)),
    });
    let observedOptions: TreeOption[] = [];
    let promptCount = 0;

    const assertBoundedAndUnique = (options: SelectOptionItem<string>[]): void => {
      expect(options.length).toBeLessThanOrEqual(50);
      expect(new Set(options.map((option) => option.value)).size).toBe(options.length);
    };

    const result = await selectTaskRetryStart(root, pathContext, async (_message, options, _defaultValue, callbacks) => {
      promptCount += 1;
      observedOptions = asTreeOptions(options);
      assertBoundedAndUnique(options);
      let currentOptions = options;
      while (!currentOptions.some((option) => option.label.trim() === 'step-9999')) {
        const lastIndex = currentOptions.length - 1;
        const updatedOptions = callbacks?.onKeyPress?.(
          '\x1B[B',
          currentOptions[lastIndex]!.value,
          lastIndex,
        );
        if (updatedOptions === null || updatedOptions === undefined) {
          throw new Error('Expected the next retry start window');
        }
        currentOptions = updatedOptions;
        observedOptions = asTreeOptions(currentOptions);
        assertBoundedAndUnique(currentOptions);
      }
      return findLeaf(currentOptions, 'step-9999').value;
    });

    expect(promptCount).toBe(1);
    expect(observedOptions.length).toBeLessThanOrEqual(50);
    expect(result?.selection.kind).toBe('restart');
    expect(result?.selection.kind === 'restart'
      ? result.selection.restartPoint.stack.at(-1)?.step
      : undefined).toBe('step-9999');
  });

  it('should load the parent window after reaching the end of an expanded child', async () => {
    const child = makeWorkflow({
      name: 'child',
      ref: 'project:child',
      callable: true,
      steps: [agentStep('child-review')],
    });
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [
        ...Array.from({ length: 49 }, (_, index) => agentStep(`step-${index}`)),
        callStep('delegate', 'child'),
        ...Array.from({ length: 51 }, (_, index) => agentStep(`step-${index + 49}`)),
      ],
    });
    mockResolveWorkflowCallTarget.mockReturnValue(child);
    let promptCount = 0;
    let observedOptions: SelectOptionItem<string>[] = [];

    const result = await selectTaskRetryStart(root, pathContext, async (
      _message,
      options,
      _defaultValue,
      callbacks,
    ) => {
      promptCount += 1;
      observedOptions = options;
      if (promptCount === 1) {
        return options.find((option) => option.label.trim() === 'delegate')!.value;
      }
      const lastOption = options.at(-1)!;
      const updatedOptions = callbacks?.onKeyPress?.('\x1B[B', lastOption.value, options.length - 1);
      expect(updatedOptions).not.toBeNull();
      expect(updatedOptions?.some((option) => option.label.trim() === 'step-50')).toBe(true);
      return updatedOptions!.find((option) => option.label.trim() === 'step-50')!.value;
    });

    expect(promptCount).toBe(2);
    expect(observedOptions.some((option) => option.label.trim() === 'child-review')).toBe(true);
    expect(result?.selection.kind).toBe('restart');
    expect(result?.selection.kind === 'restart'
      ? result.selection.restartPoint.stack.at(-1)?.step
      : undefined).toBe('step-50');
  });

  it('should load the parent next window when a child ends before the parent window', async () => {
    const child = makeWorkflow({
      name: 'child',
      ref: 'project:child',
      callable: true,
      steps: [agentStep('child-review')],
    });
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [
        ...Array.from({ length: 20 }, (_, index) => agentStep(`step-${index}`)),
        callStep('delegate', 'child'),
        ...Array.from({ length: 79 }, (_, index) => agentStep(`step-${index + 21}`)),
      ],
    });
    mockResolveWorkflowCallTarget.mockReturnValue(child);
    let promptCount = 0;

    const result = await selectTaskRetryStart(root, pathContext, async (
      _message,
      options,
      _defaultValue,
      callbacks,
    ) => {
      promptCount += 1;
      if (promptCount === 1) {
        return options.find((option) => option.label.trim() === 'delegate')!.value;
      }

      const childReview = options.find((option) => option.label.trim() === 'child-review')!;
      const childReviewIndex = options.indexOf(childReview);
      const updatedOptions = callbacks?.onKeyPress?.(
        '\x1B[B',
        childReview.value,
        childReviewIndex,
      );
      expect(updatedOptions?.some((option) => option.label.trim() === 'step-50')).toBe(true);
      return updatedOptions!.find((option) => option.label.trim() === 'step-50')!.value;
    });

    expect(promptCount).toBe(2);
    expect(result?.selection.kind).toBe('restart');
    expect(result?.selection.kind === 'restart'
      ? result.selection.restartPoint.stack.at(-1)?.step
      : undefined).toBe('step-50');
  });

  it('should preserve the selected branch when leaf labels collide', async () => {
    const left = makeWorkflow({
      name: 'shared',
      ref: 'project:left',
      callable: true,
      steps: [agentStep('review')],
    });
    const right = makeWorkflow({
      name: 'shared',
      ref: 'project:right',
      callable: true,
      steps: [agentStep('review')],
    });
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [callStep('left', 'left'), callStep('right', 'right')],
    });
    mockResolveWorkflowCallTarget.mockImplementation(
      (_parent: WorkflowConfig, step: { call: string }) => ({ left, right }[step.call] ?? null),
    );

    let observedOptions: TreeOption[] = [];
    let promptCount = 0;
    const result = await selectTaskRetryStart(root, pathContext, async (_message, options) => {
      observedOptions = asTreeOptions(options);
      promptCount += 1;
      if (promptCount === 1) {
        return options.find((option) => option.label.trim() === 'right')!.value;
      }
      const reviews = options.filter((option) => option.label.trim() === 'review');
      expect(reviews).toHaveLength(2);
      expect(reviews[0]?.value).not.toBe(reviews[1]?.value);
      return reviews[1]!.value;
    });

    expect(result?.selection.kind).toBe('restart');
    expect(result?.selection.kind === 'restart'
      ? result.selection.restartPoint.stack.map((entry) => entry.workflow_ref)
      : undefined).toEqual(['project:root', 'project:right']);
    const reviewHeadings = observedOptions
      .filter((option) => option.label.trim() === 'review')
      .map((option) => option.leadingLines?.map((line) => line.trim()));
    expect(reviewHeadings).toEqual([
      ['default', 'left', 'shared'],
      ['default', 'right', 'shared'],
    ]);
  });

  it('should not finalize a workflow call when its child leaf has the same label', async () => {
    const child = makeWorkflow({
      name: 'child',
      ref: 'project:child',
      callable: true,
      steps: [agentStep('delegate')],
    });
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      initialStep: 'plan',
      steps: [agentStep('plan'), callStep('delegate', 'child'), agentStep('finish')],
    });
    mockResolveWorkflowCallTarget.mockReturnValue(child);
    let promptCount = 0;

    const result = await selectTaskRetryStart(root, pathContext, async (_message, options) => {
      promptCount += 1;
      const delegateOptions = options.filter((option) => option.label.trim() === 'delegate');
      if (promptCount === 1) {
        const navigation = delegateOptions.find((option) => (
          option.indent === (option.leadingLines?.length ?? 0) + 1
        ));
        expect(navigation).toBeDefined();
        return navigation!.value;
      }

      const leaf = delegateOptions.find((option) => (
        option.indent === (option.leadingLines?.length ?? 0)
      ));
      expect(leaf).toBeDefined();
      return leaf!.value;
    });

    expect(promptCount).toBe(2);
    expect(result?.selection.kind).toBe('restart');
    expect(result?.selection.kind === 'restart'
      ? result.selection.restartPoint.stack.map((entry) => entry.workflow_ref)
      : undefined).toEqual(['project:root', 'project:child']);
    expect(result?.selection.kind === 'restart'
      ? result.selection.restartPoint.stack.at(-1)?.step
      : undefined).toBe('delegate');
  });

  it('should keep a synthesized checkpoint available as Resume but not Restart', async () => {
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [synthesizedAgentStep('engine-step'), agentStep('finish')],
    });
    const resumePoint = rootResumePoint('engine-step', 'agent');
    let observedOptions: TreeOption[] = [];
    let observedDefault = '';

    const result = await selectTaskRetryStart(root, {
      ...pathContext,
      resumePoint,
    }, async (_message, options, defaultValue) => {
      observedOptions = asTreeOptions(options);
      observedDefault = defaultValue;
      return findLeaf(options, 'engine-step').value;
    });

    const checkpoint = findLeaf(observedOptions, 'engine-step');
    expect(observedDefault).toBe(checkpoint.value);
    expect(result).toEqual({
      label: checkpoint.label,
      selection: { kind: 'resume', resumePoint },
    });
  });

  it.each([
    {
      description: 'synthesized agent',
      step: synthesizedAgentStep('engine-step'),
      resumePoint: rootResumePoint('engine-step', 'agent'),
    },
    {
      description: 'effect-backed system',
      step: systemStep('publish', [{ type: 'merge_pr', pr: 42 }]),
      resumePoint: rootResumePoint('publish', 'system'),
    },
  ])('should offer a resume-only leaf for a $description checkpoint', async ({
    step,
    resumePoint,
  }) => {
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [step],
    });
    let observedOptions: TreeOption[] = [];

    const result = await selectTaskRetryStart(root, {
      ...pathContext,
      resumePoint,
    }, async (_message, options, defaultValue) => {
      observedOptions = asTreeOptions(options);
      expect(defaultValue).toBe(options[0]?.value);
      return defaultValue;
    });

    expect(observedOptions).toHaveLength(1);
    expect(result?.selection).toEqual({ kind: 'resume', resumePoint });
  });

  it('should return no selection when a resume-only prompt is cancelled', async () => {
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [synthesizedAgentStep('engine-step')],
    });

    const result = await selectTaskRetryStart(root, {
      ...pathContext,
      resumePoint: rootResumePoint('engine-step', 'agent'),
    }, async () => null);

    expect(result).toBeNull();
  });

  it('should reject a workflow with neither resume nor authored restart positions', async () => {
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [systemStep('publish', [{ type: 'merge_pr', pr: 42 }])],
    });

    await expect(selectTaskRetryStart(root, pathContext, async () => null)).rejects.toThrow();
  });

  it('should fail once when an expanded child has no selectable leaf', async () => {
    const child = makeWorkflow({
      name: 'child',
      ref: 'project:child',
      callable: true,
      steps: [systemStep('publish', [{ type: 'merge_pr', pr: 42 }])],
    });
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [callStep('delegate', 'child')],
    });
    mockResolveWorkflowCallTarget.mockReturnValue(child);
    let selectorCalls = 0;

    await expect(selectTaskRetryStart(root, pathContext, async (_message, options) => {
      selectorCalls += 1;
      return options.find((option) => option.label.trim() === 'delegate')!.value;
    })).rejects.toThrow();

    expect(selectorCalls).toBe(1);
  });

  it('should fail explicitly when an expanded child is unknown', async () => {
    const root = makeWorkflow({
      name: 'default', ref: 'project:root', steps: [callStep('route', 'missing')],
    });
    mockResolveWorkflowCallTarget.mockReturnValue(null);

    await expect(selectTaskRetryStart(root, pathContext, async (_message, options) => (
      options.find((option) => option.label.trim() === 'route')!.value
    )))
      .rejects.toThrow(/route.*missing/i);
  });

  it('should fail explicitly when an expanded child is not callable', async () => {
    const root = makeWorkflow({
      name: 'default', ref: 'project:root', steps: [callStep('route', 'child')],
    });
    mockResolveWorkflowCallTarget.mockReturnValue(makeWorkflow({
      name: 'child', ref: 'project:child', steps: [agentStep('finish')],
    }));

    await expect(selectTaskRetryStart(root, pathContext, async (_message, options) => (
      options.find((option) => option.label.trim() === 'route')!.value
    )))
      .rejects.toThrow(/child.*not callable/i);
  });

  it('should fail explicitly when the expanded tree contains a cycle', async () => {
    const root = makeWorkflow({
      name: 'default', ref: 'project:root', steps: [callStep('route', 'default')],
    });
    mockResolveWorkflowCallTarget.mockReturnValue(makeWorkflow({
      name: 'default', ref: 'project:root', callable: true, steps: [agentStep('finish')],
    }));

    await expect(selectTaskRetryStart(root, pathContext, async (_message, options) => (
      options.find((option) => option.label.trim() === 'route')!.value
    )))
      .rejects.toThrow(/cycle/i);
  });

  it('should fail explicitly when the expanded tree exceeds call depth', async () => {
    const workflows = Array.from({ length: MAX_WORKFLOW_CALL_DEPTH + 1 }, (_, index) => makeWorkflow({
      name: `workflow-${index}`,
      ref: `project:workflow-${index}`,
      callable: index > 0,
      steps: index === MAX_WORKFLOW_CALL_DEPTH
        ? [agentStep('finish')]
        : [callStep(`call-${index}`, `workflow-${index + 1}`)],
    }));
    mockResolveWorkflowCallTarget.mockImplementation(
      (_parent: WorkflowConfig, step: { call: string }) => (
        workflows.find((workflow) => workflow.name === step.call) ?? null
      ),
    );

    await expect(selectTaskRetryStart(workflows[0]!, pathContext, async (_message, options) => (
      options[0]!.value
    )))
      .rejects.toThrow(/depth exceeds/i);
  });

  it('should sanitize control characters in workflow step labels', async () => {
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [agentStep('line\n\x1b[31m'), agentStep('literal\\n')],
    });
    let observedOptions: TreeOption[] = [];

    const result = await selectTaskRetryStart(root, pathContext, async (_message, options) => {
      observedOptions = asTreeOptions(options);
      return options[0]!.value;
    });

    const labels = observedOptions.map((option) => option.label);
    expect(labels.every((label) => !/[\n\r\x1b]/.test(label))).toBe(true);
    expect(labels.some((label) => label.includes('\\n'))).toBe(true);
    expect(result?.label).not.toMatch(/[\n\r\x1b]/);
  });

  it('should sanitize control characters in nested workflow headings', async () => {
    const child = makeWorkflow({
      name: 'child\nname\r\x1b[31m',
      ref: 'project:child',
      callable: true,
      steps: [agentStep('review')],
    });
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [callStep('delegate', 'child')],
    });
    mockResolveWorkflowCallTarget.mockReturnValue(child);
    let observedOptions: TreeOption[] = [];

    const result = await selectTaskRetryStart(root, pathContext, async (_message, options) => {
      observedOptions = asTreeOptions(options);
      return findLeaf(options, 'review').value;
    });

    const headings = observedOptions.flatMap((option) => option.leadingLines ?? []);
    expect(headings.length).toBeGreaterThan(0);
    expect(headings.every((heading) => !/[\n\r\x1b]/.test(heading))).toBe(true);
    expect(result?.label).toBe('review');
  });
});

describe('persisted task retry restart validation', () => {
  it('should allow a selected authored step after root initial changes', () => {
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      initialStep: 'review',
      steps: [agentStep('plan'), agentStep('review')],
    });

    expect(() => validateTaskRetryRestartPoint(root, rootRestartPoint('plan'), pathContext))
      .not.toThrow();
  });

  it('should allow a selected non-initial step after an unrelated root initial change', () => {
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      initialStep: 'review',
      steps: [agentStep('plan'), agentStep('review'), agentStep('fix')],
    });

    expect(() => validateTaskRetryRestartPoint(root, rootRestartPoint('fix'), pathContext))
      .not.toThrow();
  });

  it('should reject a deleted selected root step', () => {
    const root = makeWorkflow({
      name: 'default', ref: 'project:root', steps: [agentStep('plan'), agentStep('review')],
    });

    expect(() => validateTaskRetryRestartPoint(root, rootRestartPoint('missing'), pathContext))
      .toThrow();
  });

  it('should reject a selected root step whose kind changed', () => {
    const root = makeWorkflow({
      name: 'default', ref: 'project:root', steps: [agentStep('plan'), systemStep('review')],
    });

    expect(() => validateTaskRetryRestartPoint(root, rootRestartPoint('review'), pathContext))
      .toThrow();
  });

  it('should reject a selected root step that became effect-backed', () => {
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [agentStep('plan'), systemStep('publish', [{ type: 'merge_pr', pr: 42 }])],
    });

    expect(() => validateTaskRetryRestartPoint(
      root,
      rootRestartPoint('publish', 'system'),
      pathContext,
    )).toThrow();
  });

  it('should reject a selected synthesized agent step', () => {
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [agentStep('plan'), synthesizedAgentStep('engine-step')],
    });

    expect(() => validateTaskRetryRestartPoint(root, rootRestartPoint('engine-step'), pathContext))
      .toThrow();
  });

  it('should reject a root workflow identity mismatch', () => {
    const root = makeWorkflow({
      name: 'default', ref: 'project:other-root', steps: [agentStep('plan')],
    });

    expect(() => validateTaskRetryRestartPoint(root, rootRestartPoint('plan'), pathContext))
      .toThrow();
  });

  it('should reject a restart path when a non-call middle step cannot lead to the terminal entry', () => {
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      steps: [agentStep('plan')],
    });
    const restartPoint: WorkflowRestartPoint = {
      stack: [
        { workflow: 'default', workflow_ref: 'project:root', step: 'plan', kind: 'agent' },
        { workflow: 'child', workflow_ref: 'project:child', step: 'finish', kind: 'agent' },
      ],
    };

    expect(() => validateTaskRetryRestartPoint(root, restartPoint, pathContext))
      .toThrow('Restart path cannot continue after non-call step "plan"');
  });

  it('should reject a nested restart path when the resolved child workflow is not callable', () => {
    const root = makeWorkflow({
      name: 'default', ref: 'project:root', steps: [callStep('delegate', 'coding')],
    });
    const child = makeWorkflow({
      name: 'coding', ref: 'project:child', steps: [agentStep('finish')],
    });
    const restartPoint: WorkflowRestartPoint = {
      stack: [
        {
          workflow: 'default',
          workflow_ref: 'project:root',
          step: 'delegate',
          kind: 'workflow_call',
          call_instance: 1,
        },
        { workflow: 'coding', workflow_ref: 'project:child', step: 'finish', kind: 'agent' },
      ],
    };
    mockResolveWorkflowCallTarget.mockReturnValue(child);

    expect(() => validateTaskRetryRestartPoint(root, restartPoint, pathContext))
      .toThrow('workflow "coding" referenced by step "delegate" is not callable');
  });

  it('should reject a nested restart path when the child workflow_ref no longer matches', () => {
    const root = makeWorkflow({
      name: 'default', ref: 'project:root', steps: [callStep('delegate', 'coding')],
    });
    const child = makeWorkflow({
      name: 'coding', ref: 'project:child', callable: true, steps: [agentStep('finish')],
    });
    const restartPoint: WorkflowRestartPoint = {
      stack: [
        {
          workflow: 'default',
          workflow_ref: 'project:root',
          step: 'delegate',
          kind: 'workflow_call',
          call_instance: 1,
        },
        { workflow: 'coding', workflow_ref: 'project:other-child', step: 'finish', kind: 'agent' },
      ],
    };
    mockResolveWorkflowCallTarget.mockReturnValue(child);

    expect(() => validateTaskRetryRestartPoint(root, restartPoint, pathContext))
      .toThrow('Task retry restart path cannot be resolved at step "finish"');
  });
});
