import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createIsolatedEnv, type IsolatedEnv, updateIsolatedConfig } from '../helpers/isolated-env';
import { readSessionRecords } from '../helpers/session-log';
import { runTakt } from '../helpers/takt-runner';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';

const provider = process.env.TAKT_E2E_PROVIDER;
const providerIt = provider === 'claude' || provider === 'claude-sdk' ? it : it.skip;

function writeSkillVisibilityWorkflow(repoPath: string, skillName: string): string {
  const workflowPath = join(repoPath, 'claude-skills-workflow.yaml');
  writeFileSync(
    workflowPath,
    [
      'name: claude-skills-e2e',
      'description: Verify Claude Skill metadata visibility',
      'max_steps: 1',
      'initial_step: check_skill',
      'steps:',
      '  - name: check_skill',
      '    edit: false',
      '    persona: |',
      '      You report whether an initial Claude Skill is available.',
      '    instruction: |',
      '      Do not use any tools or read any files.',
      `      Answer exactly VISIBLE if the initial context lists the Skill named ${skillName}.`,
      '      Otherwise answer exactly HIDDEN.',
      '    rules:',
      '      - condition: VISIBLE',
      '        next: COMPLETE',
      '      - condition: HIDDEN',
      '        next: COMPLETE',
    ].join('\n'),
    'utf-8',
  );
  return workflowPath;
}

function createSentinelSkill(repoPath: string): string {
  const skillName = `takt-sentinel-${randomUUID().replaceAll('-', '')}`;
  const skillDirectory = join(repoPath, '.claude', 'skills', skillName);
  mkdirSync(skillDirectory, { recursive: true });
  writeFileSync(
    join(skillDirectory, 'SKILL.md'),
    [
      '---',
      `name: ${skillName}`,
      'description: Sentinel Skill used only to verify metadata visibility.',
      '---',
      '',
      '# Sentinel',
    ].join('\n'),
    'utf-8',
  );
  return skillName;
}

function getStepContent(repoPath: string): string | undefined {
  const record = readSessionRecords(repoPath)
    .find((entry) => entry.type === 'phase_complete' && entry.phaseName === 'execute');
  return typeof record?.content === 'string' ? record.content.trim() : undefined;
}

describe('E2E: Claude filesystem Skill metadata', () => {
  let isolatedEnv: IsolatedEnv;
  let repo: LocalRepo;
  let workflowPath: string;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    repo = createLocalRepo();
    workflowPath = writeSkillVisibilityWorkflow(repo.path, createSentinelSkill(repo.path));
  });

  afterEach(() => {
    try { repo.cleanup(); } catch { /* best-effort */ }
    try { isolatedEnv.cleanup(); } catch { /* best-effort */ }
  });

  function runSkillVisibilityCheck(enabled: boolean) {
    updateIsolatedConfig(isolatedEnv.taktDir, {
      provider_options: {
        claude: {
          skills: { enabled },
        },
      },
    });

    return runTakt({
      args: ['--task', 'Report the sentinel Skill visibility.', '--workflow', workflowPath],
      cwd: repo.path,
      env: isolatedEnv.env,
      timeout: 240_000,
    });
  }

  providerIt('does not inject project Skill metadata when disabled', () => {
    const result = runSkillVisibilityCheck(false);

    expect(result.exitCode).toBe(0);
    expect(getStepContent(repo.path)).toBe('HIDDEN');
  }, 240_000);

  providerIt('preserves project Skill metadata when enabled', () => {
    const result = runSkillVisibilityCheck(true);

    expect(result.exitCode).toBe(0);
    expect(getStepContent(repo.path)).toBe('VISIBLE');
  }, 240_000);
});
