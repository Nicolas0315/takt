import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockExpandPipelineTemplate = vi.fn();

vi.mock('../features/pipeline/templateExpander.js', () => ({
  expandPipelineTemplate: (...args: unknown[]) =>
    mockExpandPipelineTemplate(...(args as [string, Record<string, string>])),
}));

const { mockExecuteTask } = vi.hoisted(() => ({
  mockExecuteTask: vi.fn(),
}));

vi.mock('../features/tasks/index.js', () => ({
  executeTask: (...args: unknown[]) => mockExecuteTask(...args),
  confirmAndCreateWorktree: vi.fn(),
}));

vi.mock('../shared/ui/index.js', () => ({
  info: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock('../shared/ui/StatusLine.js', () => ({
  statusLine: {
    start: vi.fn(),
    stop: vi.fn(),
  },
}));

const { buildCommitMessage, runWorkflow } = await import('../features/pipeline/steps.js');

describe('buildCommitMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should delegate commit message template expansion to the shared pipeline helper', () => {
    mockExpandPipelineTemplate.mockReturnValueOnce('expanded commit message');

    const result = buildCommitMessage(
      { commitMessageTemplate: 'feat: {title} (#{issue})' },
      {
        number: 42,
        title: 'Fix pipeline',
        body: 'Issue body',
        labels: [],
        comments: [],
      },
      undefined,
    );

    expect(result).toBe('expanded commit message');
    expect(mockExpandPipelineTemplate).toHaveBeenCalledWith('feat: {title} (#{issue})', {
      title: 'Fix pipeline',
      issue: '42',
    });
  });
});

describe('runWorkflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Given pipeline options with autoPr, When the workflow runs, Then executeTask receives the resolved autoPr', async () => {
    mockExecuteTask.mockResolvedValue(true);

    const result = await runWorkflow(
      '/project',
      'default',
      'pipeline task',
      '/project',
      { autoPr: true },
      { execCwd: '/project', isWorktree: false },
    );

    expect(result).toBe(true);
    expect(mockExecuteTask).toHaveBeenCalledWith(
      expect.objectContaining({ autoPr: true }),
    );
  });

  it('Given pipeline options without autoPr, When the workflow runs, Then executeTask receives autoPr false', async () => {
    mockExecuteTask.mockResolvedValue(true);

    const result = await runWorkflow(
      '/project',
      'default',
      'pipeline task',
      '/project',
      { autoPr: false },
      { execCwd: '/project', isWorktree: false },
    );

    expect(result).toBe(true);
    expect(mockExecuteTask).toHaveBeenCalledWith(
      expect.objectContaining({ autoPr: false }),
    );
  });
});
