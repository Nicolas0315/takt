import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { WorkflowEngine } from '../core/workflow/index.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';

function write(root: string, relativePath: string, content: string): string {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf-8');
  return path;
}

function validate(path: string, projectDir: string): string {
  try {
    new WorkflowEngine(loadWorkflowFromFile(path, projectDir), projectDir, 'test task', {
      projectCwd: projectDir,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      return JSON.parse(message).map((issue: { message: string }) => issue.message).join('\n');
    } catch {
      return message;
    }
  }
  throw new Error('Expected workflow validation to fail');
}

describe('workflow step fragment validator provenance', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'takt-step-validator-provenance-'));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('attributes an aggregate rule placement error to the fragment that provides the invalid rule', () => {
    const rulePath = write(projectDir, '.takt/steps/rules.yaml', [
      'instruction: review',
      'rules:',
      '  - condition: all("approved")',
      '    next: COMPLETE',
      '',
    ].join('\n'));
    write(projectDir, '.takt/steps/outer.yaml', 'uses: rules\npersona: reviewer\n');
    const workflowPath = write(projectDir, '.takt/workflows/default.yaml', [
      'name: default',
      'initial_step: review',
      'max_steps: 1',
      'steps:',
      '  - uses: outer',
      '    name: review',
      '',
    ].join('\n'));

    const message = validate(workflowPath, projectDir);

    expect(message).toContain('aggregate conditions');
    expect(message).toContain('step fragment "rules"');
    expect(message).toContain(rulePath);
    expect(message).not.toContain('step fragment "outer"');
  });

  it.each([
    {
      name: 'top-level step',
      step: '  - uses: outer\n    name: review',
      fragment: 'instruction: review\nrules:\n  - condition: approved\n    appendix: first\n    next: COMPLETE\n  - condition: approved\n    appendix: second\n    next: COMPLETE\n',
    },
    {
      name: 'parallel sub-step',
      step: '  - name: reviewers\n    parallel:\n      - uses: outer\n        name: review',
      fragment: 'instruction: review\nrules:\n  - condition: approved\n    appendix: first\n    next: COMPLETE\n  - condition: approved\n    appendix: second\n    next: COMPLETE\n',
    },
  ])('attributes a semantic appendix conflict in a $name to the fragment rule', ({ step, fragment }) => {
    const rulePath = write(projectDir, '.takt/steps/rules.yaml', fragment);
    write(projectDir, '.takt/steps/outer.yaml', 'uses: rules\npersona: reviewer\n');
    const workflowPath = write(projectDir, '.takt/workflows/default.yaml', [
      'name: default',
      'initial_step: review',
      'max_steps: 1',
      'steps:',
      step,
      '',
    ].join('\n'));

    const message = validate(workflowPath, projectDir);

    expect(message).toContain('Rules sharing semantic label "approved" must use the same appendix');
    expect(message).toContain('step fragment "rules"');
    expect(message).toContain(rulePath);
    expect(message).not.toContain('step fragment "outer"');
  });

  it.each([
    {
      name: 'top-level step',
      initialStep: 'review',
      step: '  - uses: review\n    name: review\n    rules:\n      - condition: all("approved")\n        next: COMPLETE',
    },
    {
      name: 'parallel sub-step',
      initialStep: 'reviewers',
      step: '  - name: reviewers\n    parallel:\n      - uses: review\n        name: review\n        rules:\n          - condition: all("approved")\n            next: COMPLETE',
    },
  ])('retains fragment context while identifying a caller rule override as workflow-defined in a $name', ({ initialStep, step }) => {
    const fragmentPath = write(projectDir, '.takt/steps/review.yaml', [
      'instruction: review',
      'rules:',
      '  - condition: approved',
      '    next: COMPLETE',
      '',
    ].join('\n'));
    const workflowPath = write(projectDir, '.takt/workflows/default.yaml', [
      'name: default',
      `initial_step: ${initialStep}`,
      'max_steps: 1',
      'steps:',
      step,
      '',
    ].join('\n'));

    const message = validate(workflowPath, projectDir);

    expect(message).toContain('aggregate conditions');
    expect(message).toContain(workflowPath);
    expect(message).toContain('step uses fragment "review"');
    expect(message).toContain(fragmentPath);
    expect(message).toContain('defined by the workflow');
  });
});
