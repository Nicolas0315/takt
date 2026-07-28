import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { WorkflowConfig } from '../../../core/models/index.js';
import type { FindingLedgerStore } from '../../../core/workflow/findings/store.js';
import type { RunPaths } from '../../../core/workflow/run/run-paths.js';
import type { RunResumeSource } from '../../../core/workflow/run/run-meta.js';
import { isValidReportDirName } from '../../../shared/utils/index.js';
import {
  createRunStorage,
  openRunStorage,
  resumeRunStorage,
  type LeaseHandle,
  type RunStorageRoot,
} from '../../../infra/run-storage/index.js';
import { throwAfterCleanup } from '../../../infra/run-storage/cleanup-error.js';

export const FINDING_CONTRACT_AUTHORITY_STEP_KEY = 'finding-contract-authority';

const RUN_STORAGE_DATABASE_FILE = 'run.sqlite';
const LEASE_DURATION_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 10_000;

export interface SqliteFindingContractLifecycle {
  readonly findingRunId: string;
  readonly store: FindingLedgerStore;
  dispose(): void;
}

interface SqliteFindingContractLifecycleOptions {
  readonly runPaths: Pick<RunPaths, 'slug' | 'runRootAbs'>;
  readonly workflowConfig: WorkflowConfig;
  readonly resumeSource?: RunResumeSource;
  readonly abortController: AbortController;
}

export function createSqliteFindingContractLifecycle(
  options: SqliteFindingContractLifecycleOptions,
): SqliteFindingContractLifecycle {
  const root = openFindingContractRoot(options);
  let findingRunId: string;
  let lease: LeaseHandle | undefined;
  try {
    findingRunId = root.readResumeSnapshot().run.runId;
    const claimedLease = root.claimLease({
      ownerKey: FINDING_CONTRACT_AUTHORITY_STEP_KEY,
      leaseDurationMs: LEASE_DURATION_MS,
    });
    lease = claimedLease;
    const runtime = root.runtime({ lease: claimedLease });
    const execution = runtime.execution.startStep({
      stepKey: FINDING_CONTRACT_AUTHORITY_STEP_KEY,
      expectedScopeRevision: runtime.execution.loadRuntime().scopeRevision,
    });
    const store = runtime.findingManager({
      workflowName: options.workflowConfig.name,
      producer: execution.handle,
    });
    const heartbeat = setInterval(() => {
      try {
        root.heartbeatLease(claimedLease, LEASE_DURATION_MS);
      } catch (error) {
        clearInterval(heartbeat);
        options.abortController.abort(error);
      }
    }, HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();

    let disposed = false;
    return {
      findingRunId,
      store,
      dispose(): void {
        if (disposed) {
          return;
        }
        disposed = true;
        clearInterval(heartbeat);
        try {
          runtime.execution.finishStep({
            execution: execution.handle,
            status: 'completed',
          });
        } catch (error) {
          throwAfterCleanup(error, [
            () => root.releaseLease(claimedLease),
            () => root.close(),
          ]);
        }
        try {
          root.releaseLease(claimedLease);
        } catch (error) {
          throwAfterCleanup(error, [() => root.close()]);
        }
        root.close();
      },
    };
  } catch (error) {
    const claimedLease = lease;
    if (claimedLease === undefined) {
      throwAfterCleanup(error, [() => root.close()]);
    }
    throwAfterCleanup(error, [
      () => root.releaseLease(claimedLease),
      () => root.close(),
    ]);
  }
}

function openFindingContractRoot(
  options: SqliteFindingContractLifecycleOptions,
): RunStorageRoot {
  const databasePath = join(
    options.runPaths.runRootAbs,
    RUN_STORAGE_DATABASE_FILE,
  );
  if (existsSync(databasePath)) {
    const root = openRunStorage({ databasePath });
    if (options.resumeSource === undefined) {
      return root;
    }
    try {
      assertExistingResumeSource(
        root,
        options.runPaths,
        options.resumeSource,
      );
      return root;
    } catch (error) {
      throwAfterCleanup(error, [() => root.close()]);
    }
  }

  const run = {
    slug: options.runPaths.slug,
    findingContractEnabled: true,
  };
  const workflowDefinition = {
    name: options.workflowConfig.name,
    codecName: 'json-v1',
    definition: JSON.stringify(options.workflowConfig),
  };
  if (options.resumeSource === undefined) {
    return createRunStorage({ databasePath, run, workflowDefinition });
  }
  const sourceRunSlug = requireResumeSourceRunSlug(options.resumeSource);
  const sourceDatabasePath = join(
    dirname(options.runPaths.runRootAbs),
    sourceRunSlug,
    RUN_STORAGE_DATABASE_FILE,
  );
  if (!existsSync(sourceDatabasePath)) {
    throw new Error(
      `SQLite Finding Contract resume source database is missing: ${sourceDatabasePath}`,
    );
  }
  const source = openRunStorage({ databasePath: sourceDatabasePath });
  let resumed: RunStorageRoot;
  try {
    resumed = resumeRunStorage({
      databasePath,
      run,
      workflowDefinition,
      source,
    });
  } catch (error) {
    throwAfterCleanup(error, [() => source.close()]);
  }
  try {
    source.close();
  } catch (error) {
    throwAfterCleanup(error, [() => resumed.close()]);
  }
  return resumed;
}

function assertExistingResumeSource(
  target: RunStorageRoot,
  runPaths: SqliteFindingContractLifecycleOptions['runPaths'],
  resumeSource: RunResumeSource,
): void {
  const sourceRunSlug = requireResumeSourceRunSlug(resumeSource);
  const targetRun = target.readResumeSnapshot().run;
  if (
    targetRun.slug !== runPaths.slug
    || typeof targetRun.runId !== 'string'
    || targetRun.runId.length === 0
  ) {
    throw new Error(
      `SQLite Finding Contract target database run identity does not match "${runPaths.slug}"`,
    );
  }
  if (sourceRunSlug === runPaths.slug) {
    return;
  }
  const sourceDatabasePath = join(
    dirname(runPaths.runRootAbs),
    sourceRunSlug,
    RUN_STORAGE_DATABASE_FILE,
  );
  if (!existsSync(sourceDatabasePath)) {
    throw new Error(
      `SQLite Finding Contract resume source database is missing: ${sourceDatabasePath}`,
    );
  }
  const sourceRunId = readRunStorageIdentity(sourceDatabasePath);
  const directSource = target.readResumeSnapshot().ancestry.find(
    (entry) => entry.depth === 1,
  );
  if (directSource?.ancestorRunId !== sourceRunId) {
    throw new Error(
      `SQLite Finding Contract target database direct resume source does not match "${sourceRunSlug}"`,
    );
  }
}

function readRunStorageIdentity(databasePath: string): string {
  const source = openRunStorage({ databasePath });
  let runId: string;
  try {
    runId = source.readResumeSnapshot().run.runId;
  } catch (error) {
    throwAfterCleanup(error, [() => source.close()]);
  }
  source.close();
  return runId;
}

function requireResumeSourceRunSlug(resumeSource: RunResumeSource): string {
  const sourceRunSlug = resumeSource.sourceRunSlug;
  if (
    sourceRunSlug === undefined
    || !isValidReportDirName(sourceRunSlug)
  ) {
    throw new Error('SQLite Finding Contract resume source run slug is invalid');
  }
  return sourceRunSlug;
}
