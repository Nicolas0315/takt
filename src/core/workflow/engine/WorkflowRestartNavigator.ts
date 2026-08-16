import type {
  WorkflowConfig,
  WorkflowRestartPoint,
  WorkflowRestartPointEntry,
  WorkflowResumePointEntry,
  WorkflowStep,
} from '../../models/types.js';
import { isDynamicParallelSubSteps } from '../../models/index.js';
import { getWorkflowStepKind, isWorkflowCallStep } from '../step-kind.js';
import {
  getWorkflowReference,
  workflowRestartEntryMatchesWorkflow,
  workflowRestartEntryMatchesRuntime,
} from '../workflow-reference.js';
import { isWorkflowRestartTarget } from '../workflow-restart-target.js';

export class WorkflowRestartNavigator {
  private active = true;
  private readonly staticParallelTargetCalls = new Map<number, WorkflowRestartPointEntry>();

  constructor(private readonly restartPoint: WorkflowRestartPoint) {}

  isActive(): boolean {
    return this.active;
  }

  resolveRootStartStep(
    rootWorkflow: WorkflowConfig,
    explicitStartStep: string | undefined,
  ): string {
    const rootEntry = this.restartPoint.stack[0]!;
    const targetStep = this.resolveEntryStep(rootEntry, rootWorkflow, 'root');
    if (explicitStartStep !== undefined && explicitStartStep !== targetStep.name) {
      throw new Error(
        `Workflow start step "${explicitStartStep}" does not match restart path step "${targetStep.name}"`,
      );
    }
    if (!isWorkflowCallStep(targetStep)) {
      const targetCall = this.findStaticParallelTargetCall(targetStep, 1);
      if (targetCall !== undefined) {
        this.staticParallelTargetCalls.set(0, targetCall);
      } else if (this.restartPoint.stack.length !== 1) {
        throw new Error(`Restart path cannot continue after non-call step "${rootEntry.step}"`);
      } else {
        this.active = false;
      }
    }
    return targetStep.name;
  }

  resolveChildStartStep(
    childWorkflow: WorkflowConfig,
    callStack: readonly WorkflowResumePointEntry[],
  ): string | undefined {
    if (!this.active) {
      return undefined;
    }
    if (this.isStaticParallelSiblingCall(callStack)) {
      return undefined;
    }
    this.assertCallStackMatches(callStack);

    const nextEntry = this.restartPoint.stack[callStack.length];
    if (nextEntry === undefined) {
      this.active = false;
      return undefined;
    }
    const targetStep = this.resolveEntryStep(nextEntry, childWorkflow, 'child');
    if (!isWorkflowCallStep(targetStep)) {
      const targetCall = this.findStaticParallelTargetCall(targetStep, callStack.length + 1);
      if (targetCall !== undefined) {
        this.staticParallelTargetCalls.set(callStack.length, targetCall);
      } else if (callStack.length + 1 !== this.restartPoint.stack.length) {
        throw new Error(`Restart path cannot continue after non-call step "${nextEntry.step}"`);
      } else {
        this.active = false;
      }
    }
    return targetStep.name;
  }

  private resolveEntryStep(
    entry: WorkflowRestartPointEntry,
    workflow: WorkflowConfig,
    relationship: 'root' | 'child',
  ): WorkflowStep {
    if (!workflowRestartEntryMatchesWorkflow(entry, workflow)) {
      throw new Error(
        `Restart path workflow "${entry.workflow}" (ref "${entry.workflow_ref}") does not match ${relationship} workflow "${workflow.name}" (ref "${getWorkflowReference(workflow)}")`,
      );
    }
    const targetStep = workflow.steps.find((step) => step.name === entry.step);
    if (targetStep === undefined || getWorkflowStepKind(targetStep) !== entry.kind) {
      throw new Error(
        `Restart path step "${entry.step}" does not match workflow "${workflow.name}"`,
      );
    }
    if (!isWorkflowRestartTarget(targetStep)) {
      throw new Error(
        `Restart path step "${entry.step}" is not eligible for an authored restart`,
      );
    }
    return targetStep;
  }

  private assertCallStackMatches(callStack: readonly WorkflowResumePointEntry[]): void {
    if (callStack.length > this.restartPoint.stack.length) {
      throw new Error('Runtime workflow_call stack exceeds the selected restart path');
    }
    for (let index = 0; index < callStack.length; index += 1) {
      const runtimeEntry = callStack[index]!;
      const selectedEntry = this.restartPoint.stack[index]!;
      const isStaticParallelParent = this.staticParallelTargetCalls.has(index);
      const kindMatches = runtimeEntry.kind === selectedEntry.kind
        || (isStaticParallelParent
          && selectedEntry.kind === 'agent'
          && runtimeEntry.kind === 'parallel');
      if (
        !workflowRestartEntryMatchesRuntime(runtimeEntry, selectedEntry)
        || runtimeEntry.step !== selectedEntry.step
        || !kindMatches
      ) {
        throw new Error(
          `Runtime workflow_call stack does not match restart path at "${selectedEntry.workflow} > ${selectedEntry.step}"`,
        );
      }
    }
  }

  private findStaticParallelTargetCall(
    parentStep: WorkflowStep,
    nextEntryIndex: number,
  ): WorkflowRestartPointEntry | undefined {
    const nextEntry = this.restartPoint.stack[nextEntryIndex];
    if (
      nextEntry === undefined
      || isWorkflowCallStep(parentStep)
      || parentStep.parallel === undefined
      || isDynamicParallelSubSteps(parentStep.parallel)
    ) {
      return undefined;
    }
    const subStep = parentStep.parallel.find((candidate) => (
      candidate.name === nextEntry.step
      && getWorkflowStepKind(candidate) === nextEntry.kind
    ));
    return subStep !== undefined && isWorkflowCallStep(subStep) ? nextEntry : undefined;
  }

  private isStaticParallelSiblingCall(
    callStack: readonly WorkflowResumePointEntry[],
  ): boolean {
    for (const [parentIndex, targetCall] of this.staticParallelTargetCalls) {
      const runtimeParent = callStack[parentIndex];
      const runtimeCall = callStack[parentIndex + 1];
      const selectedParent = this.restartPoint.stack[parentIndex];
      if (
        runtimeParent === undefined
        || runtimeCall === undefined
        || selectedParent === undefined
        || !workflowRestartEntryMatchesRuntime(runtimeParent, selectedParent)
        || runtimeParent.workflow_ref !== selectedParent.workflow_ref
        || runtimeParent.step !== selectedParent.step
        || runtimeParent.kind !== 'parallel'
        || selectedParent.kind !== 'agent'
      ) {
        continue;
      }
      if (
        runtimeCall.kind === 'workflow_call'
        && runtimeCall.workflow_ref === targetCall.workflow_ref
        && runtimeCall.step !== targetCall.step
      ) {
        return true;
      }
    }
    return false;
  }
}
