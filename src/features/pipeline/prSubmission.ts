import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  buildPrBody,
  createPullRequestSafely,
  getGitProvider,
  stripTaktManagedPrMarker,
} from '../../infra/git/index.js';
import type { CreatePrResult, Issue } from '../../infra/git/index.js';
import type { PipelineConfig } from '../../core/models/index.js';
import type { PipelineExecutionOptions } from '../tasks/index.js';
import { error, info, success } from '../../shared/ui/index.js';
import { expandPipelineTemplate } from './templateExpander.js';
import type { WorkflowCompletion } from '../tasks/execute/types.js';

export interface PipelinePrTaskContent {
  issue?: Issue;
}

function buildPipelinePrBody(
  pipelineConfig: PipelineConfig | undefined,
  issue: Issue | undefined,
  report: string,
): string {
  const template = pipelineConfig?.prBodyTemplate;
  if (template) {
    return expandPipelineTemplate(template, {
      title: issue?.title ?? '',
      issue: issue ? String(issue.number) : '',
      issue_body: issue?.body || issue?.title || '',
      report,
    });
  }
  return buildPrBody(issue ? [issue] : undefined, report);
}

function requireBaseBranch(baseBranch: string | undefined): string {
  if (!baseBranch) {
    throw new Error('Base branch is required (pull request creation)');
  }
  return baseBranch;
}

function readDeferredReport(projectCwd: string, reportPath: string): string {
  if (isAbsolute(reportPath)) {
    throw new Error('Deferred final-gate report must be project-relative');
  }
  const reportAbsolutePath = resolve(projectCwd, reportPath);
  const projectRelativePath = relative(projectCwd, reportAbsolutePath);
  if (
    projectRelativePath.length === 0
    || projectRelativePath === '..'
    || projectRelativePath.startsWith('../')
    || isAbsolute(projectRelativePath)
  ) {
    throw new Error('Deferred final-gate report must remain inside the project');
  }
  return readFileSync(reportAbsolutePath, 'utf-8');
}

function buildDeferredManagedSection(
  reportCwd: string,
  completion: WorkflowCompletion,
): string {
  const report = readDeferredReport(reportCwd, completion.report);
  const quotedReport = report.length === 0
    ? '> (empty final-gate report)'
    : report.split('\n').map((line) => `> ${line}`).join('\n');
  return [
    '## TAKT Deferred Handoff',
    '',
    '- Merge readiness: unconfirmed; the external gate handoff is required.',
    '- Unverified gates: see the quoted final-gate report below.',
    '- Follow-up gate: see the downstream gate and reachability recorded in the quoted report below.',
    `- Final-gate report: \`${completion.report}\``,
    '',
    '### Final-gate report',
    quotedReport,
  ].join('\n');
}

export function submitPullRequest(
  projectCwd: string,
  branch: string,
  baseBranch: string | undefined,
  taskContent: PipelinePrTaskContent,
  workflow: string,
  pipelineConfig: PipelineConfig | undefined,
  options: Pick<PipelineExecutionOptions, 'task' | 'repo' | 'draftPr'>,
  completion?: WorkflowCompletion,
  reportCwd: string = projectCwd,
): string | undefined {
  info('Creating pull request...');
  const prTitle = taskContent.issue ? `[#${taskContent.issue.number}] ${taskContent.issue.title}` : (options.task ?? 'Pipeline task');
  const report = completion?.kind === 'deferred'
    ? `Workflow \`${workflow}\` completed with deferred external gate handoff.`
    : `Workflow \`${workflow}\` completed successfully.`;
  let deferredSection: string | undefined;
  if (completion?.kind === 'deferred') {
    try {
      deferredSection = buildDeferredManagedSection(reportCwd, completion);
    } catch (readError) {
      error(`Deferred final-gate report could not be read: ${readError instanceof Error ? readError.message : String(readError)}`);
      return undefined;
    }
  }
  const baseBody = buildPipelinePrBody(pipelineConfig, taskContent.issue, report);
  const prBody = stripTaktManagedPrMarker(
    deferredSection === undefined
      ? baseBody
      : `${baseBody.trimEnd()}\n\n${deferredSection}`,
  );

  const prResult: CreatePrResult = createPullRequestSafely(getGitProvider(), {
    branch,
    title: prTitle,
    body: prBody,
    base: requireBaseBranch(baseBranch),
    repo: options.repo,
    draft: options.draftPr,
  }, projectCwd);

  if (prResult.success) {
    success(`PR created: ${prResult.url}`);
    return prResult.url;
  }
  error(`PR creation failed: ${prResult.error}`);
  return undefined;
}
