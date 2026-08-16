import {
  isDynamicParallelSubSteps,
  type WorkflowConfig,
  type WorkflowRestartPoint,
  type WorkflowRestartPointEntry,
  type WorkflowResumePointEntry,
  type WorkflowStep,
} from '../../core/models/index.js';
import { WorkflowRestartNavigator } from '../../core/workflow/engine/WorkflowRestartNavigator.js';
import {
  getWorkflowResumeFrameKind,
  getWorkflowStepKind,
  isWorkflowCallStep,
} from '../../core/workflow/step-kind.js';
import { MAX_WORKFLOW_CALL_DEPTH } from '../../core/workflow/workflow-call-depth.js';
import { isWorkflowRestartTarget } from '../../core/workflow/workflow-restart-target.js';
import {
  buildWorkflowRestartPointEntry,
  getWorkflowReference,
  workflowEntryMatchesWorkflow,
  workflowRestartEntryMatchesWorkflow,
} from '../../core/workflow/workflow-reference.js';
import { resolveWorkflowCallTarget } from '../../infra/config/index.js';

export interface TaskRetryStartPathContext {
  projectCwd: string;
  lookupCwd: string;
}

export interface ResolvedTaskRetryPath {
  restartPoint: WorkflowRestartPoint;
}

export const TASK_RETRY_START_WINDOW_SIZE = 50;

export type TaskRetryRestartTreeNode =
  | TaskRetryRestartTreeLeaf
  | TaskRetryRestartTreeNavigation;

export interface TaskRetryRestartTreeLeaf {
  kind: 'leaf';
  value: string;
  step: WorkflowStep;
  restartPoint: WorkflowRestartPoint;
  workflowPath: readonly string[];
  isRestartable: boolean;
  isDefaultCandidate: boolean;
  isResumeCandidate: boolean;
  frame: TaskRetryRestartTreeFrameState;
}

export interface TaskRetryRestartTreeNavigation {
  kind: 'navigation';
  value: string;
  step: Extract<WorkflowStep, { kind: 'workflow_call' }>;
  restartPoint: WorkflowRestartPoint;
  workflowPath: readonly string[];
  expanded: boolean;
  frame: TaskRetryRestartTreeFrameState;
  key: string;
  parentStepIndex: number;
  parallelStepName?: string;
  parallelStepIndex?: number;
}

export interface TaskRetryRestartTreeFrame {
  readonly workflow: WorkflowConfig;
  readonly stack: readonly WorkflowRestartPointEntry[];
  readonly workflowPath: readonly string[];
  readonly ancestors: readonly string[];
}

interface ResolveTaskRetryStackOptions {
  allowParallelEntries: boolean;
  requireRestartTarget: boolean;
  requireRestartIdentity: boolean;
}

interface TaskRetryStartWindow {
  start: number;
  end: number;
}

interface TaskRetryStaticParallelVisibleWindow extends TaskRetryStartWindow {
  readonly visibleSubStepIndices: readonly number[];
}

interface TaskRetryRestartTreeFrameProjection {
  readonly budget: number;
  readonly nodes: readonly TaskRetryRestartTreeNode[];
}

interface TaskRetryRestartTreeProjectionSnapshot {
  readonly nodes: TaskRetryRestartTreeNode[];
  readonly frames: ReadonlyMap<
    TaskRetryRestartTreeFrameState,
    TaskRetryRestartTreeFrameProjection
  >;
}

interface TaskRetryRestartTreeTargetBranch {
  stepIndex: number;
  parallelStepIndex?: number;
}

function resolveCallableChild(
  parent: WorkflowConfig,
  step: Extract<WorkflowStep, { kind: 'workflow_call' }>,
  context: TaskRetryStartPathContext,
): WorkflowConfig {
  const child = resolveWorkflowCallTarget(
    parent,
    step,
    context.projectCwd,
    context.lookupCwd,
  );
  if (child === null) {
    throw new Error(
      `workflow_call step "${step.name}" in workflow "${parent.name}" references unknown workflow "${step.call}"`,
    );
  }
  if (child.subworkflow?.callable !== true) {
    throw new Error(`workflow "${child.name}" referenced by step "${step.name}" is not callable`);
  }
  return child;
}

function assertCallableChildBoundary(
  child: WorkflowConfig,
  ancestors: readonly string[],
): void {
  const childRef = getWorkflowReference(child);
  if (ancestors.includes(childRef)) {
    throw new Error(`Detected workflow_call cycle: ${[...ancestors, childRef].join(' -> ')}`);
  }
  if (ancestors.length + 1 > MAX_WORKFLOW_CALL_DEPTH) {
    throw new Error(
      `workflow_call depth exceeds limit (${MAX_WORKFLOW_CALL_DEPTH}): ${child.name}`,
    );
  }
}

function createRestartEntry(
  workflow: WorkflowConfig,
  step: WorkflowStep,
): WorkflowRestartPointEntry {
  return buildWorkflowRestartPointEntry(
    workflow,
    step.name,
    getWorkflowStepKind(step),
    isWorkflowCallStep(step) ? 1 : undefined,
  );
}

function sameRestartPoint(
  left: WorkflowRestartPoint | undefined,
  right: WorkflowRestartPoint | undefined,
): boolean {
  if (left === undefined || right === undefined || left.stack.length !== right.stack.length) {
    return false;
  }
  return left.stack.every((leftEntry, index) => {
    const rightEntry = right.stack[index];
    return rightEntry !== undefined
      && leftEntry.workflow_ref === rightEntry.workflow_ref
      && leftEntry.step === rightEntry.step
      && leftEntry.kind === rightEntry.kind
      && leftEntry.call_instance === rightEntry.call_instance;
  });
}

function findFirstAuthoredRestartPoint(
  workflow: WorkflowConfig,
  stack: readonly WorkflowRestartPointEntry[],
): WorkflowRestartPoint | undefined {
  for (const step of workflow.steps) {
    if (!isWorkflowCallStep(step) && isWorkflowRestartTarget(step)) {
      return { stack: [...stack, createRestartEntry(workflow, step)] };
    }
  }
  return undefined;
}

