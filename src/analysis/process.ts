import { fork } from 'node:child_process';
import { Diagnostic } from '../core.js';

/** Run a trusted analysis module in its own host process. Original execution
 * and static replay get independent compiler heaps; a crash is a failed build,
 * never a retry or a substitute game implementation. No shell is involved. */
export function analyseInProcess<Input extends object, Output>(
  module: URL,
  input: Input,
): Promise<Output> {
  return new Promise((resolve, reject) => {
    const child = fork(module, [], {
      execArgv: ['--max-opt=1', '--no-concurrent-sparkplug'],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    let result: { ok: boolean; value?: Output; error?: string } | undefined;
    const timer = setTimeout(() => child.kill('SIGTERM'), 300000);
    timer.unref();
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('message', (message) => {
      result = message as typeof result;
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 || !result?.ok) {
        reject(
          new Diagnostic(
            'ANALYSIS_PROCESS',
            result?.error ?? `Analysis process stopped: ${signal ?? code}.`,
          ),
        );
      } else {
        resolve(result.value!);
      }
    });
    child.send(input);
  });
}
export function serveAnalysis<Input, Output>(run: (input: Input) => Promise<Output>): void {
  process.once('message', async (input) => {
    try {
      const value = await run(input as Input);
      process.send!({ ok: true, value }, () => process.disconnect());
    } catch (error) {
      process.send!(
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        () => process.disconnect(),
      );
    }
  });
}
