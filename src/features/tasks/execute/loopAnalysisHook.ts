/**
 * Post-run loop analysis hook (order.md §2/§5).
 *
 * When `loop_analysis.enabled` is set in runtime.yaml, every terminal workflow run
 * (completed / failed / cancelled) spawns the builtin `loop-analysis` workflow as a
 * detached child process. The marker env `TAKT_LOOP_ANALYSIS_RUN=1` both suppresses
 * recursion and routes the analysis run's own termination to the PR-comment path:
 * with `output: pr-comment`, the finished analysis run posts its final report verbatim
 * to the source branch's PR. Every failure is logged and swallowed so the source run's
 * outcome is never affected.
 *
 * PR comment eligibility (order.md §5) is gated on the source run's resolved `auto_pr`:
 * only a source run with `auto_pr: true` hands the `TAKT_LOOP_ANALYSIS_SOURCE_AUTO_PR`
 * marker to the analysis run, and the analysis run posts solely when that marker is
 * present. The source run creates its PR after the run finishes, so the PR lookup runs
 * on a bounded retry instead of a single shot; when no PR appears within the bound the
 * report stays file-only.
 */

import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { getGitProvider, type GitProvider } from '../../../infra/git/index.js';
import { getGlobalConfigDir, getProjectConfigDir } from '../../../infra/config/paths.js';
import { resolveRuntimeProviderFile } from '../../../infra/config/runtime-provider/loader.js';
import type { RuntimeLoopAnalysis } from '../../../infra/config/runtime-provider/schema.js';
import type { WorkflowRunTerminalStatus } from './workflowTerminalStatus.js';

const LOOP_ANALYSIS_RUN_ENV = 'TAKT_LOOP_ANALYSIS_RUN';
const LOOP_ANALYSIS_SOURCE_RUN_DIR_ENV = 'TAKT_LOOP_ANALYSIS_SOURCE_RUN_DIR';
const LOOP_ANALYSIS_SOURCE_BRANCH_ENV = 'TAKT_LOOP_ANALYSIS_SOURCE_BRANCH';
const LOOP_ANALYSIS_SOURCE_AUTO_PR_ENV = 'TAKT_LOOP_ANALYSIS_SOURCE_AUTO_PR';

const LOOP_ANALYSIS_WORKFLOW_NAME = 'loop-analysis';
const LOOP_ANALYSIS_REPORT_FILENAME = 'loop-analysis.md';

/** Internal markers that must never leak from the parent environment into the analysis child. */
const LOOP_ANALYSIS_INTERNAL_MARKER_ENVS = [
  LOOP_ANALYSIS_RUN_ENV,
  LOOP_ANALYSIS_SOURCE_RUN_DIR_ENV,
  LOOP_ANALYSIS_SOURCE_BRANCH_ENV,
  LOOP_ANALYSIS_SOURCE_AUTO_PR_ENV,
] as const;

/**
 * Run-root marker that makes the analysis dispatch at-most-once per run across
 * processes (normal terminal, bootstrap failure, and force-fail each fire the hook,
 * possibly from different processes).
 */
const LOOP_ANALYSIS_DISPATCH_CLAIM_FILENAME = 'loop-analysis-dispatch.claim';

/** Bounded wait for the source run's post-execution PR creation (initial attempt + 3 retries). */
const PR_LOOKUP_MAX_ATTEMPTS = 4;
const PR_LOOKUP_INTERVAL_MS = 20_000;

export interface LoopAnalysisSpawnedProcess {
  on(event: 'error', listener: (error: Error) => void): unknown;
  unref(): unknown;
}

export type LoopAnalysisSpawn = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    detached: boolean;
    stdio: 'ignore';
    env: Record<string, string | undefined>;
  },
) => LoopAnalysisSpawnedProcess;

export interface LoopAnalysisHookDeps {
  readonly resolveConfig: () => RuntimeLoopAnalysis | undefined;
  readonly spawn: LoopAnalysisSpawn;
  readonly env: Record<string, string | undefined>;
  readonly gitProvider: Pick<GitProvider, 'findExistingPr' | 'commentOnPr'>;
  readonly readFile: (path: string) => string;
  readonly sleep: (ms: number) => Promise<void>;
  readonly logger: { error(message: string, data?: unknown): void };
  readonly claimDispatch: (runRootAbs: string) => boolean;
}

export interface LoopAnalysisRunTerminalInput {
  readonly projectCwd: string;
  readonly runRootAbs: string;
  readonly reportsAbs: string;
  readonly status: WorkflowRunTerminalStatus;
  readonly gitBranch?: string;
  readonly sourceAutoPr?: boolean;
}

export async function onRunTerminal(
  deps: LoopAnalysisHookDeps,
  input: LoopAnalysisRunTerminalInput,
): Promise<void> {
  try {
    const config = deps.resolveConfig();
    if (config === undefined || !config.enabled) {
      return;
    }
    if (deps.env[LOOP_ANALYSIS_RUN_ENV] === '1') {
      await postAnalysisReportToSourcePr(deps, input, config);
      return;
    }
    launchAnalysisRun(deps, input);
  } catch (error) {
    deps.logger.error('Loop analysis hook failed', { error: getErrorMessage(error) });
  }
}