function resolvePreferredRestartPoint(
  rootWorkflow: WorkflowConfig,
  context: TaskRetryStartPathContext,
  preferredRootStep: string,
): WorkflowRestartPoint | undefined {
  const rootStepIndex = rootWorkflow.steps.findIndex((step) => step.name === preferredRootStep);
  if (rootStepIndex < 0) {
    return findFirstAuthoredRestartPoint(rootWorkflow, []);
  }

  const findFrom = (
    workflow: WorkflowConfig,
    stack: readonly WorkflowRestartPointEntry[],
    ancestors: readonly string[],
    startIndex: number,
  ): WorkflowRestartPoint | undefined => {
    for (let index = startIndex; index < workflow.steps.length; index += 1) {
      const step = workflow.steps[index]!;
      const nextStack = [...stack, createRestartEntry(workflow, step)];
      if (isWorkflowCallStep(step)) {
        const child = resolveCallableChild(workflow, step, context);
        assertCallableChildBoundary(child, ancestors);
        return findFrom(
          child,
          nextStack,
          [...ancestors, getWorkflowReference(child)],
          child.steps.findIndex((candidate) => candidate.name === child.initialStep),
        );
      }
      if (isWorkflowRestartTarget(step)) {
        return { stack: nextStack };
      }
    }
    return undefined;
  };

  return findFrom(
    rootWorkflow,
    [],
    [getWorkflowReference(rootWorkflow)],
    rootStepIndex,
  ) ?? findFirstAuthoredRestartPoint(rootWorkflow, []);
}

interface TaskRetryRestartTreeFrameState extends TaskRetryRestartTreeFrame {
  readonly parent?: TaskRetryRestartTreeFrameState;
  readonly parentStepIndex?: number;
  readonly parentParallelStepIndex?: number;
  activeStepWindow: TaskRetryStartWindow | undefined;
  readonly activeParallelWindows: Map<number, TaskRetryStaticParallelVisibleWindow>;
  readonly expandedCallKeys: Set<string>;
  readonly childFrames: Map<string, TaskRetryRestartTreeFrameState>;
  readonly nodeIds: Map<string, string>;
}

export interface TaskRetryRestartTreeOptions {
  defaultRestartPoint?: WorkflowRestartPoint;
  resumeRestartPoint?: WorkflowRestartPoint;
}

function matchesFrameStack(
  frameStack: readonly WorkflowRestartPointEntry[],
  targetStack: readonly WorkflowRestartPointEntry[],
): boolean {
  return frameStack.every((entry, index) => {
    const targetEntry = targetStack[index];
    return targetEntry !== undefined
      && entry.workflow_ref === targetEntry.workflow_ref
      && entry.step === targetEntry.step
      && entry.kind === targetEntry.kind
      && entry.call_instance === targetEntry.call_instance;
  });
}

export class TaskRetryRestartTree {
  private readonly rootFrame: TaskRetryRestartTreeFrameState;
  private readonly context: TaskRetryStartPathContext;
  private readonly defaultRestartPoint: WorkflowRestartPoint | undefined;
  private readonly resumeRestartPoint: WorkflowRestartPoint | undefined;
  private projectionSnapshot: TaskRetryRestartTreeProjectionSnapshot | undefined;
  private nextNodeId = 0;

  constructor(
    rootWorkflow: WorkflowConfig,
    context: TaskRetryStartPathContext,
    preferredRootStep: string | undefined,
    options: TaskRetryRestartTreeOptions,
  ) {
    this.context = context;
    this.defaultRestartPoint = options.defaultRestartPoint
      ?? resolvePreferredRestartPoint(rootWorkflow, context, preferredRootStep ?? rootWorkflow.initialStep);
    this.resumeRestartPoint = options.resumeRestartPoint;
    this.rootFrame = this.createFrame(
      rootWorkflow,
      [],
      [rootWorkflow.name],
      [getWorkflowReference(rootWorkflow)],
    );
    this.loadInitialWindow(this.rootFrame);
    if (this.resumeRestartPoint !== undefined) {
      this.ensureRestartPointVisible(this.resumeRestartPoint);
    } else if (this.defaultRestartPoint !== undefined) {
      this.ensureRestartPointVisible(this.defaultRestartPoint);
    }
  }

  getRootWorkflow(): WorkflowConfig {
    return this.rootFrame.workflow;
  }

  getVisibleNodes(): TaskRetryRestartTreeNode[] {
    return this.getProjectionSnapshot().nodes;
  }

  getDefaultValue(): string | undefined {
    const nodes = this.getVisibleNodes();
    const resume = nodes.find((node) => node.kind === 'leaf' && node.isResumeCandidate);
    if (resume !== undefined) return resume.value;
    const preferred = nodes.find((node) => (
      node.kind === 'leaf'
      && (node.isRestartable || node.isResumeCandidate)
      && node.isDefaultCandidate
    ));
    if (preferred !== undefined) return preferred.value;
    const leaf = nodes.find((node) => (
      node.kind === 'leaf'
      && (node.isRestartable || node.isResumeCandidate)
    ));
    if (leaf !== undefined) return leaf.value;
    return nodes.find((node) => node.kind === 'navigation' && !node.expanded)?.value;
  }

  findNode(value: string): TaskRetryRestartTreeNode | undefined {
    return this.getVisibleNodes().find((node) => node.value === value);
  }

  handleKeyPress(
    value: string,
    key: string,
  ): boolean {
    const projection = this.getProjectionSnapshot();
    const node = projection.nodes.find((candidate) => candidate.value === value);
    if (node === undefined) return false;
    if (node.kind === 'navigation' && (key === '\r' || key === '\n')) {
      this.toggleNavigation(node);
      return true;
    }
    if (this.isDownKey(key) && node.kind === 'leaf' && this.isStaticParallelCallStep(node.step)) {
      const stepIndex = node.frame.workflow.steps.indexOf(node.step);
      if (stepIndex >= 0 && this.loadParallelWindow(node.frame, stepIndex, 0)) {
        return true;
      }
    }
    if (this.isUpKey(key) && this.isFrameBoundary(projection, node, 'up')) {
      const changed = this.loadAdjacentWindow(projection, node, 'up');
      return changed;
    }
    if (this.isDownKey(key) && this.isFrameBoundary(projection, node, 'down')) {
      const changed = this.loadAdjacentWindow(projection, node, 'down');
      return changed;
    }
    return false;
  }

