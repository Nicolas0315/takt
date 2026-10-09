import { runWithWorkerPool } from '../../features/tasks/execute/parallelExecution.js';
import type { TaskInfo } from '../../infra/task/index.js';

const task: TaskInfo = {
  name: 'sigint-child',
  content: 'sigint-child',
  filePath: '/tasks/sigint-child.yaml',
  createdAt: '2026-01-01T00:00:00.000Z',
  status: 'pending',
  data: { task: 'sigint-child', workflow: 'default' },
};

const runner = {
  claimNextTasks: () => [],
};

const loaderListeners = process.rawListeners('SIGINT');
if (loaderListeners.length !== 1) {
  throw new Error(`unexpected child loader SIGINT listeners: ${loaderListeners.map((listener) => listener.name).join(',')}`);
}
console.log(JSON.stringify({
  event: 'child.started',
  sigintListeners: loaderListeners.length,
  listenerNames: loaderListeners.map((listener) => listener.name),
}));

// tsx installs exactly one known loader listener in this child. Remove that
// listener only; the production ShutdownManager is installed below normally.
process.removeListener('SIGINT', loaderListeners[0]!);
if (process.listenerCount('SIGINT') !== 0) {
  throw new Error(`child loader SIGINT cleanup left ${process.listenerCount('SIGINT')} listeners`);
}

const taskExecutor: typeof import('../../features/tasks/execute/runTaskExecution.js').executeRunTaskAndComplete =
  (_task, _runner, _cwd, _options, parallel) => new Promise<boolean>((resolve) => {
    const selfSigintOnce = process.env.TAKT_E2E_SELF_SIGINT_ONCE === '1';
    const selfSigintTwice = process.env.TAKT_E2E_SELF_SIGINT_TWICE === '1';
    console.log(JSON.stringify({
      event: 'executor.started',
      sigintListeners: process.listenerCount('SIGINT'),
      once: selfSigintOnce,
      twice: selfSigintTwice,
    }));
    parallel?.abortSignal?.addEventListener('abort', () => {
      console.log(JSON.stringify({
        event: 'executor.aborted',
        sigintListeners: process.listenerCount('SIGINT'),
      }));
      if (!selfSigintTwice) resolve(false);
    }, { once: true });
    setImmediate(() => {
      if (selfSigintOnce || selfSigintTwice) {
        process.emit('SIGINT');
      }
      if (selfSigintTwice) {
        setTimeout(() => process.emit('SIGINT'), 25);
      }
    });
    setTimeout(() => resolve(true), 500);
  });

const result = await runWithWorkerPool(
  runner as never,
  [task],
  1,
  process.cwd(),
  undefined,
  undefined,
  10,
  taskExecutor,
);

console.log(JSON.stringify({
  event: 'run.result',
  result,
  sigintListeners: process.listenerCount('SIGINT'),
}));
