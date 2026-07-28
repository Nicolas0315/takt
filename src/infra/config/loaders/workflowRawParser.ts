import { WorkflowConfigRawSchema } from '../../../core/models/index.js';
import type { WorkflowConfig } from '../../../core/models/types.js';
import { ZodError } from 'zod';
import type { FacetResolutionContext } from './resource-resolver.js';
import type { WorkflowStepFragmentProvenance } from './workflowStepFragmentResolver.js';
import { resolveWorkflowStepFragments } from './workflowStepFragmentResolver.js';
import {
  findFragmentProvenanceAtExactPath,
  findFragmentProvenanceForStep,
} from './workflowStepFragmentProvenance.js';
import type { WorkflowTrustInfo } from './workflowTrustSource.js';
import { getWorkflowConfigErrorPath } from '../../../core/workflow/workflow-config-error.js';
import {
  formatWorkflowStepFragmentErrorContext,
  registerWorkflowStepFragmentErrorContext,
  translateWorkflowStepFragmentError,
} from './workflowStepFragmentErrorTranslator.js';
import { attachWorkflowConfigErrorTranslator } from '../../../shared/workflowConfigMetadata.js';

const provenanceByRawWorkflow = new WeakMap<object, readonly WorkflowStepFragmentProvenance[]>();
const annotatedFragmentErrorContexts = new WeakMap<Error, Set<string>>();

export interface WorkflowRawParserOptions {
  context?: FacetResolutionContext;
  workflowPath: string;
  trustInfo?: WorkflowTrustInfo;
}

export function parseWorkflowRaw(raw: unknown, options: WorkflowRawParserOptions): ReturnType<typeof WorkflowConfigRawSchema.parse> {
  const resolved = resolveWorkflowStepFragments(raw, options);
  try {
    const parsed = WorkflowConfigRawSchema.parse(resolved.raw);
    provenanceByRawWorkflow.set(parsed, resolved.provenance);
    return parsed;
  } catch (error) {
    if (!(error instanceof ZodError) || resolved.provenance.length === 0) {
      throw error;
    }
    throw new ZodError(error.issues.map((issue) => {
      const provenance = findFragmentErrorProvenance(issue.path, resolved.provenance);
      if (!provenance) {
        return issue;
      }
      return {
        ...issue,
        message: `${issue.message} (${formatWorkflowStepFragmentErrorContext(options.workflowPath, provenance.source, provenance.workflowDefined)})`,
      };
    }));
  }
}

export function annotateWorkflowFragmentError(
  error: unknown,
  raw: object,
  workflowPath: string,
  sourcePath?: readonly PropertyKey[],
): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Error) {
    const contexts = annotatedFragmentErrorContexts.get(error);
    if (contexts?.has(workflowPath)) {
      return error;
    }
  }
  const provenance = provenanceByRawWorkflow.get(raw) ?? [];
  const errorPath = sourcePath ?? getWorkflowConfigErrorPath(error);
  const exactSource = errorPath === undefined
    ? undefined
    : findFragmentProvenanceAtExactPath(provenance, errorPath);
  const source = exactSource
    ?? (errorPath === undefined ? undefined : findFragmentProvenanceForStep(provenance, errorPath));
  if (!source) {
    return error instanceof Error ? error : new Error(message);
  }
  const details = formatWorkflowStepFragmentErrorContext(workflowPath, source, exactSource === undefined);
  const annotated = new Error(`${message} (${details})`, { cause: error instanceof Error ? error : undefined });
  const contexts = new Set(error instanceof Error ? annotatedFragmentErrorContexts.get(error) : undefined);
  contexts.add(workflowPath);
  annotatedFragmentErrorContexts.set(annotated, contexts);
  return annotated;
}

export function registerWorkflowFragmentErrorSource(
  workflow: object,
  raw: object,
  workflowPath: string,
): void {
  registerWorkflowStepFragmentErrorContext(
    workflow,
    provenanceByRawWorkflow.get(raw) ?? [],
    raw,
    workflowPath,
  );
  attachWorkflowConfigErrorTranslator(
    workflow,
    (target, error) => translateWorkflowStepFragmentError(target as WorkflowConfig, error),
  );
}

export function annotateWorkflowConfigFragmentError(error: unknown, workflow: object): Error {
  return translateWorkflowStepFragmentError(workflow as WorkflowConfig, error);
}

function findFragmentErrorProvenance(
  issuePath: readonly PropertyKey[],
  provenance: readonly WorkflowStepFragmentProvenance[],
) : { source: WorkflowStepFragmentProvenance; workflowDefined: boolean } | undefined {
  const exactSource = findFragmentProvenanceAtExactPath(provenance, issuePath);
  const source = exactSource ?? findFragmentProvenanceForStep(provenance, issuePath);
  if (!source) {
    return undefined;
  }
  return { source, workflowDefined: exactSource === undefined };
}