  private isFrameBoundary(
    projection: TaskRetryRestartTreeProjectionSnapshot,
    node: TaskRetryRestartTreeNode,
    direction: 'up' | 'down',
  ): boolean {
    const frameProjection = projection.frames.get(node.frame);
    if (frameProjection === undefined) return false;
    const nodeIndex = frameProjection.nodes.findIndex((candidate) => candidate.value === node.value);
    if (nodeIndex < 0) return false;
    return direction === 'up'
      ? nodeIndex === 0
      : nodeIndex === frameProjection.nodes.length - 1;
  }

  isNavigation(value: string): boolean {
    return this.findNode(value)?.kind === 'navigation';
  }

  toggleNavigation(node: TaskRetryRestartTreeNavigation): void {
    if (node.expanded) {
      node.frame.expandedCallKeys.delete(node.key);
      node.frame.childFrames.delete(node.key);
      this.projectionSnapshot = undefined;
      return;
    }

    const child = this.resolveChildFrame(node);
    node.frame.childFrames.set(node.key, child);
    node.frame.expandedCallKeys.add(node.key);
    this.projectionSnapshot = undefined;
  }

  private createFrame(
    workflow: WorkflowConfig,
    stack: readonly WorkflowRestartPointEntry[],
    workflowPath: readonly string[],
    ancestors: readonly string[],
    parent?: TaskRetryRestartTreeFrameState,
    parentStepIndex?: number,
    parentParallelStepIndex?: number,
  ): TaskRetryRestartTreeFrameState {
    return {
      workflow,
      stack: [...stack],
      workflowPath: [...workflowPath],
      ancestors: [...ancestors],
      ...(parent === undefined ? {} : { parent }),
      ...(parentStepIndex === undefined ? {} : { parentStepIndex }),
      ...(parentParallelStepIndex === undefined ? {} : { parentParallelStepIndex }),
      activeStepWindow: undefined,
      activeParallelWindows: new Map<number, TaskRetryStaticParallelVisibleWindow>(),
      expandedCallKeys: new Set<string>(),
      childFrames: new Map<string, TaskRetryRestartTreeFrameState>(),
      nodeIds: new Map<string, string>(),
    };
  }

  private loadInitialWindow(frame: TaskRetryRestartTreeFrameState): void {
    const target = this.resumeRestartPoint ?? this.defaultRestartPoint;
    const targetIndex = this.findTargetStepIndex(frame, target);
    const firstVisibleIndex = targetIndex ?? this.findFirstVisibleStepIndex(frame.workflow);
    if (firstVisibleIndex === undefined) return;
    const parallelParentStepIndex = targetIndex === undefined
      ? undefined
      : this.findTargetStaticParallelCallIndex(
        frame,
        target,
        0,
        frame.workflow.steps.length,
      );
    if (parallelParentStepIndex === undefined) {
      const nestedContentCount = target === undefined || targetIndex === undefined
        ? 0
        : Math.max(0, target.stack.length - frame.stack.length - 1);
      const windowSize = Math.max(
        1,
        TASK_RETRY_START_WINDOW_SIZE - nestedContentCount,
      );
      const windowStart = targetIndex === undefined
        ? Math.floor(firstVisibleIndex / TASK_RETRY_START_WINDOW_SIZE)
          * TASK_RETRY_START_WINDOW_SIZE
        : Math.max(0, firstVisibleIndex - windowSize + 1);
      this.loadWindow(frame, windowStart, windowSize);
      return;
    }

    const nestedContentCount = target === undefined
      ? 0
      : Math.max(0, target.stack.length - frame.stack.length - 2);
    const topLevelSize = Math.max(
      1,
      TASK_RETRY_START_WINDOW_SIZE - 1 - nestedContentCount,
    );
    const windowStart = Math.max(0, parallelParentStepIndex - topLevelSize + 1);
    const targetParallelIndex = this.findTargetParallelStepIndex(
      frame,
      target,
      parallelParentStepIndex,
    );
    if (targetParallelIndex === undefined) {
      this.loadWindow(frame, windowStart, topLevelSize);
      return;
    }
    this.loadWindow(frame, windowStart, topLevelSize);
    const targetVisibleOffset = this.findStaticParallelVisibleOffset(
      frame,
      parallelParentStepIndex,
      targetParallelIndex,
    );
    if (targetVisibleOffset === undefined) return;
    this.loadParallelWindow(
      frame,
      parallelParentStepIndex,
      targetVisibleOffset,
      Math.max(1, TASK_RETRY_START_WINDOW_SIZE - topLevelSize - nestedContentCount),
    );
  }

  private loadWindow(
    frame: TaskRetryRestartTreeFrameState,
    startIndex: number,
    windowSize = TASK_RETRY_START_WINDOW_SIZE,
  ): boolean {
    if (frame.workflow.steps.length === 0 || windowSize <= 0) return false;
    const normalizedStart = Math.max(
      0,
      Math.min(startIndex, frame.workflow.steps.length - 1),
    );
    const endIndex = Math.min(
      frame.workflow.steps.length,
      normalizedStart + windowSize,
    );
    const previous = frame.activeStepWindow;
    const changed = previous?.start !== normalizedStart || previous.end !== endIndex;
    frame.activeStepWindow = { start: normalizedStart, end: endIndex };
    this.pruneFrameState(frame);
    if (changed) this.projectionSnapshot = undefined;
    return changed;
  }

  private loadParallelWindow(
    frame: TaskRetryRestartTreeFrameState,
    parentStepIndex: number,
    startVisibleOffset: number,
    windowSize = TASK_RETRY_START_WINDOW_SIZE,
  ): boolean {
    const parentStep = frame.workflow.steps[parentStepIndex];
    if (
      parentStep === undefined
      || parentStep.parallel === undefined
      || isDynamicParallelSubSteps(parentStep.parallel)
      || windowSize <= 0
    ) {
      return false;
    }

    const visibleSubStepIndices = this.getStaticParallelVisibleSubStepIndices(parentStep);
    if (visibleSubStepIndices.length === 0) return false;
    const normalizedStart = Math.max(
      0,
      Math.min(startVisibleOffset, visibleSubStepIndices.length - 1),
    );
    const endIndex = Math.min(
      visibleSubStepIndices.length,
      normalizedStart + windowSize,
    );
    const previous = frame.activeParallelWindows.get(parentStepIndex);
    const changed = previous?.start !== normalizedStart
      || previous?.end !== endIndex
      || previous?.visibleSubStepIndices.length !== visibleSubStepIndices.length
      || previous?.visibleSubStepIndices.some(
        (index, offset) => index !== visibleSubStepIndices[offset],
      ) === true;
    frame.activeParallelWindows.set(parentStepIndex, {
      start: normalizedStart,
      end: endIndex,
      visibleSubStepIndices,
    });
    this.pruneFrameState(frame);
    if (changed) this.projectionSnapshot = undefined;
    return changed;
  }

