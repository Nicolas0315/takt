import { describe, expect, it } from 'vitest';
import {
  WorkflowConfigError,
  withWorkflowConfigErrorPath,
} from '../core/workflow/workflow-config-error.js';
import { findWorkflowStepLocation } from '../core/workflow/workflow-step-location.js';

describe('workflow configuration error boundaries', () => {
  it('retains an immutable normalized path and the original cause', () => {
    const cause = new Error('invalid provider');
    const sourcePath = ['steps', 0, 'provider'] as PropertyKey[];

    const error = new WorkflowConfigError(cause, sourcePath);
    sourcePath.push('model');

    expect(error.cause).toBe(cause);
    expect(error.path).toEqual(['steps', 0, 'provider']);
    expect(Object.isFrozen(error.path)).toBe(true);
    expect(() => (error.path as PropertyKey[]).push('model')).toThrow();
  });

  it('wraps a more specific normalized path without mutating the original error', () => {
    const error = new WorkflowConfigError(new Error('invalid provider'), ['steps', 0]);

    const annotated = withWorkflowConfigErrorPath(error, ['steps', 0, 'overrides', 'provider']);

    expect(annotated).not.toBe(error);
    expect(annotated.cause).toBe(error);
    expect(error.path).toEqual(['steps', 0]);
    expect(annotated.path).toEqual(['steps', 0, 'overrides', 'provider']);
  });

  it('does not replace a specific normalized path with a less specific path', () => {
    const error = new WorkflowConfigError(new Error('invalid provider'), ['steps', 0, 'overrides', 'provider']);

    withWorkflowConfigErrorPath(error, ['steps', 0]);

    expect(error.path).toEqual(['steps', 0, 'overrides', 'provider']);
  });

  it('locates a parallel sub-step without reading raw workflow metadata', () => {
    const subStep = { name: 'review' };
    const config = {
      steps: [{ name: 'reviewers', parallel: [subStep] }],
    };

    expect(findWorkflowStepLocation(config, subStep)).toEqual(['steps', 0, 'parallel', 0]);
  });

});
