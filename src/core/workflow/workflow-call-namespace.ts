import {
  parseWorkflowExecutionOwnerIdentity,
  type WorkflowExecutionOwnerIdentity,
} from '../models/workflow-resume-contract.js';

// stepPath and childWorkflow keep their canonical encoded form: parsing
// validates canonicality, so raw equality equals decoded equality.
interface WorkflowCallNamespaceKey {
  readonly callInstance: number | '*';
  readonly stepPath: string;
  readonly childWorkflow: string;
}

const WORKFLOW_CALL_NAMESPACE_PATTERN = /^call-([1-9]\d*|\*)--step-([^/]+)--workflow-([^/]+)$/;

// Uppercase letters are folded to '~' + lowercase so distinct names cannot
// collide as directory names on case-insensitive filesystems (macOS, Windows).
// Escaping every '-' that starts the value or precedes another '-' keeps '--'
// out of encoded values and away from the structural marker boundaries, so the
// '--step-' / '--workflow-' delimiters always split a segment unambiguously.
function encodeSegmentValue(value: string): string {
  const caseFolded = value.replace(/~/g, '~~').replace(/[A-Z]/g, (char) => `~${char.toLowerCase()}`);
  return encodeURIComponent(caseFolded)
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/-(?=-)/g, '%2D')
    .replace(/^-/, '%2D');
}

function restoreCaseFolded(value: string): string | undefined {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (char !== '~') {
      result += char;
      continue;
    }
    const next = value[index + 1];
    if (next === '~') {
      result += '~';
      index += 1;
      continue;
    }
    if (next !== undefined && next >= 'a' && next <= 'z') {
      result += next.toUpperCase();
      index += 1;
      continue;
    }
    return undefined;
  }
  return result;
}

function decodeCanonicalSegmentValue(value: string): string | undefined {
  try {
    const restored = restoreCaseFolded(decodeURIComponent(value));
    return restored !== undefined && restored.length > 0 && encodeSegmentValue(restored) === value
      ? restored
      : undefined;
  } catch {
    return undefined;
  }
}

// The segment names the call relative to its enclosing workflow_call scope; the
// segments above it in the namespace path carry the rest of the call stack.
function localStepPathComponents(identity: WorkflowExecutionOwnerIdentity): string[] {
  let lastCallIndex = -1;
  identity.owners.forEach((owner, index) => {
    if (owner.kind === 'workflow_call') {
      lastCallIndex = index;
    }
  });
  return [
    ...identity.owners.slice(lastCallIndex + 1).map((owner) => owner.step),
    identity.step,
  ];
}

// encodeSegmentValue escapes '!', so a literal '!' can only be a component
// delimiter — step names containing '/' or '!' stay unambiguous.
function encodeStepPath(components: readonly string[]): string {
  return components.map(encodeSegmentValue).join('!');
}

function isCanonicalStepPath(encoded: string): boolean {
  return encoded.split('!').every((component) => decodeCanonicalSegmentValue(component) !== undefined);
}

export function isWorkflowCallNamespaceSegment(segment: string): boolean {
  return parseWorkflowCallNamespaceSegment(segment) !== undefined;
}

export function buildWorkflowCallNamespaceSegment(
  invocationIdentity: string,
  childWorkflow: string,
  callInstance: number | '*',
): string {
  const invocation = parseWorkflowExecutionOwnerIdentity(invocationIdentity);
  if (invocation === undefined) {
    throw new Error('Workflow-call namespace segment requires a canonical invocation identity');
  }
  if (childWorkflow.length === 0) {
    throw new Error('Workflow-call namespace segment requires a child workflow reference');
  }
  if (callInstance !== '*' && (!Number.isSafeInteger(callInstance) || callInstance < 1)) {
    throw new Error('Workflow-call namespace segment requires a positive call instance');
  }
  return `call-${callInstance}--step-${encodeStepPath(localStepPathComponents(invocation))}`
    + `--workflow-${encodeSegmentValue(childWorkflow)}`;
}

export function parseWorkflowCallNamespaceSegment(
  segment: string,
): WorkflowCallNamespaceKey | undefined {
  const match = WORKFLOW_CALL_NAMESPACE_PATTERN.exec(segment);
  if (match === null) {
    return undefined;
  }
  const callInstance = match[1] === '*' ? '*' : Number(match[1]);
  if (callInstance !== '*' && !Number.isSafeInteger(callInstance)) {
    return undefined;
  }
  const stepPath = match[2]!;
  const childWorkflow = match[3]!;
  if (!isCanonicalStepPath(stepPath) || decodeCanonicalSegmentValue(childWorkflow) === undefined) {
    return undefined;
  }
  return { callInstance, stepPath, childWorkflow };
}

function namespaceScopesMatch(a: WorkflowCallNamespaceKey, b: WorkflowCallNamespaceKey): boolean {
  return a.stepPath === b.stepPath && a.childWorkflow === b.childWorkflow;
}

export function workflowCallReportRequestSegmentsMatch(
  actual: string,
  requested: string,
): boolean {
  if (actual === requested) {
    return true;
  }
  const requestedKey = parseWorkflowCallNamespaceSegment(requested);
  const actualKey = parseWorkflowCallNamespaceSegment(actual);
  if (requestedKey === undefined || actualKey === undefined) {
    return false;
  }
  return requestedKey.callInstance === '*' && namespaceScopesMatch(requestedKey, actualKey);
}

export function workflowCallReportRequestPathsMatch(
  actual: readonly string[],
  requested: readonly string[],
): boolean {
  return actual.length === requested.length
    && actual.every((segment, index) => workflowCallReportRequestSegmentsMatch(segment, requested[index]!));
}

export type WorkflowCallNamespaceCorrespondenceProof =
  | { readonly matches: true }
  | { readonly matches: false; readonly reason: string };

function proveWorkflowCallRunNamespaceSegmentsCorrespond(
  source: string,
  target: string,
): WorkflowCallNamespaceCorrespondenceProof {
  if (source === target) {
    return { matches: true };
  }
  const sourceKey = parseWorkflowCallNamespaceSegment(source);
  const targetKey = parseWorkflowCallNamespaceSegment(target);
  if (sourceKey !== undefined && targetKey !== undefined) {
    return namespaceScopesMatch(sourceKey, targetKey)
      ? { matches: true }
      : { matches: false, reason: 'scope_mismatch' };
  }
  return { matches: false, reason: 'unsupported_namespace_format' };
}

export function proveWorkflowCallRunNamespacePathsCorrespond(
  source: readonly string[],
  target: readonly string[],
): WorkflowCallNamespaceCorrespondenceProof {
  if (source.length !== target.length) {
    return { matches: false, reason: 'namespace_depth_mismatch' };
  }
  for (let index = 0; index < source.length; index += 1) {
    const proof = proveWorkflowCallRunNamespaceSegmentsCorrespond(
      source[index]!,
      target[index]!,
    );
    if (!proof.matches) {
      return { matches: false, reason: `namespace_segment_${index}:${proof.reason}` };
    }
  }
  return { matches: true };
}