  private getStaticParallelVisibleSubStepIndices(
    parentStep: WorkflowStep,
  ): number[] {
    if (
      parentStep.parallel === undefined
      || isDynamicParallelSubSteps(parentStep.parallel)
    ) {
      return [];
    }
    return parentStep.parallel.flatMap((subStep, subStepIndex) => (
      isWorkflowCallStep(subStep) ? [subStepIndex] : []
    ));
  }

  private pruneFrameState(frame: TaskRetryRestartTreeFrameState): void {
    for (const parentStepIndex of frame.activeParallelWindows.keys()) {
      if (!this.isStepIndexActive(frame, parentStepIndex)) {
        frame.activeParallelWindows.delete(parentStepIndex);
      }
    }

    for (const [key, child] of frame.childFrames) {
      if (!this.isNodeKeyActive(frame, key)) {
        frame.childFrames.delete(key);
        frame.expandedCallKeys.delete(key);
        frame.nodeIds.delete(key);
        continue;
      }
      this.pruneFrameState(child);
    }

    for (const key of frame.expandedCallKeys) {
      if (!this.isNodeKeyActive(frame, key)) frame.expandedCallKeys.delete(key);
    }
    for (const key of frame.nodeIds.keys()) {
      if (!this.isNodeKeyActive(frame, key)) frame.nodeIds.delete(key);
    }
  }

  private isNodeKeyActive(frame: TaskRetryRestartTreeFrameState, key: string): boolean {
    if (this.isStepNodeKey(key)) {
      return this.isStepIndexActive(frame, this.getStepNodeIndex(key));
    }
    if (!key.startsWith('parallel:')) return false;
    const separatorIndex = key.indexOf(':', 'parallel:'.length);
    if (separatorIndex < 0) return false;
    const parentStepIndexText = key.slice('parallel:'.length, separatorIndex);
    const parallelStepIndexText = key.slice(separatorIndex + 1);
    if (parentStepIndexText.length === 0 || parallelStepIndexText.length === 0) return false;
    const parentStepIndex = Number(parentStepIndexText);
    const parallelStepIndex = Number(parallelStepIndexText);
    const window = frame.activeParallelWindows.get(parentStepIndex);
    return window !== undefined
      && this.isStepIndexActive(frame, parentStepIndex)
      && this.isParallelIndexActive(window, parallelStepIndex);
  }

  private isStepNodeKey(key: string): boolean {
    return key.startsWith('step:');
  }

  private getStepNodeIndex(key: string): number {
    return Number(key.slice('step:'.length));
  }

  private isStepIndexActive(frame: TaskRetryRestartTreeFrameState, index: number): boolean {
    const window = frame.activeStepWindow;
    return window !== undefined && index >= window.start && index < window.end;
  }

  private isParallelIndexActive(
    window: TaskRetryStaticParallelVisibleWindow,
    index: number,
  ): boolean {
    return window.visibleSubStepIndices
      .slice(window.start, window.end)
      .includes(index);
  }

  private findTargetStaticParallelCallIndex(
    frame: TaskRetryRestartTreeFrameState,
    target: WorkflowRestartPoint | undefined,
    startIndex: number,
    endIndex: number,
  ): number | undefined {
    for (let index = startIndex; index < endIndex; index += 1) {
      const step = frame.workflow.steps[index];
      if (step === undefined || !this.isStaticParallelCallStep(step)) continue;
      if (this.findTargetParallelStepIndex(frame, target, index) !== undefined) {
        return index;
      }
    }
    return undefined;
  }

  private findTargetParallelStepIndex(
    frame: TaskRetryRestartTreeFrameState,
    target: WorkflowRestartPoint | undefined,
    parentStepIndex: number,
  ): number | undefined {
    if (
      target === undefined
      || !matchesFrameStack(frame.stack, target.stack.slice(0, frame.stack.length))
    ) {
      return undefined;
    }
    const parentEntry = target.stack[frame.stack.length];
    const nextEntry = target.stack[frame.stack.length + 1];
    const parentStep = frame.workflow.steps[parentStepIndex];
    if (
      parentEntry === undefined
      || nextEntry === undefined
      || parentStep === undefined
      || parentStep.name !== parentEntry.step
      || parentStep.parallel === undefined
      || isDynamicParallelSubSteps(parentStep.parallel)
    ) {
      return undefined;
    }
    const index = parentStep.parallel.findIndex((subStep) => (
      subStep.name === nextEntry.step
      && getWorkflowStepKind(subStep) === nextEntry.kind
    ));
    return index < 0 ? undefined : index;
  }

  private findStaticParallelVisibleOffset(
    frame: TaskRetryRestartTreeFrameState,
    parentStepIndex: number,
    rawSubStepIndex: number,
  ): number | undefined {
    const parentStep = frame.workflow.steps[parentStepIndex];
    if (parentStep === undefined) return undefined;
    const visibleSubStepIndices = this.getStaticParallelVisibleSubStepIndices(parentStep);
    const visibleOffset = visibleSubStepIndices.indexOf(rawSubStepIndex);
    return visibleOffset < 0 ? undefined : visibleOffset;
  }

  private findFirstVisibleStepIndex(workflow: WorkflowConfig): number | undefined {
    const index = workflow.steps.findIndex((step) => (
      isWorkflowCallStep(step) || isWorkflowRestartTarget(step)
    ));
    return index < 0 ? undefined : index;
  }

  private findTargetStepIndex(
    frame: TaskRetryRestartTreeFrameState,
    target: WorkflowRestartPoint | undefined,
  ): number | undefined {
    if (target === undefined || !matchesFrameStack(frame.stack, target.stack)) return undefined;
    const targetEntry = target.stack[frame.stack.length];
    if (targetEntry === undefined || targetEntry.workflow_ref !== getWorkflowReference(frame.workflow)) {
      return undefined;
    }
    const index = frame.workflow.steps.findIndex((step) => (
      step.name === targetEntry.step && getWorkflowStepKind(step) === targetEntry.kind
    ));
    return index < 0 ? undefined : index;
  }

