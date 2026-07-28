import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowConfig } from '../core/models/index.js';
import { WorkflowEngine } from '../core/workflow/index.js';
import type { FindingLedgerStore } from '../core/workflow/findings/store.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createWorkflow(withFindingContract: boolean): WorkflowConfig {
  return {
    name: 'injected-finding-store',
    initialStep: 'review',
    maxSteps: 1,
    steps: [{
      name: 'review',
      persona: 'reviewer',
      instruction: 'Review.',
      rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
    }],
    ...(withFindingContract
      ? {
        findingContract: {
          backend: 'sqlite' as const,
          ledgerPath: '.takt/findings/should-not-exist.json',
          rawFindingsPath: '.takt/findings/should-not-exist',
          manager: {
            persona: 'findings-manager',
            instruction: 'Reconcile.',
            outputContract: 'Return JSON.',
          },
        },
      }
      : {}),
  };
}

function createInjectedStore(): {
  readonly store: FindingLedgerStore;
  readonly loadLedger: ReturnType<typeof vi.fn>;
  readonly saveLedgerSnapshot: ReturnType<typeof vi.fn>;
} {
  const ledger = {
    workflowName: 'injected-finding-store',
    nextId: 1,
    updatedAt: new Date(0).toISOString(),
    findings: [],
    rawFindings: [],
    conflicts: [],
    interpretations: [],
  };
  const loadLedger = vi.fn(() => ledger);
  const saveLedgerSnapshot = vi.fn();
  return {
    loadLedger,
    saveLedgerSnapshot,
    store: {
      workflowName: ledger.workflowName,
      loadLedger,
      saveLedgerSnapshot,
    } as unknown as FindingLedgerStore,
  };
}

describe('WorkflowEngine FindingLedgerStore injection', () => {
  it('uses the injected store without creating the file backend ledger', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-injected-finding-store-'));
    directories.push(cwd);
    const injected = createInjectedStore();

    new WorkflowEngine(createWorkflow(true), cwd, 'task', {
      projectCwd: cwd,
      reportDirName: 'injected-store-run',
      findingLedgerStore: injected.store,
    });

    expect(injected.loadLedger).toHaveBeenCalled();
    expect(injected.saveLedgerSnapshot).toHaveBeenCalledOnce();
    expect(existsSync(join(
      cwd,
      '.takt',
      'findings',
      'should-not-exist.json',
    ))).toBe(false);
  });

  it('fails fast when a store is injected without finding_contract', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-injected-finding-store-'));
    directories.push(cwd);

    expect(() => new WorkflowEngine(createWorkflow(false), cwd, 'task', {
      projectCwd: cwd,
      reportDirName: 'injected-store-run',
      findingLedgerStore: createInjectedStore().store,
    })).toThrow('FindingLedgerStore requires finding_contract');
  });
});
