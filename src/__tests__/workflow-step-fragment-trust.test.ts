import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { invalidateAllResolvedConfigCache, invalidateGlobalConfigCache } from '../infra/config/index.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';

function write(root: string, relativePath: string, content: string): string {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf-8');
  return path;
}

describe('step fragment trust boundaries', () => {
  let projectDir: string;
  let configDir: string;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'takt-fragment-trust-project-'));
    configDir = mkdtempSync(join(tmpdir(), 'takt-fragment-trust-config-'));
    previousConfigDir = process.env.TAKT_CONFIG_DIR;
    process.env.TAKT_CONFIG_DIR = configDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
    if (previousConfigDir === undefined) delete process.env.TAKT_CONFIG_DIR;
    else process.env.TAKT_CONFIG_DIR = previousConfigDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  it.each([
    ['top-level step', '  - uses: "@owner/repo/unsafe"\n    name: review', 'instruction: review\nallow_git_commit: true\nrules:\n  - condition: done\n    next: COMPLETE\n'],
    ['parallel parent', '  - uses: "@owner/repo/unsafe"\n    name: reviewers', 'allow_git_commit: true\nparallel:\n  - name: review\n    instruction: review\n'],
    ['parallel sub-step', '  - name: reviewers\n    parallel:\n      - uses: "@owner/repo/unsafe"\n        name: review', 'instruction: review\nallow_git_commit: true\n'],
  ])('rejects low-trust allow_git_commit from a %s', (_placement, steps, fragment) => {
    const fragmentPath = write(configDir, 'repertoire/@owner/repo/steps/unsafe.yaml', fragment);
    const workflowPath = write(projectDir, '.takt/workflows/default.yaml', [
      'name: default',
      'initial_step: review',
      'max_steps: 1',
      'steps:',
      steps,
      '',
    ].join('\n'));

    expect(() => loadWorkflowFromFile(workflowPath, projectDir)).toThrow('allow_git_commit from step fragment "@owner/repo/unsafe"');
    expect(() => loadWorkflowFromFile(workflowPath, projectDir)).toThrow(fragmentPath);
  });

  it('allows a project workflow to override a low-trust allow_git_commit value', () => {
    write(configDir, 'repertoire/@owner/repo/steps/unsafe.yaml', [
      'instruction: review',
      'allow_git_commit: true',
      'rules:',
      '  - condition: done',
      '    next: COMPLETE',
      '',
    ].join('\n'));
    const workflowPath = write(projectDir, '.takt/workflows/default.yaml', [
      'name: default',
      'initial_step: review',
      'max_steps: 1',
      'steps:',
      '  - uses: "@owner/repo/unsafe"',
      '    name: review',
      '    allow_git_commit: false',
      '',
    ].join('\n'));

    expect(loadWorkflowFromFile(workflowPath, projectDir).steps[0]).toMatchObject({ allowGitCommit: false });
  });

  it('rejects allow_git_commit inherited through nested low-trust fragments', () => {
    const fragmentPath = write(configDir, 'repertoire/@owner/repo/steps/base.yaml', 'instruction: review\nallow_git_commit: true\n');
    write(configDir, 'repertoire/@owner/repo/steps/unsafe.yaml', 'uses: "@owner/repo/base"\n');
    const workflowPath = write(projectDir, '.takt/workflows/default.yaml', [
      'name: default',
      'initial_step: review',
      'max_steps: 1',
      'steps:',
      '  - uses: "@owner/repo/unsafe"',
      '    name: review',
      '',
    ].join('\n'));

    expect(() => loadWorkflowFromFile(workflowPath, projectDir)).toThrow(`allow_git_commit from step fragment "@owner/repo/base" at ${fragmentPath}`);
  });
});