  private getVisibleNodesForFrame(
    frame: TaskRetryRestartTreeFrameState,
    budget: number,
    projections?: Map<
      TaskRetryRestartTreeFrameState,
      TaskRetryRestartTreeFrameProjection
    >,
  ): TaskRetryRestartTreeNode[] {
    const nodes: TaskRetryRestartTreeNode[] = [];
    projections?.set(frame, { budget, nodes });
    if (budget <= 0) return nodes;
    const stepWindow = frame.activeStepWindow;
    if (stepWindow === undefined) return nodes;
    const targetBranch = this.getTargetBranch(frame);
    let remainingRequiredNodes = this.getRequiredVisibleNodeCount(frame);
    for (
      let stepIndex = stepWindow.start;
      stepIndex < stepWindow.end && nodes.length < budget;
      stepIndex += 1
    ) {
      const step = frame.workflow.steps[stepIndex];
      if (step === undefined) continue;
      const requiredStepNodes = this.getRequiredVisibleNodeCountForStep(
        frame,
        stepIndex,
        targetBranch,
      );
      if (
        requiredStepNodes === 0
        && nodes.length + 1 + remainingRequiredNodes > budget
      ) {
        continue;
      }
      const entry = createRestartEntry(frame.workflow, step);
      const restartPoint = { stack: [...frame.stack, entry] };
      if (isWorkflowCallStep(step)) {
        const key = `step:${stepIndex}`;
        const navigation = this.createNavigationNode(
          frame,
          key,
          step,
          restartPoint,
          frame.workflowPath,
          stepIndex,
        );
        nodes.push(navigation);
        if (requiredStepNodes > 0) remainingRequiredNodes -= 1;
        if (navigation.expanded) {
          const child = frame.childFrames.get(key);
          if (child !== undefined) {
            const requiredChildNodes = this.getExpandedChildNodeCount(child);
            const childBudget = budget - nodes.length
              - (remainingRequiredNodes - requiredChildNodes);
            nodes.push(...this.getVisibleNodesForFrame(child, childBudget, projections));
            remainingRequiredNodes -= requiredChildNodes;
          }
        }
        continue;
      }

      const isResumeCandidate = sameRestartPoint(restartPoint, this.resumeRestartPoint);
      if (isWorkflowRestartTarget(step) || isResumeCandidate) {
        nodes.push({
          kind: 'leaf',
          value: this.getNodeValue(frame, `step:${stepIndex}`),
          step,
          restartPoint,
          workflowPath: frame.workflowPath,
          isRestartable: isWorkflowRestartTarget(step),
          isDefaultCandidate: sameRestartPoint(restartPoint, this.defaultRestartPoint),
          isResumeCandidate,
          frame,
        });
        if (requiredStepNodes > 0) remainingRequiredNodes -= 1;
      }

      if (step.parallel !== undefined && !isDynamicParallelSubSteps(step.parallel)) {
        const parallelWindow = frame.activeParallelWindows.get(stepIndex);
        if (parallelWindow === undefined) continue;
        for (
          let visibleOffset = parallelWindow.start;
          visibleOffset < parallelWindow.end && nodes.length < budget;
          visibleOffset += 1
        ) {
          const subStepIndex = parallelWindow.visibleSubStepIndices[visibleOffset];
          if (subStepIndex === undefined) continue;
          const subStep = step.parallel[subStepIndex];
          if (subStep === undefined) continue;
          if (!isWorkflowCallStep(subStep)) continue;
          const key = `parallel:${stepIndex}:${subStepIndex}`;
          const requiredParallelNodes = this.getRequiredVisibleNodeCountForParallelStep(
            frame,
            stepIndex,
            subStepIndex,
            targetBranch,
          );
          if (
            requiredParallelNodes === 0
            && nodes.length + 1 + remainingRequiredNodes > budget
          ) {
            continue;
          }
          const navigation = this.createNavigationNode(
            frame,
            key,
            subStep,
            { stack: [...restartPoint.stack, createRestartEntry(frame.workflow, subStep)] },
            [...frame.workflowPath, step.name],
            stepIndex,
            step.name,
            subStepIndex,
          );
          nodes.push(navigation);
          if (requiredParallelNodes > 0) remainingRequiredNodes -= 1;
          if (navigation.expanded) {
            const child = frame.childFrames.get(key);
            if (child !== undefined) {
              const requiredChildNodes = this.getExpandedChildNodeCount(child);
              const childBudget = budget - nodes.length
                - (remainingRequiredNodes - requiredChildNodes);
              nodes.push(...this.getVisibleNodesForFrame(child, childBudget, projections));
              remainingRequiredNodes -= requiredChildNodes;
            }
          }
        }
      }
    }
    return nodes;
  }

  private getTargetBranch(
    frame: TaskRetryRestartTreeFrameState,
  ): TaskRetryRestartTreeTargetBranch | undefined {
    const target = this.resumeRestartPoint ?? this.defaultRestartPoint;
    if (target === undefined || !matchesFrameStack(frame.stack, target.stack)) {
      return undefined;
    }
    const stepIndex = this.findTargetStepIndex(frame, target);
    if (stepIndex === undefined || !this.isStepIndexActive(frame, stepIndex)) {
      return undefined;
    }
    const parallelStepIndex = this.findTargetParallelStepIndex(frame, target, stepIndex);
    return parallelStepIndex === undefined
      ? { stepIndex }
      : { stepIndex, parallelStepIndex };
  }

  private getRequiredVisibleNodeCount(
    frame: TaskRetryRestartTreeFrameState,
  ): number {
    const stepWindow = frame.activeStepWindow;
    if (stepWindow === undefined) return 0;

    let requiredNodes = 0;
    const targetBranch = this.getTargetBranch(frame);
    for (let stepIndex = stepWindow.start; stepIndex < stepWindow.end; stepIndex += 1) {
      requiredNodes += this.getRequiredVisibleNodeCountForStep(frame, stepIndex, targetBranch);
    }
    return requiredNodes;
  }

