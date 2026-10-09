import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = resolve(repoRoot, 'src/__tests__/fixtures/workerPoolSigintChild.ts');
const MAX_CAPTURE_BYTES = 32 * 1024;
const CHILD_TIMEOUT_MS = 10_000;
const CHILD_CLOSE_GRACE_MS = 2_000;

interface ChildRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  captureTruncated: boolean;
}

interface RunChildOptions {
  timeoutMs?: number;
  closeGraceMs?: number;
  spawnImpl?: typeof spawn;
}

interface ByteCapture {
  chunks: Buffer[];
  bytes: number;
  truncated: boolean;
}

function appendBounded(capture: ByteCapture, chunk: Buffer | string): void {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const remaining = MAX_CAPTURE_BYTES - capture.bytes;
  if (remaining <= 0) {
    capture.truncated = true;
    return;
  }
  const kept = bytes.subarray(0, remaining);
  capture.chunks.push(Buffer.from(kept));
  capture.bytes += kept.byteLength;
  if (kept.byteLength !== bytes.byteLength) capture.truncated = true;
}

function decodeCapture(capture: ByteCapture): string {
  return Buffer.concat(capture.chunks).toString('utf8');
}

function runChild(env: Record<string, string>, options: RunChildOptions = {}): Promise<ChildRunResult> {
  const spawnImpl = options.spawnImpl ?? spawn;
  const timeoutMs = options.timeoutMs ?? CHILD_TIMEOUT_MS;
  const closeGraceMs = options.closeGraceMs ?? CHILD_CLOSE_GRACE_MS;
  return new Promise((resolvePromise, reject) => {
    const child = spawnImpl(process.execPath, ['--import', 'tsx', fixture], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutCapture: ByteCapture = { chunks: [], bytes: 0, truncated: false };
    const stderrCapture: ByteCapture = { chunks: [], bytes: 0, truncated: false };
    let timedOut = false;
    let settled = false;
    let cleanupFailure: string | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let closeGraceId: ReturnType<typeof setTimeout> | undefined;
    let hardDeadlineId: ReturnType<typeof setTimeout> | undefined;
    const clearTimers = (): void => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (closeGraceId !== undefined) clearTimeout(closeGraceId);
      if (hardDeadlineId !== undefined) clearTimeout(hardDeadlineId);
    };
    const recordKillFailure = (signal: NodeJS.Signals): void => {
      try {
        if (!child.kill(signal)) {
          cleanupFailure = [cleanupFailure, `kill(${signal}) returned false`].filter(Boolean).join('; ');
        }
      } catch (error) {
        cleanupFailure = [cleanupFailure, `kill(${signal}) threw: ${error instanceof Error ? error.message : String(error)}`]
          .filter(Boolean)
          .join('; ');
      }
    };
    child.stdout?.on('data', (chunk: Buffer) => appendBounded(stdoutCapture, chunk));
    child.stderr?.on('data', (chunk: Buffer) => appendBounded(stderrCapture, chunk));
    child.once('error', (error) => {
      clearTimers();
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once('close', (code) => {
      clearTimers();
      if (!settled) {
        settled = true;
        resolvePromise({
          code,
          stdout: decodeCapture(stdoutCapture),
          stderr: decodeCapture(stderrCapture),
          timedOut,
          captureTruncated: stdoutCapture.truncated || stderrCapture.truncated,
        });
      }
    });
    timeoutId = setTimeout(() => {
      timedOut = true;
      recordKillFailure('SIGTERM');
      closeGraceId = setTimeout(() => {
        if (!settled) recordKillFailure('SIGKILL');
      }, closeGraceMs);
      hardDeadlineId = setTimeout(() => {
        if (settled) return;
        settled = true;
        const pid = child.pid ?? 'unknown';
        reject(new Error(
          `child cleanup deadline exceeded pid=${pid}${cleanupFailure ? ` cleanupFailure=${cleanupFailure}` : ''}`,
        ));
      }, closeGraceMs + 100);
    }, timeoutMs);
  });
}

function parseJsonEvents(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function event(events: Array<Record<string, unknown>>, name: string): Record<string, unknown> {
  const found = events.find((candidate) => candidate.event === name);
  if (!found) throw new Error(`missing child event: ${name}; events=${JSON.stringify(events)}`);
  return found;
}

describe('worker pool SIGINT child process contract', () => {
  it('keeps UTF-8 capture bounded by bytes, not UTF-16 code units', () => {
    const capture: ByteCapture = { chunks: [], bytes: 0, truncated: false };
    appendBounded(capture, 'あ'.repeat(MAX_CAPTURE_BYTES));

    expect(capture.bytes).toBe(MAX_CAPTURE_BYTES);
    expect(Buffer.concat(capture.chunks).byteLength).toBeLessThanOrEqual(MAX_CAPTURE_BYTES);
    expect(capture.truncated).toBe(true);
  });

  it('rejects a child that does not close after kill and retains its pid and cleanup failure', async () => {
    const child = new EventEmitter() as EventEmitter & Partial<ChildProcess>;
    child.pid = 424242;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn()
      .mockReturnValueOnce(false)
      .mockImplementation(() => { throw new Error('kill unavailable'); }) as unknown as ChildProcess['kill'];

    await expect(runChild({}, {
      timeoutMs: 5,
      closeGraceMs: 5,
      spawnImpl: (() => child) as typeof spawn,
    })).rejects.toThrow(/child cleanup deadline exceeded pid=424242.*cleanupFailure=.*returned false.*threw: kill unavailable/u);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('executes the real ShutdownManager graceful path for SELF_SIGINT_ONCE', async () => {
    const result = await runChild({
      TAKT_E2E_SELF_SIGINT_ONCE: '1',
      TAKT_E2E_SELF_SIGINT_TWICE: '',
    });
    const events = parseJsonEvents(result.stdout);
    const runResult = event(events, 'run.result');
    expect(result.code).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.captureTruncated).toBe(false);
    expect(event(events, 'child.started')).toMatchObject({ sigintListeners: 1 });
    expect(event(events, 'executor.started')).toMatchObject({ sigintListeners: 1, once: true, twice: false });
    expect(event(events, 'executor.aborted')).toMatchObject({ sigintListeners: 1 });
    expect(runResult).toMatchObject({ sigintListeners: 0, result: { success: 0, fail: 1 } });
    expect(result.stderr).not.toContain('ERR_IPC_CHANNEL_CLOSED');
  });

  it('observes the real process.exit(130) force path for SELF_SIGINT_TWICE', async () => {
    const result = await runChild({
      TAKT_E2E_SELF_SIGINT_ONCE: '',
      TAKT_E2E_SELF_SIGINT_TWICE: '1',
    });
    const events = parseJsonEvents(result.stdout);
    expect(result.code).toBe(130);
    expect(result.timedOut).toBe(false);
    expect(result.captureTruncated).toBe(false);
    expect(event(events, 'child.started')).toMatchObject({ sigintListeners: 1 });
    expect(event(events, 'executor.started')).toMatchObject({ sigintListeners: 1, once: false, twice: true });
    expect(event(events, 'executor.aborted')).toMatchObject({ sigintListeners: 1 });
    expect(events.some((candidate) => candidate.event === 'run.result')).toBe(false);
    expect(result.stderr).not.toContain('ERR_IPC_CHANNEL_CLOSED');
  });
});
