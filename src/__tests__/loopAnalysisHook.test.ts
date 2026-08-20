import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
// Module under test is implemented in the following `implement` step.
import { onRunTerminal } from '../features/tasks/execute/loopAnalysisHook.js';

/**
 * Contracts covered (order.md §2/§5, plan.md C2/C5):
 * - a terminal source run spawns the builtin loop-analysis workflow detached when enabled
 * - the launch never blocks or fails the source run; the env marker suppresses recursion
 * - with `output: pr-comment`, the finished analysis run posts its final report content
 *   to the source branch PR; without a PR the report stays file-only
 * - PR posting additionally requires the source run's resolved auto_pr marker
 *   (`TAKT_LOOP_ANALYSIS_SOURCE_AUTO_PR`); without it no PR lookup ever happens
 * - the PR lookup tolerates post-execution PR creation via a bounded retry and gives
 *   up (file-only) once the bound is exhausted
 * - the dispatch is claimed per source run, so duplicate terminal paths for the same
 *   run (force-fail followed by the normal terminal, or a repeated force-fail) spawn
 *   at most one analysis run
 * - stale internal markers in the parent environment never leak into the analysis
 *   child env; only the intended marker values are set
 *
 * Every dependency (spawn, env, git provider, config resolver, report reader, sleep,
 * logger) is a test double, so this stays in the unit gate.
 */

const PROJECT_CWD = '/project';
const SOURCE_RUN_ROOT = '/project/.takt/runs/source-run';
const SOURCE_REPORTS_DIR = '/project/.takt/runs/source-run/reports';
const ANALYSIS_RUN_ROOT = '/project/.takt/runs/loop-analysis-run';
const ANALYSIS_REPORTS_DIR = '/project/.takt/runs/loop-analysis-run/reports';
const SOURCE_BRANCH = 'feature/source';
const REPORT_CONTENT = '# Loop analysis report\n\nAdopted proposals and rejected proposals.';

function createDeps(overrides: Record<string, unknown> = {}) {
  const child = { on: vi.fn(), unref: vi.fn() };
  const deps = {
    resolveConfig: vi.fn(() => ({ enabled: true, output: 'file' as const })),
    spawn: vi.fn(() => child),
    env: {} as Record<string, string | undefined>,
    gitProvider: {
      findExistingPr: vi.fn(() => undefined),
      commentOnPr: vi.fn(() => ({ success: true })),
    },
    readFile: vi.fn(() => REPORT_CONTENT),
    sleep: vi.fn(async () => {}),
    logger: { error: vi.fn() },
    claimDispatch: vi.fn((_runRootAbs: string) => true),
    ...overrides,
  };
  return { deps, child };
}

function createInput(overrides: Record<string, unknown> = {}) {
  return {
    projectCwd: PROJECT_CWD,
    runRootAbs: SOURCE_RUN_ROOT,
    reportsAbs: SOURCE_REPORTS_DIR,
    status: 'completed',
    gitBranch: SOURCE_BRANCH,
    ...overrides,
  };
}

function createAnalysisRunEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    TAKT_LOOP_ANALYSIS_RUN: '1',
    TAKT_LOOP_ANALYSIS_SOURCE_BRANCH: SOURCE_BRANCH,
    TAKT_LOOP_ANALYSIS_SOURCE_AUTO_PR: '1',
    ...overrides,
  };
}

