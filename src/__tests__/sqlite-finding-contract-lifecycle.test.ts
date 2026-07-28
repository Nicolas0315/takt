import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkflowConfig } from '../core/models/index.js';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import { createSqliteFindingContractLifecycle } from '../features/tasks/execute/sqliteFindingContractLifecycle.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createProject(): string {
  const projectCwd = mkdtempSync(join(tmpdir(), 'takt-sqlite-fc-lifecycle-'));
  directories.push(projectCwd);
  return projectCwd;
}

function workflowConfig(): WorkflowConfig {
  return {
    name: 'sqlite-finding-contract',
    initialStep: 'review',
    maxSteps: 1,
    steps: [],
    findingContract: {
      backend: 'sqlite',
      ledgerPath: '.takt/findings/unused.json',
      rawFindingsPath: '.takt/findings/unused',
      manager: {
        persona: 'findings-manager',
        instruction: 'Reconcile.',
        outputContract: 'Return JSON.',
      },
    },
  };
}

function createLifecycle(projectCwd: string, slug: string, sourceRunSlug?: string) {
  const runPaths = buildRunPaths(projectCwd, slug);
  mkdirSync(runPaths.runRootAbs, { recursive: true });
  return createSqliteFindingContractLifecycle({
    runPaths,
    workflowConfig: workflowConfig(),
    abortController: new AbortController(),
    ...(sourceRunSlug === undefined
      ? {}
      : { resumeSource: { sourceRunSlug, resumeMode: 'retry' as const } }),
  });
}

describe('SQLite Finding Contract lifecycle', () => {
  it('creates new run storage and reopens the same run storage on continuation', async () => {
    const projectCwd = createProject();
    const first = createLifecycle(projectCwd, 'run-new');
    const findingRunId = first.findingRunId;
    expect(findingRunId).not.toBe('run-new');
    await first.store.updateLedger((current) => ({
      ledger: { ...current, nextId: 2 },
      result: undefined,
    }));
    first.dispose();

    expect(existsSync(join(
      buildRunPaths(projectCwd, 'run-new').runRootAbs,
      'run.sqlite',
    ))).toBe(true);

    const continued = createLifecycle(projectCwd, 'run-new');
    expect(continued.findingRunId).toBe(findingRunId);
    expect(continued.store.loadLedger().nextId).toBe(2);
    continued.dispose();
  });

  it('allows direct resume to continue the existing database for the same run slug', async () => {
    const projectCwd = createProject();
    const first = createLifecycle(projectCwd, 'run-continuation');
    const findingRunId = first.findingRunId;
    await first.store.updateLedger((current) => ({
      ledger: { ...current, nextId: 4 },
      result: undefined,
    }));
    first.dispose();

    const continued = createLifecycle(
      projectCwd,
      'run-continuation',
      'run-continuation',
    );
    expect(continued.findingRunId).toBe(findingRunId);
    expect(continued.store.loadLedger().nextId).toBe(4);
    continued.dispose();
  });

  it('resumes Finding ledger provenance from the source run database', async () => {
    const projectCwd = createProject();
    const source = createLifecycle(projectCwd, 'run-source');
    await source.store.updateLedger((current) => ({
      ledger: { ...current, nextId: 7 },
      result: undefined,
    }));
    source.dispose();

    const resumed = createLifecycle(projectCwd, 'run-target', 'run-source');
    expect(resumed.store.loadLedger().nextId).toBe(7);
    resumed.dispose();
  });

  it('validates an existing target database against the specified direct source identity', () => {
    const projectCwd = createProject();
    const source = createLifecycle(projectCwd, 'run-source');
    source.dispose();
    const otherSource = createLifecycle(projectCwd, 'run-other-source');
    otherSource.dispose();

    const resumed = createLifecycle(projectCwd, 'run-target', 'run-source');
    resumed.dispose();

    const continued = createLifecycle(projectCwd, 'run-target', 'run-source');
    continued.dispose();
    expect(() => createLifecycle(
      projectCwd,
      'run-target',
      'run-other-source',
    )).toThrow(/direct resume source does not match/);
  });

  it('rejects an existing target database without direct resume provenance', () => {
    const projectCwd = createProject();
    const source = createLifecycle(projectCwd, 'run-source');
    source.dispose();
    const target = createLifecycle(projectCwd, 'run-target');
    target.dispose();

    expect(() => createLifecycle(
      projectCwd,
      'run-target',
      'run-source',
    )).toThrow(/direct resume source does not match/);
  });

  it('fails fast when the resume source database is missing', () => {
    const projectCwd = createProject();

    expect(() => createLifecycle(
      projectCwd,
      'run-target',
      'missing-source',
    )).toThrow(/source database is missing/);
  });

  it('rejects an invalid resume source run slug before resolving its path', () => {
    const projectCwd = createProject();

    expect(() => createLifecycle(
      projectCwd,
      'run-target',
      '../run-source',
    )).toThrow(/source run slug is invalid/);
  });
});