function launchAnalysisRun(
  deps: LoopAnalysisHookDeps,
  input: LoopAnalysisRunTerminalInput,
): void {
  const entrypoint = process.argv[1];
  if (entrypoint === undefined) {
    throw new Error('Loop analysis run requires the CLI entrypoint path in process.argv[1]');
  }
  if (!deps.claimDispatch(input.runRootAbs)) {
    return;
  }
  const task = buildLoopAnalysisTask(input.runRootAbs);
  const child = deps.spawn(
    process.execPath,
    [entrypoint, '--task', task, '--workflow', LOOP_ANALYSIS_WORKFLOW_NAME],
    {
      cwd: input.projectCwd,
      detached: true,
      stdio: 'ignore',
      env: buildAnalysisChildEnv(deps, input),
    },
  );
  // A spawn failure surfaces as an 'error' event; without a listener it would crash the CLI.
  child.on('error', (error) => {
    deps.logger.error('Loop analysis run failed to start', { error: error.message });
  });
  child.unref();
}

/**
 * The child env is a process-boundary input: internal markers are stripped from the
 * inherited parent environment first, then only the intended values are set, so a
 * stale `TAKT_LOOP_ANALYSIS_*` marker in the parent can never leak into the analysis
 * run and flip its post-run PR-comment gate.
 */
function buildAnalysisChildEnv(
  deps: LoopAnalysisHookDeps,
  input: LoopAnalysisRunTerminalInput,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...deps.env };
  for (const marker of LOOP_ANALYSIS_INTERNAL_MARKER_ENVS) {
    delete env[marker];
  }
  env[LOOP_ANALYSIS_RUN_ENV] = '1';
  env[LOOP_ANALYSIS_SOURCE_RUN_DIR_ENV] = input.runRootAbs;
  if (input.gitBranch !== undefined) {
    env[LOOP_ANALYSIS_SOURCE_BRANCH_ENV] = input.gitBranch;
  }
  if (input.sourceAutoPr === true) {
    env[LOOP_ANALYSIS_SOURCE_AUTO_PR_ENV] = '1';
  }
  return env;
}

async function postAnalysisReportToSourcePr(
  deps: LoopAnalysisHookDeps,
  input: LoopAnalysisRunTerminalInput,
  config: RuntimeLoopAnalysis,
): Promise<void> {
  if (deps.env[LOOP_ANALYSIS_SOURCE_AUTO_PR_ENV] !== '1') {
    return;
  }
  if (config.output !== 'pr-comment') {
    return;
  }
  const sourceBranch = deps.env[LOOP_ANALYSIS_SOURCE_BRANCH_ENV];
  if (sourceBranch === undefined || sourceBranch === '') {
    return;
  }
  const report = deps.readFile(join(input.reportsAbs, LOOP_ANALYSIS_REPORT_FILENAME));
  const pr = await findSourcePrWithRetry(deps, sourceBranch, input.projectCwd);
  if (pr === undefined) {
    return;
  }
  deps.gitProvider.commentOnPr(pr.number, report, input.projectCwd);
}

/**
 * The source run creates its PR in post-execution, after the analysis run is already
 * detached. Poll on a bounded schedule so a PR that appears shortly after the analysis
 * finishes still receives the report; when no PR appears within the bound, the report
 * stays file-only.
 */
async function findSourcePrWithRetry(
  deps: LoopAnalysisHookDeps,
  sourceBranch: string,
  projectCwd: string,
): Promise<ReturnType<GitProvider['findExistingPr']>> {
  for (let attempt = 1; attempt <= PR_LOOKUP_MAX_ATTEMPTS; attempt += 1) {
    const pr = deps.gitProvider.findExistingPr(sourceBranch, projectCwd);
    if (pr !== undefined) {
      return pr;
    }
    if (attempt < PR_LOOKUP_MAX_ATTEMPTS) {
      await deps.sleep(PR_LOOKUP_INTERVAL_MS);
    }
  }
  return undefined;
}

function buildLoopAnalysisTask(runRootAbs: string): string {
  return [
    `Analyze the finished workflow run stored at "${runRootAbs}" and propose prompt improvements that reduce unnecessary loops.`,
    'The run directory contains the session logs under "logs/" (JSONL), "trace.md", and the reports under "reports/".',
  ].join('\n');
}

const log = createLogger('loopAnalysis');

/**
 * Production dispatch claim: exclusively create a marker file in the source run
 * directory. The first terminal path to claim wins; every later terminal path for
 * the same run (any process) observes EEXIST and skips the dispatch. A spawn
 * failure after a successful claim is not retried (at-most-once); claim failures
 * other than EEXIST propagate to the hook's catch, which logs and swallows them.
 */
export function claimLoopAnalysisDispatch(runRootAbs: string): boolean {
  try {
    const fd = openSync(join(runRootAbs, LOOP_ANALYSIS_DISPATCH_CLAIM_FILENAME), 'wx', 0o600);
    closeSync(fd);
    return true;
  } catch (error) {
    if (isFileSystemErrorWithCode(error, 'EEXIST')) {
      return false;
    }
    throw error;
  }
}

function isFileSystemErrorWithCode(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error
    && 'code' in error
    && error.code === code;
}

/** Production wiring: build the real dependencies and fire the terminal hook. */
export async function launchLoopAnalysisOnRunTerminal(
  input: LoopAnalysisRunTerminalInput,
): Promise<void> {
  try {
    await onRunTerminal(
      {
        resolveConfig: () => resolveRuntimeProviderFile({
          globalConfigDir: getGlobalConfigDir(),
          projectConfigDir: getProjectConfigDir(input.projectCwd),
        })?.loop_analysis,
        spawn,
        env: process.env,
        gitProvider: getGitProvider(),
        readFile: (path) => readFileSync(path, 'utf-8'),
        sleep: (ms) => new Promise((resolve) => {
          setTimeout(resolve, ms);
        }),
        logger: log,
        claimDispatch: claimLoopAnalysisDispatch,
      },
      input,
    );
  } catch (error) {
    log.error('Loop analysis hook failed', { error: getErrorMessage(error) });
  }
}
