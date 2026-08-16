import {
  type WorkflowConfig,
  type WorkflowRestartPoint,
  type WorkflowResumePoint,
} from '../../../core/models/index.js';
import type {
  InteractiveSelectCallbacks,
  SelectOptionItem,
} from '../../../shared/prompt/index.js';
import { sanitizeTerminalText } from '../../../shared/utils/text.js';
import {
  resolveTaskRetryStackPath,
  TaskRetryRestartTree,
  type ResolvedTaskRetryPath,
  type TaskRetryRestartTreeNode,
  type TaskRetryStartPathContext,
} from '../taskRetryStartPath.js';

const RESUME_SELECTION_VALUE = 'resume-checkpoint';
const TASK_RETRY_RESUME_PATH_UNRESOLVED_ERROR = 'Task retry resume path cannot be resolved';

export type TaskRetryStartSelection =
  | { kind: 'resume'; resumePoint: WorkflowResumePoint }
  | { kind: 'restart'; restartPoint: WorkflowRestartPoint };

export interface TaskRetryStartSelectionResult {
  label: string;
  selection: TaskRetryStartSelection;
}

export type TaskRetryStartOptionSelector = (
  message: string,
  options: SelectOptionItem<string>[],
  defaultValue: string,
  callbacks?: InteractiveSelectCallbacks<string>,
) => Promise<string | null>;

interface SelectTaskRetryStartOptions extends TaskRetryStartPathContext {
  resumePoint?: WorkflowResumePoint;
  preferredRootStep?: string;
}

interface SelectableResumePath {
  resumePoint: WorkflowResumePoint;
  resolvedPath: ResolvedTaskRetryPath;
}

interface ProjectedTree {
  options: SelectOptionItem<string>[];
  selections: Map<string, TaskRetryStartSelection>;
}

function resolveSelectableResumePoint(
  rootWorkflow: WorkflowConfig,
  options: SelectTaskRetryStartOptions,
): SelectableResumePath | undefined {
  const resumePoint = options.resumePoint;
  if (resumePoint === undefined) return undefined;

  const resolvedPath = resolveTaskRetryStackPath(
    rootWorkflow,
    resumePoint.stack,
    options,
    true,
  );
  if (resolvedPath === undefined) {
    if (resumePoint.stack.at(-1)?.kind === 'workflow_call') {
      throw new Error(TASK_RETRY_RESUME_PATH_UNRESOLVED_ERROR);
    }
    return undefined;
  }
  return { resumePoint, resolvedPath };
}

function formatWorkflowHeading(name: string): string {
  return sanitizeTerminalText(name);
}

function getNodeLabel(node: TaskRetryRestartTreeNode): string {
  return sanitizeTerminalText(node.step.name);
}

function projectTree(
  rootWorkflow: WorkflowConfig,
  nodes: readonly TaskRetryRestartTreeNode[],
  resumePath: SelectableResumePath | undefined,
): ProjectedTree {
  const options: SelectOptionItem<string>[] = [];
  const selections = new Map<string, TaskRetryStartSelection>();
  const isCallTerminatedResume = resumePath?.resumePoint.stack.at(-1)?.kind === 'workflow_call';

  for (const node of nodes) {
    const label = getNodeLabel(node);
    if (node.kind === 'navigation') {
      options.push({
        label,
        value: node.value,
        leadingLines: node.workflowPath.map(formatWorkflowHeading),
        indent: node.workflowPath.length + 1,
      });
      continue;
    }
    if (!node.isRestartable && !node.isResumeCandidate) continue;
    if (node.isResumeCandidate && isCallTerminatedResume && !node.isRestartable) {
      throw new Error(TASK_RETRY_RESUME_PATH_UNRESOLVED_ERROR);
    }

    const value = node.isResumeCandidate ? RESUME_SELECTION_VALUE : node.value;
    const selection = node.isResumeCandidate
      ? isCallTerminatedResume
        ? { kind: 'restart' as const, restartPoint: node.restartPoint }
        : { kind: 'resume' as const, resumePoint: resumePath!.resumePoint }
      : { kind: 'restart' as const, restartPoint: node.restartPoint };
    options.push({
      label,
      value,
      leadingLines: node.workflowPath.map(formatWorkflowHeading),
      indent: node.workflowPath.length,
      ...(node.restartPoint.stack.length === 1
        && node.step.name === rootWorkflow.initialStep
        ? { description: 'Initial step' }
        : {}),
    });
    selections.set(value, selection);
  }

  return { options, selections };
}

export async function selectTaskRetryStart(
  rootWorkflow: WorkflowConfig,
  options: SelectTaskRetryStartOptions,
  selectOption: TaskRetryStartOptionSelector,
): Promise<TaskRetryStartSelectionResult | null> {
  const resumePath = resolveSelectableResumePoint(rootWorkflow, options);
  const tree = new TaskRetryRestartTree(
    rootWorkflow,
    options,
    options.preferredRootStep,
    { resumeRestartPoint: resumePath?.resolvedPath.restartPoint },
  );

  let projected = projectTree(rootWorkflow, tree.getVisibleNodes(), resumePath);
  if (projected.options.length === 0) {
    throw new Error(`Workflow "${rootWorkflow.name}" has no selectable retry positions`);
  }

  const message = `Start position — ${sanitizeTerminalText(rootWorkflow.name)}:`;
  while (true) {
    const defaultNodeValue = tree.getDefaultValue();
    const defaultNode = defaultNodeValue === undefined
      ? undefined
      : tree.findNode(defaultNodeValue);
    const defaultValue = defaultNode?.kind === 'leaf' && defaultNode.isResumeCandidate
      ? RESUME_SELECTION_VALUE
      : defaultNodeValue;
    if (defaultValue === undefined) {
      throw new Error(`Workflow "${rootWorkflow.name}" has no selectable retry positions`);
    }
    const selectedValue = await selectOption(
      message,
      projected.options,
      defaultValue,
      {
        onKeyPress: (key, value) => {
          const treeValue = value === RESUME_SELECTION_VALUE
            ? tree.getVisibleNodes().find((node) => (
              node.kind === 'leaf' && node.isResumeCandidate
            ))?.value ?? value
            : value;
          if (!tree.handleKeyPress(treeValue, key)) {
            return null;
          }
          projected = projectTree(rootWorkflow, tree.getVisibleNodes(), resumePath);
          return projected.options;
        },
      },
    );
    if (selectedValue === null) return null;

    if (tree.isNavigation(selectedValue)) {
      const navigation = tree.findNode(selectedValue);
      if (navigation?.kind !== 'navigation') {
        throw new Error(`Unknown task retry start selection: ${selectedValue}`);
      }
      tree.toggleNavigation(navigation);
      projected = projectTree(rootWorkflow, tree.getVisibleNodes(), resumePath);
      continue;
    }

    const selection = projected.selections.get(selectedValue);
    if (selection === undefined) {
      throw new Error(`Unknown task retry start selection: ${selectedValue}`);
    }
    const selectedOption = projected.options.find((option) => option.value === selectedValue);
    if (selectedOption === undefined) {
      throw new Error(`Unknown task retry start selection: ${selectedValue}`);
    }
    return { label: selectedOption.label, selection };
  }
}