  private getRequiredVisibleNodeCountForStep(
    frame: TaskRetryRestartTreeFrameState,
    stepIndex: number,
    targetBranch: TaskRetryRestartTreeTargetBranch | undefined,
  ): number {
    const step = frame.workflow.steps[stepIndex];
    if (step === undefined) return 0;

    const isTargetStep = targetBranch?.stepIndex === stepIndex;
    const stepKey = `step:${stepIndex}`;
    const isExpandedNavigation = isWorkflowCallStep(step)
      && frame.expandedCallKeys.has(stepKey);
    const parallelWindow = step.parallel === undefined || isDynamicParallelSubSteps(step.parallel)
      ? undefined
      : frame.activeParallelWindows.get(stepIndex);
    let requiredParallelNodes = 0;
    if (parallelWindow !== undefined) {
      for (
        let visibleOffset = parallelWindow.start;
        visibleOffset < parallelWindow.end;
        visibleOffset += 1
      ) {
        const parallelStepIndex = parallelWindow.visibleSubStepIndices[visibleOffset];
        if (parallelStepIndex === undefined) continue;
        requiredParallelNodes += this.getRequiredVisibleNodeCountForParallelStep(
          frame,
          stepIndex,
          parallelStepIndex,
          targetBranch,
        );
      }
    }
    if (!isTargetStep && !isExpandedNavigation && requiredParallelNodes === 0) return 0;

    let requiredNodes = 1;
    if (isExpandedNavigation) {
      const child = frame.childFrames.get(stepKey);
      if (child !== undefined) {
        requiredNodes += this.getExpandedChildNodeCount(child);
      }
    }
    requiredNodes += requiredParallelNodes;

    return requiredNodes;
  }

  private getRequiredVisibleNodeCountForParallelStep(
    frame: TaskRetryRestartTreeFrameState,
    stepIndex: number,
    parallelStepIndex: number,
    targetBranch: TaskRetryRestartTreeTargetBranch | undefined,
  ): number {
    const step = frame.workflow.steps[stepIndex];
    const parallel = step?.parallel;
    if (parallel === undefined || isDynamicParallelSubSteps(parallel)) return 0;
    const subStep = parallel[parallelStepIndex];
    if (subStep === undefined || !isWorkflowCallStep(subStep)) return 0;

    const isTargetParallelStep = targetBranch?.stepIndex === stepIndex
      && targetBranch.parallelStepIndex === parallelStepIndex;
    const key = `parallel:${stepIndex}:${parallelStepIndex}`;
    const isExpandedNavigation = frame.expandedCallKeys.has(key);
    const parallelWindow = frame.activeParallelWindows.get(stepIndex);
    const activeParallelStepIndex = parallelWindow === undefined
      ? undefined
      : this.getActiveParallelNavigationIndex(parallelWindow);
    const isActiveParallelNavigation = activeParallelStepIndex === parallelStepIndex;
    if (!isTargetParallelStep && !isExpandedNavigation && !isActiveParallelNavigation) return 0;

    let requiredNodes = 1;
    if (isExpandedNavigation) {
      const child = frame.childFrames.get(key);
      if (child !== undefined) {
        requiredNodes += this.getExpandedChildNodeCount(child);
      }
    }

    return requiredNodes;
  }

  private getActiveParallelNavigationIndex(
    window: TaskRetryStaticParallelVisibleWindow,
  ): number | undefined {
    for (
      let visibleOffset = window.start;
      visibleOffset < window.end;
      visibleOffset += 1
    ) {
      const parallelStepIndex = window.visibleSubStepIndices[visibleOffset];
      if (parallelStepIndex !== undefined) return parallelStepIndex;
    }
    return undefined;
  }

  private getExpandedChildNodeCount(
    child: TaskRetryRestartTreeFrameState,
  ): number {
    const requiredNodes = this.getRequiredVisibleNodeCount(child);
    if (requiredNodes > 0) return requiredNodes;
    return this.getVisibleNodesForFrame(child, 1).length > 0 ? 1 : 0;
  }

  private getProjectionSnapshot(): TaskRetryRestartTreeProjectionSnapshot {
    if (this.projectionSnapshot !== undefined) return this.projectionSnapshot;

    const frames = new Map<
      TaskRetryRestartTreeFrameState,
      TaskRetryRestartTreeFrameProjection
    >();
    const nodes = this.getVisibleNodesForFrame(
      this.rootFrame,
      TASK_RETRY_START_WINDOW_SIZE,
      frames,
    );
    this.projectionSnapshot = { nodes, frames };
    return this.projectionSnapshot;
  }

  private isStaticParallelCallStep(step: WorkflowStep): boolean {
    return step.parallel !== undefined
      && !isDynamicParallelSubSteps(step.parallel)
      && step.parallel.some((subStep) => isWorkflowCallStep(subStep));
  }

  private createNavigationNode(
    frame: TaskRetryRestartTreeFrameState,
    key: string,
    step: Extract<WorkflowStep, { kind: 'workflow_call' }>,
    restartPoint: WorkflowRestartPoint,
    workflowPath: readonly string[],
    parentStepIndex: number,
    parallelStepName?: string,
    parallelStepIndex?: number,
  ): TaskRetryRestartTreeNavigation {
    return {
      kind: 'navigation',
      value: this.getNodeValue(frame, key),
      step,
      restartPoint,
      workflowPath: [...workflowPath],
      expanded: frame.expandedCallKeys.has(key),
      frame,
      key,
      parentStepIndex,
      ...(parallelStepName === undefined ? {} : { parallelStepName }),
      ...(parallelStepIndex === undefined ? {} : { parallelStepIndex }),
    };
  }

  private getNodeValue(frame: TaskRetryRestartTreeFrameState, key: string): string {
    const existing = frame.nodeIds.get(key);
    if (existing !== undefined) return existing;
    const value = `retry-tree-${this.nextNodeId}`;
    this.nextNodeId += 1;
    frame.nodeIds.set(key, value);
    return value;
  }

  private resolveChildFrame(node: TaskRetryRestartTreeNavigation): TaskRetryRestartTreeFrameState {
    const existing = node.frame.childFrames.get(node.key);
    if (existing !== undefined) return existing;
    const child = resolveCallableChild(node.frame.workflow, node.step, this.context);
    assertCallableChildBoundary(child, node.frame.ancestors);
    const workflowPath = node.parallelStepName === undefined
      ? [...node.frame.workflowPath, node.step.name, child.name]
      : [...node.workflowPath, node.step.name, child.name];
    const childFrame = this.createFrame(
      child,
      node.restartPoint.stack,
      workflowPath,
      [...node.frame.ancestors, getWorkflowReference(child)],
      node.frame,
      node.parentStepIndex,
      node.parallelStepIndex,
    );
    this.loadInitialWindow(childFrame);
    return childFrame;
  }

