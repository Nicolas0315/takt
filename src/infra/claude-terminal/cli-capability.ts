import { execFile } from 'node:child_process';

const DISABLE_SLASH_COMMANDS_FLAG = '--disable-slash-commands';
const supportedExecutables = new Set<string>();

function readClaudeHelp(executable: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, ['--help'], { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(`${stdout}\n${stderr}`);
    });
  });
}

export async function assertClaudeSkillsDisableSupported(executable: string): Promise<void> {
  if (supportedExecutables.has(executable)) {
    return;
  }

  const output = await readClaudeHelp(executable);

  if (output.includes(DISABLE_SLASH_COMMANDS_FLAG)) {
    supportedExecutables.add(executable);
    return;
  }

  throw new Error(
    `Claude Code must support ${DISABLE_SLASH_COMMANDS_FLAG} to disable Skills. Update Claude Code to 2.1.220 or later.`,
  );
}
