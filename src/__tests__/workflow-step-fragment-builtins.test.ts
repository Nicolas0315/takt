import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { invalidateAllResolvedConfigCache, invalidateGlobalConfigCache } from '../infra/config/index.js';
import {
  getBuiltinLanguageStepsDir,
  getBuiltinStepsDir,
  getBuiltinWorkflowsDir,
} from '../infra/config/paths.js';
import { buildStepFragmentLookupDirs } from '../infra/config/loaders/stepFragmentLookupDirectories.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';

type RawStep = Record<string, unknown>;
type RawWorkflow = { steps: RawStep[] };
type Language = 'en' | 'ja';

const LANGUAGES: Language[] = ['en', 'ja'];
const REVIEWER_WORKFLOWS = ['takt-default-high', 'takt-default-team-high', 'review-fix-takt-default-high'];
const GATHER_WORKFLOWS = ['review-fix-takt-default', 'review-fix-takt-default-high'];
const FIX_WORKFLOWS = ['takt-default-high', 'review-fix-takt-default-high'];

function readBuiltinWorkflow(lang: Language, name: string): RawWorkflow {
  return parseYaml(readFileSync(join(getBuiltinWorkflowsDir(lang), name + '.yaml'), 'utf-8')) as RawWorkflow;
}

function getStep(raw: RawWorkflow, name: string): RawStep {
  const step = raw.steps.find((candidate) => candidate.name === name);
  if (!step) throw new Error('Builtin workflow does not define step "' + name + '"');
  return step;
}

function expectFragmentReference(step: RawStep, name: string): string {
  expect(step.name).toBe(name);
  expect(typeof step.uses).toBe('string');
  expect(step.rules).toBeDefined();
  const keys = Object.keys(step);
  expect(keys.indexOf('name')).toBeLessThan(keys.indexOf('uses'));
  expect(keys.indexOf('uses')).toBeLessThan(keys.indexOf('rules'));
  return step.uses as string;
}

function collectRulesPaths(value: unknown, path = ''): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  const record = value as RawStep;
  const found = Object.hasOwn(record, 'rules') ? [`${path}rules`] : [];
  const parallel = record.parallel;
  if (!Array.isArray(parallel)) return found;
  return parallel.reduce<string[]>(
    (paths, child, index) => [...paths, ...collectRulesPaths(child, `${path}parallel[${index}].`)],
    found,
  );
}

describe('builtin workflow step fragment migration', () => {
  let projectDir: string;
  let globalConfigDir: string;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'takt-step-fragment-builtins-project-'));
    globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-step-fragment-builtins-global-'));
    previousConfigDir = process.env.TAKT_CONFIG_DIR;
    process.env.TAKT_CONFIG_DIR = globalConfigDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(globalConfigDir, { recursive: true, force: true });
    if (previousConfigDir === undefined) delete process.env.TAKT_CONFIG_DIR;
    else process.env.TAKT_CONFIG_DIR = previousConfigDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  it.each(LANGUAGES)('looks up %s language fragments before the shared builtin directory', (lang) => {
    const dirs = buildStepFragmentLookupDirs({ lang });
    const languageStepsDir = getBuiltinLanguageStepsDir(lang);

    expect(dirs).toContain(languageStepsDir);
    expect(dirs.indexOf(languageStepsDir)).toBeLessThan(dirs.indexOf(getBuiltinStepsDir()));
  });

  it.each(LANGUAGES)('moves the %s reviewers steps to one language-specific fragment', (lang) => {
    const refs = REVIEWER_WORKFLOWS.map((workflow) =>
      expectFragmentReference(getStep(readBuiltinWorkflow(lang, workflow), 'reviewers'), 'reviewers'));

    expect(new Set(refs).size).toBe(1);
    expect(existsSync(join(getBuiltinLanguageStepsDir(lang), `${refs[0]}.yaml`))).toBe(true);
  });

  it.each(LANGUAGES)('moves the %s gather steps to one language-specific fragment', (lang) => {
    const refs = GATHER_WORKFLOWS.map((workflow) =>
      expectFragmentReference(getStep(readBuiltinWorkflow(lang, workflow), 'gather'), 'gather'));

    expect(new Set(refs).size).toBe(1);
    expect(existsSync(join(getBuiltinLanguageStepsDir(lang), `${refs[0]}.yaml`))).toBe(true);
  });

  it.each(LANGUAGES)('moves the %s fix steps to one language-specific fragment', (lang) => {
    const refs = FIX_WORKFLOWS.map((workflow) =>
      expectFragmentReference(getStep(readBuiltinWorkflow(lang, workflow), 'fix'), 'fix'));

    expect(new Set(refs).size).toBe(1);
    expect(existsSync(join(getBuiltinLanguageStepsDir(lang), `${refs[0]}.yaml`))).toBe(true);
  });

  it('moves both supervise steps to the same shared fragment', () => {
    const refs = LANGUAGES.map((lang) =>
      expectFragmentReference(getStep(readBuiltinWorkflow(lang, 'merge-readiness-finding-contract-final-gate'), 'supervise'), 'supervise'));

    expect(new Set(refs).size).toBe(1);
    expect(existsSync(join(getBuiltinStepsDir(), `${refs[0]}.yaml`))).toBe(true);
  });

  it.each(LANGUAGES)('loads migrated %s builtin workflows through the fragment resolver', (lang) => {
    mkdirSync(join(projectDir, '.takt'), { recursive: true });
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), 'language: ' + lang + '\n', 'utf-8');
    invalidateAllResolvedConfigCache();

    const workflows = new Set([
      ...REVIEWER_WORKFLOWS,
      ...GATHER_WORKFLOWS,
      ...FIX_WORKFLOWS,
      'merge-readiness-finding-contract-final-gate',
    ]);
    for (const name of workflows) {
      expect(() => loadWorkflowFromFile(join(getBuiltinWorkflowsDir(lang), name + '.yaml'), projectDir)).not.toThrow();
    }
  });

  it('keeps every shipped fragment free of rules, including parallel descendants', () => {
    const stepDirs = [
      getBuiltinStepsDir(),
      ...LANGUAGES.map((lang) => getBuiltinLanguageStepsDir(lang)),
    ];
    for (const directory of stepDirs) {
      for (const file of readdirSync(directory).filter((name) => name.endsWith('.yaml'))) {
        const fragment = parseYaml(readFileSync(join(directory, file), 'utf-8')) as unknown;
        expect(collectRulesPaths(fragment), `${directory}/${file}`).toEqual([]);
      }
    }
  });

});
