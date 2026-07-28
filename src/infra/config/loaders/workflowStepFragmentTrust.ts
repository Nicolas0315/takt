import type { FacetResolutionContext } from './resource-resolver.js';
import { getOwnValue, isRecord, type RawRecord } from './workflowStepFragmentReader.js';
import { isPathWithin, type WorkflowStepFragmentProvenance } from './workflowStepFragmentProvenance.js';
import { resolveWorkflowTrustInfo, type WorkflowTrustInfo } from './workflowTrustSource.js';
import { getWorkflowStepKind } from '../../../core/models/workflow-step-kind.js';

interface TrustOptions {
  context?: FacetResolutionContext;
  workflowPath: string;
  trustInfo?: WorkflowTrustInfo;
}

function findCallProvenance(provenance: readonly WorkflowStepFragmentProvenance[], stepPath: readonly PropertyKey[]): WorkflowStepFragmentProvenance | undefined {
  return provenance.find((entry) => entry.stepPath.length === stepPath.length + 1 && isPathWithin(entry.stepPath, [...stepPath, 'call']));
}

function findFieldProvenance(
  provenance: readonly WorkflowStepFragmentProvenance[],
  stepPath: readonly PropertyKey[],
  field: string,
): WorkflowStepFragmentProvenance | undefined {
  return provenance.find((entry) => entry.stepPath.length === stepPath.length + 1 && isPathWithin(entry.stepPath, [...stepPath, field]));
}

function assertWorkflowCallTrustBoundary(merged: RawRecord, options: TrustOptions, provenance: readonly WorkflowStepFragmentProvenance[], stepPath: readonly PropertyKey[]): void {
  if (getWorkflowStepKind(merged) !== 'workflow_call' || !options.context?.projectDir) return;
  const callProvenance = findCallProvenance(provenance, stepPath);
  if (!callProvenance) return;
  const workflowTrust = options.trustInfo ?? resolveWorkflowTrustInfo({ filePath: options.workflowPath, projectCwd: options.context.projectDir });
  const fragmentTrust = resolveWorkflowTrustInfo({ filePath: callProvenance.sourcePath, projectCwd: options.context.projectDir });
  if (workflowTrust.isProjectWorkflowRoot && !fragmentTrust.isProjectTrustRoot) {
    throw new Error(`Configuration error in workflow ${options.workflowPath}: workflow_call from step fragment "${callProvenance.ref}" at ${callProvenance.sourcePath} crosses the workflow trust boundary`);
  }
}

function assertAllowGitCommitTrustBoundary(merged: RawRecord, options: TrustOptions, provenance: readonly WorkflowStepFragmentProvenance[], stepPath: readonly PropertyKey[]): void {
  if (getOwnValue(merged, 'allow_git_commit') !== true || !options.context?.projectDir) return;
  const allowGitCommitProvenance = findFieldProvenance(provenance, stepPath, 'allow_git_commit');
  if (!allowGitCommitProvenance) return;
  const workflowTrust = options.trustInfo ?? resolveWorkflowTrustInfo({ filePath: options.workflowPath, projectCwd: options.context.projectDir });
  const fragmentTrust = resolveWorkflowTrustInfo({ filePath: allowGitCommitProvenance.sourcePath, projectCwd: options.context.projectDir });
  if (workflowTrust.isProjectWorkflowRoot && !fragmentTrust.isProjectTrustRoot) {
    throw new Error(`Configuration error in workflow ${options.workflowPath}: allow_git_commit from step fragment "${allowGitCommitProvenance.ref}" at ${allowGitCommitProvenance.sourcePath} crosses the workflow trust boundary`);
  }
}

export function assertWorkflowCallTrustBoundaries(raw: RawRecord, options: TrustOptions, provenance: readonly WorkflowStepFragmentProvenance[]): void {
  if (!Array.isArray(raw.steps)) return;
  const visit = (step: unknown, stepPath: readonly PropertyKey[]): void => {
    if (!isRecord(step)) return;
    assertWorkflowCallTrustBoundary(step, options, provenance, stepPath);
    assertAllowGitCommitTrustBoundary(step, options, provenance, stepPath);
    if (Array.isArray(step.parallel)) step.parallel.forEach((subStep, index) => visit(subStep, [...stepPath, 'parallel', index]));
  };
  raw.steps.forEach((step, index) => visit(step, ['steps', index]));
}
