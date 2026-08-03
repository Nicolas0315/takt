import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowConfig, WorkflowResumePointEntry } from '../core/models/types.js';
import { buildWorkflowResumePointEntry } from '../core/workflow/workflow-reference.js';
import {
  WorkflowCallInvocationIndex,
  buildWorkflowCallInvocationIdentity,
  restoreWorkflowCallInvocationEvidence,
  serializeWorkflowCallInvocationEvidence,
} from '../core/workflow/workflow-call-invocation-index.js';
import {
  buildWorkflowCallNamespaceSegment,
  parseWorkflowCallNamespaceSegment,
  workflowCallReportRequestSegmentsMatch,
} from '../core/workflow/workflow-call-namespace.js';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import { ensureRunDirsExist } from '../core/workflow/engine/WorkflowEngineSetup.js';
import { MAX_WORKFLOW_CALL_DEPTH } from '../core/workflow/workflow-call-depth.js';

function makeWorkflow(name: string): WorkflowConfig {
  return {
    name,
    initialStep: 'delegate',
    maxSteps: 3,
    steps: [],
  };
}

function storageKey(
  workflow: string,
  step: string,
  ownerPath: readonly WorkflowResumePointEntry[],
  childWorkflow: string,
  callInstance: number | '*',
): string {
  return buildWorkflowCallNamespaceSegment(
    buildWorkflowCallInvocationIdentity(workflow, step, ownerPath),
    childWorkflow,
    callInstance,
  );
}