  private ensureRestartPointVisible(target: WorkflowRestartPoint): void {
    let frame = this.rootFrame;
    let index = 0;
    while (index < target.stack.length) {
      const entry = target.stack[index]!;
      if (!matchesFrameStack(frame.stack, target.stack.slice(0, frame.stack.length))) {
        return;
      }
      const stepIndex = frame.workflow.steps.findIndex((step) => (
        step.name === entry.step && getWorkflowStepKind(step) === entry.kind
      ));
      if (stepIndex < 0) return;
      if (!this.isStepIndexActive(frame, stepIndex)) {
        const nestedContentCount = Math.max(0, target.stack.length - frame.stack.length - 1);
        const windowSize = Math.max(
          1,
          TASK_RETRY_START_WINDOW_SIZE - nestedContentCount,
        );
        this.loadWindow(frame, stepIndex - windowSize + 1, windowSize);
      }
      const step = frame.workflow.steps[stepIndex]!;
      if (isWorkflowCallStep(step)) {
        const node = this.createNavigationNode(
          frame,
          `step:${stepIndex}`,
          step,
          { stack: [...frame.stack, createRestartEntry(frame.workflow, step)] },
          frame.workflowPath,
          stepIndex,
        );
        frame.expandedCallKeys.add(node.key);
        const child = this.resolveChildFrame(node);
        frame.childFrames.set(node.key, child);
        frame = child;
        index += 1;
        continue;
      }
      if (index === target.stack.length - 1) return;
      const nextEntry = target.stack[index + 1]!;
      if (step.parallel === undefined || isDynamicParallelSubSteps(step.parallel)) return;
      const subStepIndex = step.parallel.findIndex((subStep) => (
        subStep.name === nextEntry.step && getWorkflowStepKind(subStep) === nextEntry.kind
      ));
      const subStep = subStepIndex < 0 ? undefined : step.parallel[subStepIndex];
      if (subStep === undefined || !isWorkflowCallStep(subStep)) return;
      const key = `parallel:${stepIndex}:${subStepIndex}`;
      const visibleOffset = this.findStaticParallelVisibleOffset(
        frame,
        stepIndex,
        subStepIndex,
      );
      if (visibleOffset === undefined) return;
      this.loadParallelWindow(frame, stepIndex, visibleOffset, 1);
      const node = this.createNavigationNode(
        frame,
        key,
        subStep,
        { stack: [...frame.stack, createRestartEntry(frame.workflow, step), createRestartEntry(frame.workflow, subStep)] },
        [...frame.workflowPath, step.name],
        stepIndex,
        step.name,
        subStepIndex,
      );
      frame.expandedCallKeys.add(key);
      const child = this.resolveChildFrame(node);
      frame.childFrames.set(key, child);
      frame = child;
      index += 2;
    }
  }

  private loadAdjacentWindow(
    projection: TaskRetryRestartTreeProjectionSnapshot,
    node: TaskRetryRestartTreeNode,
    direction: 'up' | 'down',
  ): boolean {
    if (node.kind === 'navigation' && node.parallelStepIndex !== undefined) {
      const changed = this.loadAdjacentParallelWindow(
        node.frame,
        node.parentStepIndex,
        node.parallelStepIndex,
        direction,
      );
      if (changed) return true;
    }

    if (
      node.kind === 'leaf'
      && direction === 'down'
      && this.isStaticParallelCallStep(node.step)
    ) {
      const stepIndex = node.frame.workflow.steps.indexOf(node.step);
      if (stepIndex >= 0 && this.loadParallelWindow(node.frame, stepIndex, 0)) {
        return true;
      }
    }

    let frame: TaskRetryRestartTreeFrameState | undefined = node.frame;
    let fromChildFrame = false;
    let currentStepIndex = node.kind === 'navigation'
      ? node.parentStepIndex
      : frame.workflow.steps.indexOf(node.step);
    while (frame !== undefined) {
      const window = frame.activeStepWindow;
      if (window !== undefined && currentStepIndex >= 0) {
        const projectedBudget = projection.frames.get(frame)?.budget;
        const windowSize = Math.max(
          1,
          Math.min(window.end - window.start, projectedBudget ?? (window.end - window.start)),
        );
        const adjacentIndex = direction === 'up'
          ? currentStepIndex - windowSize + (
            fromChildFrame || windowSize === 1 ? 0 : 1
          )
          : currentStepIndex + (
            fromChildFrame || windowSize === 1 ? 1 : 0
          );
        const changed = direction === 'up'
          ? currentStepIndex > 0
            && this.loadWindow(frame, adjacentIndex, windowSize)
          : currentStepIndex + 1 < frame.workflow.steps.length
            && this.loadWindow(frame, adjacentIndex, windowSize);
        if (changed) return true;
      }

      const parent: TaskRetryRestartTreeFrameState | undefined = frame.parent;
      if (parent === undefined || frame.parentStepIndex === undefined) return false;
      const parentStepIndex = frame.parentStepIndex;
      if (frame.parentParallelStepIndex !== undefined) {
        const changed = this.loadAdjacentParallelWindow(
          parent,
          parentStepIndex,
          frame.parentParallelStepIndex,
          direction,
          true,
        );
        if (changed) return true;
      }
      frame = parent;
      currentStepIndex = parentStepIndex;
      fromChildFrame = true;
    }
    return false;
  }

