import { describe, expect, it, vi } from 'vitest';

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

const { assertClaudeSkillsDisableSupported } = await import('../infra/claude-terminal/cli-capability.js');

describe('assertClaudeSkillsDisableSupported', () => {
  it('allows a Claude executable that advertises --disable-slash-commands', async () => {
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null, '--disable-slash-commands', '');
    });

    await expect(assertClaudeSkillsDisableSupported('claude-supported')).resolves.toBeUndefined();
  });

  it('rejects a Claude executable that does not advertise --disable-slash-commands', async () => {
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null, '--help', '');
    });

    await expect(assertClaudeSkillsDisableSupported('claude-unsupported'))
      .rejects.toThrow(/--disable-slash-commands.*2\.1\.220/i);
  });

  it.each(['ENOENT', 'EACCES'])('propagates a %s failure to start the Claude executable', async (code) => {
    const error = Object.assign(new Error(`spawn claude-missing ${code}`), { code });
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(error, '', '');
    });

    await expect(assertClaudeSkillsDisableSupported(`claude-missing-${code}`)).rejects.toBe(error);
  });
});