describe('loop-analysis run-terminal hook', () => {
  it.each(['completed', 'failed', 'cancelled'] as const)(
    'Given loop_analysis enabled, When a run finishes with status %s, Then the analysis run is spawned detached with the source run markers',
    async (status) => {
      const { deps, child } = createDeps();

      await onRunTerminal(deps, createInput({ status }));

      expect(deps.spawn).toHaveBeenCalledTimes(1);
      const [command, args, options] = deps.spawn.mock.calls[0] ?? [];
      expect(command).toBe(process.execPath);
      expect(args[0]).toBe(process.argv[1]);
      const taskIndex = args.indexOf('--task');
      expect(taskIndex).toBeGreaterThanOrEqual(0);
      expect(args[taskIndex + 1]).toContain(SOURCE_RUN_ROOT);
      const workflowIndex = args.indexOf('--workflow');
      expect(workflowIndex).toBeGreaterThanOrEqual(0);
      expect(args[workflowIndex + 1]).toBe('loop-analysis');
      expect(options).toMatchObject({ cwd: PROJECT_CWD, detached: true, stdio: 'ignore' });
      expect(options.env).toMatchObject({
        TAKT_LOOP_ANALYSIS_RUN: '1',
        TAKT_LOOP_ANALYSIS_SOURCE_RUN_DIR: SOURCE_RUN_ROOT,
        TAKT_LOOP_ANALYSIS_SOURCE_BRANCH: SOURCE_BRANCH,
      });
      expect(child.on).toHaveBeenCalledWith('error', expect.any(Function));
      expect(child.unref).toHaveBeenCalledTimes(1);
    },
  );

  it('Given loop_analysis enabled, When the analysis run is spawned, Then the child inherits the parent environment', async () => {
    const { deps } = createDeps({ env: { TAKT_CONFIG_DIR: '/global-config' } });

    await onRunTerminal(deps, createInput());

    const [, , options] = deps.spawn.mock.calls[0] ?? [];
    expect(options.env.TAKT_CONFIG_DIR).toBe('/global-config');
  });

  it('Given the source run resolved auto_pr, When the analysis run is spawned, Then the auto-pr marker is handed to the child', async () => {
    const { deps } = createDeps();

    await onRunTerminal(deps, createInput({ sourceAutoPr: true }));

    const [, , options] = deps.spawn.mock.calls[0] ?? [];
    expect(options.env).toMatchObject({ TAKT_LOOP_ANALYSIS_SOURCE_AUTO_PR: '1' });
  });

  it('Given the source run did not resolve auto_pr, When the analysis run is spawned, Then the auto-pr marker is absent', async () => {
    const { deps } = createDeps();

    await onRunTerminal(deps, createInput());

    const [, , options] = deps.spawn.mock.calls[0] ?? [];
    expect(options.env.TAKT_LOOP_ANALYSIS_SOURCE_AUTO_PR).toBeUndefined();
  });

  it('Given the dispatch claim succeeds, When a run finishes, Then the claim is taken for the source run root before spawning', async () => {
    const { deps } = createDeps();

    await onRunTerminal(deps, createInput());

    expect(deps.claimDispatch).toHaveBeenCalledWith(SOURCE_RUN_ROOT);
    expect(deps.spawn).toHaveBeenCalledTimes(1);
  });

  it('Given the dispatch was already claimed, When another terminal path fires for the same run, Then no second analysis run is spawned', async () => {
    const { deps } = createDeps({ claimDispatch: vi.fn(() => false) });

    await expect(onRunTerminal(deps, createInput())).resolves.toBeUndefined();

    expect(deps.claimDispatch).toHaveBeenCalledWith(SOURCE_RUN_ROOT);
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it('Given stale internal markers in the parent environment and no branch or auto_pr input, When the analysis run is spawned, Then the stale markers are absent from the child env', async () => {
    const { deps } = createDeps({
      env: {
        TAKT_LOOP_ANALYSIS_SOURCE_AUTO_PR: '1',
        TAKT_LOOP_ANALYSIS_SOURCE_BRANCH: 'stale/branch',
        TAKT_CONFIG_DIR: '/global-config',
      },
    });

    await onRunTerminal(deps, createInput({ gitBranch: undefined }));

    const [, , options] = deps.spawn.mock.calls[0] ?? [];
    expect('TAKT_LOOP_ANALYSIS_SOURCE_AUTO_PR' in options.env).toBe(false);
    expect('TAKT_LOOP_ANALYSIS_SOURCE_BRANCH' in options.env).toBe(false);
    expect(options.env).toMatchObject({
      TAKT_LOOP_ANALYSIS_RUN: '1',
      TAKT_LOOP_ANALYSIS_SOURCE_RUN_DIR: SOURCE_RUN_ROOT,
      TAKT_CONFIG_DIR: '/global-config',
    });
  });

  it('Given stale internal markers in the parent environment and branch and auto_pr input, When the analysis run is spawned, Then the input values win over the stale markers', async () => {
    const { deps } = createDeps({
      env: {
        TAKT_LOOP_ANALYSIS_SOURCE_AUTO_PR: '0',
        TAKT_LOOP_ANALYSIS_SOURCE_BRANCH: 'stale/branch',
      },
    });

    await onRunTerminal(deps, createInput({ sourceAutoPr: true }));

    const [, , options] = deps.spawn.mock.calls[0] ?? [];
    expect(options.env).toMatchObject({
      TAKT_LOOP_ANALYSIS_SOURCE_BRANCH: SOURCE_BRANCH,
      TAKT_LOOP_ANALYSIS_SOURCE_AUTO_PR: '1',
    });
  });

  it('Given no loop_analysis section, When a run finishes, Then no analysis run is spawned', async () => {
    const { deps } = createDeps({ resolveConfig: vi.fn(() => undefined) });

    await onRunTerminal(deps, createInput());

    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it('Given loop_analysis disabled, When a run finishes, Then no analysis run is spawned', async () => {
    const { deps } = createDeps({
      resolveConfig: vi.fn(() => ({ enabled: false, output: 'file' as const })),
    });

    await onRunTerminal(deps, createInput());

    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it('Given the analysis-run marker env is present, When the analysis run itself finishes, Then it does not spawn another analysis run', async () => {
    const { deps } = createDeps({ env: { TAKT_LOOP_ANALYSIS_RUN: '1' } });

    await onRunTerminal(deps, createInput({
      runRootAbs: ANALYSIS_RUN_ROOT,
      reportsAbs: ANALYSIS_REPORTS_DIR,
    }));

    expect(deps.spawn).not.toHaveBeenCalled();
    expect(deps.gitProvider.findExistingPr).not.toHaveBeenCalled();
    expect(deps.gitProvider.commentOnPr).not.toHaveBeenCalled();
  });

  it('Given spawn throws, When launching the analysis run, Then the failure is logged and not propagated to the source run', async () => {
    const { deps } = createDeps({
      spawn: vi.fn(() => {
        throw new Error('spawn failed');
      }),
    });

    await expect(onRunTerminal(deps, createInput())).resolves.toBeUndefined();
    expect(deps.logger.error).toHaveBeenCalled();
  });

  it('Given pr-comment output and a finished analysis run whose auto_pr source branch has a PR, When the hook runs, Then the final report content is posted to the source PR unchanged', async () => {
    const findExistingPr = vi.fn(() => ({ number: 42, url: 'https://example.test/pr/42' }));
    const commentOnPr = vi.fn(() => ({ success: true }));
    const { deps } = createDeps({
      resolveConfig: vi.fn(() => ({ enabled: true, output: 'pr-comment' as const })),
      env: createAnalysisRunEnv(),
      gitProvider: { findExistingPr, commentOnPr },
    });

    await onRunTerminal(deps, createInput({
      runRootAbs: ANALYSIS_RUN_ROOT,
      reportsAbs: ANALYSIS_REPORTS_DIR,
      gitBranch: 'feature/analysis',
    }));

    expect(deps.spawn).not.toHaveBeenCalled();
    expect(deps.readFile).toHaveBeenCalledWith(join(ANALYSIS_REPORTS_DIR, 'loop-analysis.md'));
    expect(findExistingPr).toHaveBeenCalledWith(SOURCE_BRANCH, PROJECT_CWD);
    expect(commentOnPr).toHaveBeenCalledWith(42, REPORT_CONTENT, PROJECT_CWD);
  });

  it('Given pr-comment output but no auto-pr marker, When the analysis run finishes and the source branch has a PR, Then no comment is posted and no PR lookup happens', async () => {
    const findExistingPr = vi.fn(() => ({ number: 42, url: 'https://example.test/pr/42' }));
    const commentOnPr = vi.fn(() => ({ success: true }));
    const { deps } = createDeps({
      resolveConfig: vi.fn(() => ({ enabled: true, output: 'pr-comment' as const })),
      env: {
        TAKT_LOOP_ANALYSIS_RUN: '1',
        TAKT_LOOP_ANALYSIS_SOURCE_BRANCH: SOURCE_BRANCH,
      },
      gitProvider: { findExistingPr, commentOnPr },
    });

    await onRunTerminal(deps, createInput({
      runRootAbs: ANALYSIS_RUN_ROOT,
      reportsAbs: ANALYSIS_REPORTS_DIR,
    }));

    expect(findExistingPr).not.toHaveBeenCalled();
    expect(commentOnPr).not.toHaveBeenCalled();
  });

  it('Given pr-comment output but no PR for the source branch, When the analysis run finishes, Then the lookup retries within the bound and no comment is posted', async () => {
    const findExistingPr = vi.fn(() => undefined);
    const commentOnPr = vi.fn(() => ({ success: true }));
    const { deps } = createDeps({
      resolveConfig: vi.fn(() => ({ enabled: true, output: 'pr-comment' as const })),
      env: createAnalysisRunEnv(),
      gitProvider: { findExistingPr, commentOnPr },
    });

    await expect(onRunTerminal(deps, createInput({
      runRootAbs: ANALYSIS_RUN_ROOT,
      reportsAbs: ANALYSIS_REPORTS_DIR,
    }))).resolves.toBeUndefined();
    expect(findExistingPr).toHaveBeenCalledTimes(4);
    expect(deps.sleep).toHaveBeenCalledTimes(3);
    expect(commentOnPr).not.toHaveBeenCalled();
  });

  it('Given the source PR appears after the analysis run finishes, When the retry finds it, Then the final report is posted to that PR', async () => {
    const findExistingPr = vi.fn()
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(undefined)
      .mockReturnValue({ number: 42, url: 'https://example.test/pr/42' });
    const commentOnPr = vi.fn(() => ({ success: true }));
    const { deps } = createDeps({
      resolveConfig: vi.fn(() => ({ enabled: true, output: 'pr-comment' as const })),
      env: createAnalysisRunEnv(),
      gitProvider: { findExistingPr, commentOnPr },
    });

    await onRunTerminal(deps, createInput({
      runRootAbs: ANALYSIS_RUN_ROOT,
      reportsAbs: ANALYSIS_REPORTS_DIR,
    }));

    expect(findExistingPr).toHaveBeenCalledTimes(3);
    expect(deps.sleep).toHaveBeenCalledTimes(2);
    expect(commentOnPr).toHaveBeenCalledWith(42, REPORT_CONTENT, PROJECT_CWD);
  });

  it('Given file output, When the analysis run finishes, Then no PR lookup or comment happens', async () => {
    const findExistingPr = vi.fn(() => ({ number: 42, url: 'https://example.test/pr/42' }));
    const commentOnPr = vi.fn(() => ({ success: true }));
    const { deps } = createDeps({
      env: createAnalysisRunEnv(),
      gitProvider: { findExistingPr, commentOnPr },
    });

    await onRunTerminal(deps, createInput({
      runRootAbs: ANALYSIS_RUN_ROOT,
      reportsAbs: ANALYSIS_REPORTS_DIR,
    }));

    expect(findExistingPr).not.toHaveBeenCalled();
    expect(commentOnPr).not.toHaveBeenCalled();
  });

  it('Given pr-comment output but no source branch marker, When the analysis run finishes, Then no comment is posted', async () => {
    const findExistingPr = vi.fn(() => ({ number: 42, url: 'https://example.test/pr/42' }));
    const commentOnPr = vi.fn(() => ({ success: true }));
    const { deps } = createDeps({
      resolveConfig: vi.fn(() => ({ enabled: true, output: 'pr-comment' as const })),
      env: {
        TAKT_LOOP_ANALYSIS_RUN: '1',
        TAKT_LOOP_ANALYSIS_SOURCE_AUTO_PR: '1',
      },
      gitProvider: { findExistingPr, commentOnPr },
    });

    await onRunTerminal(deps, createInput({
      runRootAbs: ANALYSIS_RUN_ROOT,
      reportsAbs: ANALYSIS_REPORTS_DIR,
    }));

    expect(findExistingPr).not.toHaveBeenCalled();
    expect(commentOnPr).not.toHaveBeenCalled();
  });

  it('Given pr-comment output, When the source run finishes, Then it launches the analysis run and does not comment on any PR itself', async () => {
    const findExistingPr = vi.fn(() => ({ number: 42, url: 'https://example.test/pr/42' }));
    const commentOnPr = vi.fn(() => ({ success: true }));
    const { deps } = createDeps({
      resolveConfig: vi.fn(() => ({ enabled: true, output: 'pr-comment' as const })),
      gitProvider: { findExistingPr, commentOnPr },
    });

    await onRunTerminal(deps, createInput());

    expect(deps.spawn).toHaveBeenCalledTimes(1);
    expect(findExistingPr).not.toHaveBeenCalled();
    expect(commentOnPr).not.toHaveBeenCalled();
  });

  it('Given no loop_analysis section, When an analysis run finishes, Then nothing is launched or posted', async () => {
    const { deps } = createDeps({
      resolveConfig: vi.fn(() => undefined),
      env: createAnalysisRunEnv(),
    });

    await onRunTerminal(deps, createInput({
      runRootAbs: ANALYSIS_RUN_ROOT,
      reportsAbs: ANALYSIS_REPORTS_DIR,
    }));

    expect(deps.spawn).not.toHaveBeenCalled();
    expect(deps.gitProvider.findExistingPr).not.toHaveBeenCalled();
    expect(deps.gitProvider.commentOnPr).not.toHaveBeenCalled();
  });

  it('Given the report file cannot be read, When posting to the PR, Then the failure is logged and no comment is posted', async () => {
    const commentOnPr = vi.fn(() => ({ success: true }));
    const { deps } = createDeps({
      resolveConfig: vi.fn(() => ({ enabled: true, output: 'pr-comment' as const })),
      env: createAnalysisRunEnv(),
      gitProvider: {
        findExistingPr: vi.fn(() => ({ number: 42, url: 'https://example.test/pr/42' })),
        commentOnPr,
      },
      readFile: vi.fn(() => {
        throw new Error('read failed');
      }),
    });

    await expect(onRunTerminal(deps, createInput({
      runRootAbs: ANALYSIS_RUN_ROOT,
      reportsAbs: ANALYSIS_REPORTS_DIR,
    }))).resolves.toBeUndefined();
    expect(commentOnPr).not.toHaveBeenCalled();
    expect(deps.logger.error).toHaveBeenCalled();
  });

  it('Given posting the comment throws, When the analysis run finishes, Then the failure is logged and not propagated', async () => {
    const { deps } = createDeps({
      resolveConfig: vi.fn(() => ({ enabled: true, output: 'pr-comment' as const })),
      env: createAnalysisRunEnv(),
      gitProvider: {
        findExistingPr: vi.fn(() => ({ number: 42, url: 'https://example.test/pr/42' })),
        commentOnPr: vi.fn(() => {
          throw new Error('comment failed');
        }),
      },
    });

    await expect(onRunTerminal(deps, createInput({
      runRootAbs: ANALYSIS_RUN_ROOT,
      reportsAbs: ANALYSIS_REPORTS_DIR,
    }))).resolves.toBeUndefined();
    expect(deps.logger.error).toHaveBeenCalled();
  });
});