  private loadAdjacentParallelWindow(
    frame: TaskRetryRestartTreeFrameState,
    parentStepIndex: number,
    currentRawSubStepIndex: number,
    direction: 'up' | 'down',
    fromChildFrame = false,
  ): boolean {
    const window = frame.activeParallelWindows.get(parentStepIndex);
    if (window === undefined) {
      return direction === 'down' && this.loadParallelWindow(frame, parentStepIndex, 0);
    }

    const currentVisibleOffset = window.visibleSubStepIndices.indexOf(currentRawSubStepIndex);
    if (currentVisibleOffset < 0) return false;
    const windowSize = Math.max(1, window.end - window.start);
    const adjacentVisibleOffset = direction === 'up'
      ? currentVisibleOffset - windowSize + (fromChildFrame ? 0 : 1)
      : currentVisibleOffset + (fromChildFrame ? 1 : 0);
    const visibleCount = window.visibleSubStepIndices.length;
    return direction === 'up'
      ? currentVisibleOffset > 0
        && this.loadParallelWindow(
          frame,
          parentStepIndex,
          adjacentVisibleOffset,
          windowSize,
        )
      : currentVisibleOffset + 1 < visibleCount
        && this.loadParallelWindow(
          frame,
          parentStepIndex,
          adjacentVisibleOffset,
          windowSize,
        );
  }

  private isUpKey(key: string): boolean {
    return key === '\x1B[A' || key === '\x1BOA' || key === 'k';
  }

  private isDownKey(key: string): boolean {
    return key === '\x1B[B' || key === '\x1BOB' || key === 'j';
  }
}

function resolveTaskRetryStackPathWithOptions(
  rootWorkflow: WorkflowConfig,
  stack: readonly (WorkflowResumePointEntry | WorkflowRestartPointEntry)[],
  context: TaskRetryStartPathContext,
  options: ResolveTaskRetryStackOptions,
): ResolvedTaskRetryPath | undefined {
  let workflow = rootWorkflow;
  let steps = rootWorkflow.steps;
  const ancestors = [getWorkflowReference(rootWorkflow)];
  let restartStack: WorkflowRestartPointEntry[] = [];

  const resolveInitialRestartLeaf = (
    initialWorkflow: WorkflowConfig,
    initialAncestors: readonly string[],
    initialStack: readonly WorkflowRestartPointEntry[],
  ): ResolvedTaskRetryPath => {
    let workflowToVisit = initialWorkflow;
    let ancestorsToVisit = [...initialAncestors];
    const resolvedStack = [...initialStack];

    while (true) {
      const initialStep = workflowToVisit.steps.find(
        (candidate) => candidate.name === workflowToVisit.initialStep,
      );
      if (initialStep === undefined) {
        throw new Error(
          `Workflow "${workflowToVisit.name}" initial step "${workflowToVisit.initialStep}" cannot be resolved`,
        );
      }

      resolvedStack.push(createRestartEntry(workflowToVisit, initialStep));
      if (!isWorkflowCallStep(initialStep)) {
        return {
          restartPoint: { stack: resolvedStack },
        };
      }

      const child = resolveCallableChild(workflowToVisit, initialStep, context);
      assertCallableChildBoundary(child, ancestorsToVisit);
      ancestorsToVisit = [...ancestorsToVisit, getWorkflowReference(child)];
      workflowToVisit = child;
    }
  };

  for (let index = 0; index < stack.length; index += 1) {
    const entry = stack[index]!;
    const entryMatchesWorkflow = options.requireRestartIdentity
      ? workflowRestartEntryMatchesWorkflow(entry as WorkflowRestartPointEntry, workflow)
      : workflowEntryMatchesWorkflow(entry as WorkflowResumePointEntry, workflow);
    if (!entryMatchesWorkflow) {
      return undefined;
    }
    const step = steps.find((candidate) => candidate.name === entry.step);
    if (step === undefined) {
      return undefined;
    }
    const expectedKind = options.requireRestartIdentity
      ? getWorkflowStepKind(step)
      : getWorkflowResumeFrameKind(step);
    if (expectedKind !== entry.kind) {
      return undefined;
    }
    const nextRestartStack = [...restartStack, createRestartEntry(workflow, step)];
    const isTerminalEntry = index === stack.length - 1;
    if (isTerminalEntry && options.requireRestartTarget && !isWorkflowRestartTarget(step)) {
      return undefined;
    }
    if (isWorkflowCallStep(step)) {
      const child = resolveCallableChild(workflow, step, context);
      assertCallableChildBoundary(child, ancestors);
      if (isTerminalEntry) {
        if (options.requireRestartIdentity) {
          return { restartPoint: { stack: nextRestartStack } };
        }
        return resolveInitialRestartLeaf(
          child,
          [...ancestors, getWorkflowReference(child)],
          nextRestartStack,
        );
      }
      workflow = child;
      steps = child.steps;
      restartStack = nextRestartStack;
      ancestors.push(getWorkflowReference(child));
      continue;
    }
    if (isTerminalEntry) {
      return { restartPoint: { stack: nextRestartStack } };
    }
    if (!options.allowParallelEntries || step.parallel === undefined) {
      return undefined;
    }
    if (isDynamicParallelSubSteps(step.parallel)) return undefined;
    const nextEntry = stack[index + 1];
    const parallelCall = nextEntry === undefined
      ? undefined
      : step.parallel.find((subStep) => (
        subStep.name === nextEntry.step
        && getWorkflowStepKind(subStep) === nextEntry.kind
      ));
    if (parallelCall === undefined || !isWorkflowCallStep(parallelCall)) return undefined;
    restartStack = nextRestartStack;
    steps = step.parallel;
  }
  return undefined;
}

export function resolveTaskRetryStackPath(
  rootWorkflow: WorkflowConfig,
  stack: readonly WorkflowResumePointEntry[],
  context: TaskRetryStartPathContext,
  allowParallelEntries: boolean,
): ResolvedTaskRetryPath | undefined {
  return resolveTaskRetryStackPathWithOptions(rootWorkflow, stack, context, {
    allowParallelEntries,
    requireRestartTarget: false,
    requireRestartIdentity: false,
  });
}

export function validateTaskRetryRestartPoint(
  rootWorkflow: WorkflowConfig,
  restartPoint: WorkflowRestartPoint,
  context: TaskRetryStartPathContext,
): void {
  new WorkflowRestartNavigator(restartPoint).resolveRootStartStep(rootWorkflow, undefined);
  const resolved = resolveTaskRetryStackPathWithOptions(rootWorkflow, restartPoint.stack, context, {
    allowParallelEntries: true,
    requireRestartTarget: true,
    requireRestartIdentity: true,
  });
  if (resolved !== undefined) {
    return;
  }
  const terminalStep = restartPoint.stack.at(-1)?.step;
  throw new Error(
    `Task retry restart path cannot be resolved${terminalStep ? ` at step "${terminalStep}"` : ''}`,
  );
}