describe('WorkflowCallInvocationIndex', () => {
  it('should distinguish the same nested call step under different ancestor invocations', () => {
    const parent = makeWorkflow('parent');
    const child = makeWorkflow('child');
    const firstParentCall = buildWorkflowResumePointEntry(parent, 'delegate', 'workflow_call', undefined, 1);
    const secondParentCall = buildWorkflowResumePointEntry(parent, 'delegate', 'workflow_call', undefined, 2);
    const index = new WorkflowCallInvocationIndex(new Map());

    index.record(child, 'nested', [firstParentCall], {
      call_instance: 4,
      child_workflow_ref: 'grandchild',
    });
    index.record(child, 'nested', [secondParentCall], {
      call_instance: 7,
      child_workflow_ref: 'grandchild',
    });

    expect(index.get(child, 'nested', [firstParentCall])).toEqual({
      call_instance: 4,
      child_workflow_ref: 'grandchild',
    });
    expect(index.get(child, 'nested', [secondParentCall])).toEqual({
      call_instance: 7,
      child_workflow_ref: 'grandchild',
    });
    // Ancestor context is carried by the parent namespace directory, so the
    // local segment only names the call step, child workflow, and instance.
    expect(storageKey('child', 'nested', [firstParentCall], 'grandchild', 4))
      .toBe('call-4--step-nested--workflow-grandchild');
    expect(storageKey('child', 'nested', [secondParentCall], 'grandchild', 4))
      .toBe('call-4--step-nested--workflow-grandchild');
  });

  it('should distinguish the same call step owned by different parallel parents', () => {
    const parent = makeWorkflow('parent');
    const firstOwner = buildWorkflowResumePointEntry(parent, 'fanout_a', 'agent');
    const secondOwner = buildWorkflowResumePointEntry(parent, 'fanout_b', 'agent');
    const index = new WorkflowCallInvocationIndex(new Map());

    index.record(parent, 'delegate', [firstOwner], {
      call_instance: 1,
      child_workflow_ref: 'child',
    });
    index.record(parent, 'delegate', [secondOwner], {
      call_instance: 1,
      child_workflow_ref: 'child',
    });

    expect(index.get(parent, 'delegate', [firstOwner])?.child_workflow_ref).toBe('child');
    expect(index.get(parent, 'delegate', [secondOwner])?.child_workflow_ref).toBe('child');
    expect(storageKey('parent', 'delegate', [firstOwner], 'child', 1))
      .toBe('call-1--step-fanout_a!delegate--workflow-child');
    expect(storageKey('parent', 'delegate', [secondOwner], 'child', 1))
      .toBe('call-1--step-fanout_b!delegate--workflow-child');
  });

  it('should reject a persisted invocation that disagrees with the resume stack', () => {
    const parent = makeWorkflow('parent');
    const identity = buildWorkflowCallInvocationIdentity('parent', 'delegate', []);
    const invocation = { call_instance: 1, child_workflow_ref: 'child' };
    const index = new WorkflowCallInvocationIndex(new Map([[identity, invocation]]));

    expect(() => index.validateResumePoint({
      version: 2,
      stack: [buildWorkflowResumePointEntry(
        parent,
        'delegate',
        'workflow_call',
        new Map([['delegate', 2]]),
        2,
      )],
      iteration: 2,
      elapsed_ms: 0,
      workflow_call_invocations: { [identity]: invocation },
      workflow_step_participations: {},
    })).toThrow('Workflow-call invocation identity does not match resume entry "delegate"');
  });

  it('should reject a persisted child reference that disagrees with the resume stack', () => {
    const parent = makeWorkflow('parent');
    const identity = buildWorkflowCallInvocationIdentity('parent', 'delegate', []);
    const invocation = { call_instance: 1, child_workflow_ref: 'other-child' };
    const index = new WorkflowCallInvocationIndex(new Map([[identity, invocation]]));

    expect(() => index.validateResumePoint({
      version: 2,
      stack: [
        buildWorkflowResumePointEntry(parent, 'delegate', 'workflow_call', undefined, 1),
        { workflow: 'child', step: 'review', kind: 'agent' },
      ],
      iteration: 2,
      elapsed_ms: 0,
      workflow_call_invocations: { [identity]: invocation },
      workflow_step_participations: {},
    })).toThrow('Workflow-call child reference does not match resume entry "delegate"');
  });

  it('should reject a workflow-call step iteration that disagrees with its call instance', () => {
    const parent = makeWorkflow('parent');
    const identity = buildWorkflowCallInvocationIdentity('parent', 'delegate', []);
    const invocation = { call_instance: 2, child_workflow_ref: 'child' };
    const index = new WorkflowCallInvocationIndex(new Map([[identity, invocation]]));

    expect(() => index.validateResumePoint({
      version: 2,
      stack: [buildWorkflowResumePointEntry(
        parent,
        'delegate',
        'workflow_call',
        new Map([['delegate', 3]]),
        2,
      )],
      iteration: 2,
      elapsed_ms: 0,
      workflow_call_invocations: { [identity]: invocation },
      workflow_step_participations: {},
    })).toThrow('Workflow-call step iteration does not match resume entry "delegate"');
  });

  it('should serialize a defensive logical record snapshot per canonical path', () => {
    const workflow = makeWorkflow('parent');
    const index = new WorkflowCallInvocationIndex(new Map());
    index.record(workflow, 'delegate', [], { call_instance: 1, child_workflow_ref: 'child' });
    index.record(workflow, 'delegate', [], { call_instance: 2, child_workflow_ref: 'child' });

    const serialized = index.serialized();

    expect(serialized).toEqual({
      [buildWorkflowCallInvocationIdentity('parent', 'delegate', [])]: {
        call_instance: 2,
        child_workflow_ref: 'child',
      },
    });
    serialized[buildWorkflowCallInvocationIdentity('parent', 'delegate', [])]!.call_instance = 9;
    expect(index.get(workflow, 'delegate', [])).toEqual({
      call_instance: 2,
      child_workflow_ref: 'child',
    });
  });

  it('should preserve an explicit empty exact index when serializing current evidence', () => {
    const evidence = restoreWorkflowCallInvocationEvidence({
      version: 2,
      stack: [{ workflow: 'parent', step: 'prepare', kind: 'agent' }],
      iteration: 0,
      elapsed_ms: 0,
      workflow_call_invocations: {},
      workflow_step_participations: {},
    });

    expect(evidence.kind).toBe('exact');
    expect(serializeWorkflowCallInvocationEvidence(evidence)).toEqual({});
  });

  it('should reject an empty persisted child workflow reference', () => {
    const identity = buildWorkflowCallInvocationIdentity('parent', 'delegate', []);

    expect(() => new WorkflowCallInvocationIndex(new Map([[identity, {
      call_instance: 1,
      child_workflow_ref: '',
    }]]))).toThrow('requires a child workflow reference');
  });

  it.each([
    '{"workflow":"parent","step":"delegate","owners":[],"extra":true}',
    '{"step":"delegate","workflow":"parent","owners":[]}',
    '{ "workflow":"parent","step":"delegate","owners":[]}',
  ])('should reject a non-canonical persisted invocation identity', (identity) => {
    expect(() => new WorkflowCallInvocationIndex(new Map([[identity, {
      call_instance: 1,
      child_workflow_ref: 'child',
    }]]))).toThrow('Invalid workflow-call invocation identity');
  });

  it.each([
    '{"workflow":"child","step":"nested","owners":[{"workflow":"parent","step":"delegate","kind":"agent","instance":1}]}',
    '{"workflow":"child","step":"nested","owners":[{"workflow":"parent","step":"delegate","kind":"workflow_call","instance":0}]}',
    '{"workflow":"child","step":"nested","owners":[{"workflow":"parent","step":"delegate","kind":"workflow_call","instance":1,"extra":true}]}',
  ])('should reject a non-canonical nested invocation identity', (identity) => {
    expect(() => new WorkflowCallInvocationIndex(new Map([[identity, {
      call_instance: 1,
      child_workflow_ref: 'grandchild',
    }]]))).toThrow('Invalid workflow-call invocation identity');
  });

  it.each([
    ['review', 'peer-review', 2, 'call-2--step-review--workflow-peer-review'],
    ['Review', 'child', 1, 'call-1--step-~review--workflow-child'],
    ['a~b', 'child', 1, 'call-1--step-a~~b--workflow-child'],
    ['a!b', 'child', 1, 'call-1--step-a%21b--workflow-child'],
    ['a/b', 'child', 1, 'call-1--step-a%2Fb--workflow-child'],
    ['a--b', 'child', 1, 'call-1--step-a%2D-b--workflow-child'],
    ['-a', 'child', 1, 'call-1--step-%2Da--workflow-child'],
  ] as const)('should encode step %s calling %s canonically', (step, child, instance, expected) => {
    const segment = storageKey('parent', step, [], child, instance);

    expect(segment).toBe(expected);
    expect(parseWorkflowCallNamespaceSegment(segment)?.callInstance).toBe(instance);
  });

  it('should keep structural delimiters out of encoded values', () => {
    const embeddedInChild = storageKey('parent', 'review', [], 'child--workflow-v2', 1);
    const embeddedInStep = storageKey('parent', 'review--workflow-child', [], 'v2', 1);

    expect(embeddedInChild).toBe('call-1--step-review--workflow-child%2D-workflow-v2');
    expect(embeddedInStep).toBe('call-1--step-review%2D-workflow-child--workflow-v2');
    expect(workflowCallReportRequestSegmentsMatch(
      embeddedInChild,
      storageKey('parent', 'review--workflow-child', [], 'v2', '*'),
    )).toBe(false);
    const leadingDashChild = storageKey('parent', 'a', [], '-workflow-z', 1);
    expect(leadingDashChild).toBe('call-1--step-a--workflow-%2Dworkflow-z');
    expect(parseWorkflowCallNamespaceSegment(leadingDashChild)?.childWorkflow).toBe('%2Dworkflow-z');
  });

  it('should distinguish local step, child, and case differences within one scope', () => {
    const agentOwner = [{ workflow: 'parent', step: 'owner', kind: 'agent' as const }];
    const baseline = storageKey('parent', 'delegate', agentOwner, 'child', 1);
    const variants = [
      storageKey('parent', 'Delegate', agentOwner, 'child', 1),
      storageKey('parent', 'delegate', [{ ...agentOwner[0]!, step: 'Owner' }], 'child', 1),
      storageKey('parent', 'delegate', agentOwner, 'Child', 1),
      storageKey('parent', 'delegate', agentOwner, 'child', 2),
    ];

    expect(new Set([baseline, ...variants]).size).toBe(variants.length + 1);
    // Ancestor-only differences (containing workflow, owner kind) do not change
    // the local segment: they live in the parent namespace directory.
    expect(storageKey('Parent', 'delegate', agentOwner, 'child', 1)).toBe(baseline);
    expect(storageKey('parent', 'delegate', [{ workflow: 'parent', step: 'owner', kind: 'system' as const }], 'child', 1))
      .toBe(baseline);
  });

  it('should create separate real run directories for long case-only identities', () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'takt-call-storage-'));
    const longWorkflow = 'w'.repeat(200);
    const first = storageKey(longWorkflow, 'Delegate', [], 'c'.repeat(200), 1);
    const second = storageKey(longWorkflow, 'delegate', [], 'c'.repeat(200), 1);

    try {
      const firstPaths = buildRunPaths(temporaryDirectory, 'run', ['subworkflows', first]);
      const secondPaths = buildRunPaths(temporaryDirectory, 'run', ['subworkflows', second]);
      ensureRunDirsExist(firstPaths);
      ensureRunDirsExist(secondPaths);

      expect(realpathSync(firstPaths.reportsAbs)).not.toBe(realpathSync(secondPaths.reportsAbs));
      expect(readdirSync(join(temporaryDirectory, '.takt', 'runs', 'run', 'reports', 'subworkflows')).sort())
        .toEqual([first, second].sort());
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('should create the production run path at maximum workflow call depth', () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'takt-call-depth-'));
    const namespace = Array.from({ length: MAX_WORKFLOW_CALL_DEPTH }, (_, index) => [
      'subworkflows',
      storageKey(
        `workflow-${index}-${'w'.repeat(60)}`,
        `delegate-${index}-${'s'.repeat(60)}`,
        [],
        `child-${index}-${'c'.repeat(60)}`,
        1,
      ),
    ]).flat();

    try {
      const paths = buildRunPaths(temporaryDirectory, 'run', namespace);
      ensureRunDirsExist(paths);

      expect(realpathSync(paths.reportsAbs)).not.toHaveLength(0);
      expect(realpathSync(paths.contextAbs)).not.toHaveLength(0);
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('should distinguish delimiter-equivalent flat and structured call paths', () => {
    const firstOwner = [{ workflow: 'parent', step: 'a', kind: 'agent' as const }];
    const secondOwner = [{ workflow: 'parent', step: 'a/b', kind: 'agent' as const }];

    expect(storageKey('parent', 'b/c', firstOwner, 'child', 1))
      .not.toBe(storageKey('parent', 'c', secondOwner, 'child', 1));
  });

  it('should let a wildcard ignore only the current call instance', () => {
    const exact = storageKey('parent', 'delegate', [], 'child', 2);
    const wildcard = storageKey('parent', 'delegate', [], 'child', '*');

    expect(workflowCallReportRequestSegmentsMatch(exact, wildcard)).toBe(true);
    expect(workflowCallReportRequestSegmentsMatch(
      storageKey('parent', 'other-step', [], 'child', 2),
      wildcard,
    )).toBe(false);
    expect(workflowCallReportRequestSegmentsMatch(
      storageKey('parent', 'delegate', [], 'other-child', 2),
      wildcard,
    )).toBe(false);
  });

  it('should reject malformed or non-canonical namespace segments', () => {
    const canonical = storageKey('parent', 'delegate', [], 'child', 1);

    expect(parseWorkflowCallNamespaceSegment(canonical.toUpperCase())).toBeUndefined();
    expect(parseWorkflowCallNamespaceSegment('call-1--step-Delegate--workflow-child')).toBeUndefined();
    expect(parseWorkflowCallNamespaceSegment('call-0--step-delegate--workflow-child')).toBeUndefined();
    expect(parseWorkflowCallNamespaceSegment('call-1--step-%2f--workflow-child')).toBeUndefined();
    expect(parseWorkflowCallNamespaceSegment('call-1--step-a!!b--workflow-child')).toBeUndefined();
    expect(parseWorkflowCallNamespaceSegment('call-1--step-~--workflow-child')).toBeUndefined();
    expect(parseWorkflowCallNamespaceSegment('call-1--step-a--b--workflow-child')).toBeUndefined();
    expect(parseWorkflowCallNamespaceSegment('call-1--step-delegate--workflow-')).toBeUndefined();
  });

  it('should not match a wildcard request whose step scope was modified', () => {
    const exact = storageKey('parent', 'delegate', [], 'child', 1);
    const wildcard = storageKey('parent', 'delegate', [], 'child', '*');
    const modifiedWildcard = wildcard.replace('--step-delegate--', '--step-delegatx--');

    expect(parseWorkflowCallNamespaceSegment(modifiedWildcard)).toBeDefined();
    expect(workflowCallReportRequestSegmentsMatch(exact, modifiedWildcard)).toBe(false);
  });
});
