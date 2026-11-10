import { fork } from 'node:child_process';
import { Diagnostic } from '../core.js';

/** Native crash signals. V8 on macOS ARM64 intermittently faults in JIT code
 * on the very large generated game modules (see docs/BUILD.md). */
const hostCrashes = new Set(['SIGSEGV', 'SIGBUS', 'SIGTRAP', 'SIGILL']);
const hostCrashRetries = 2;

/** Run a trusted analysis module in its own host process. Original execution
 * and static replay get independent compiler heaps. A native host crash
 * reruns the same deterministic analysis (at most twice, reported); its
 * result is still checked in full. Any error, failed check or other exit
 * fails the build. Never a substitute game implementation. No shell. */
export async function analyseInProcess<Input extends object, Output>(
  module: URL,
  input: Input,
): Promise<Output> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await analyseOnce<Input, Output>(module, input);
    } catch (error) {
      const signal = (error as { signal?: string }).signal;
      if (!signal || !hostCrashes.has(signal) || attempt >= hostCrashRetries) {
        throw error;
      }
      console.error(
        `Analysis process crashed natively (${signal}); rerunning the same analysis (${attempt + 1}/${hostCrashRetries}).`,
      );
    }
  }
}

function analyseOnce<Input extends object, Output>(module: URL, input: Input): Promise<Output> {
  return new Promise((resolve, reject) => {
    const child = fork(module, [], {
      execArgv: ['--no-concurrent-sparkplug'],
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
          Object.assign(
            new Diagnostic(
              'ANALYSIS_PROCESS',
              result?.error ?? `Analysis process stopped: ${signal ?? code}.`,
            ),
            // Only a crash with no reported result is a host crash.
            { signal: result ? undefined : (signal ?? undefined) },
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
      process.send!({ ok: true, value }, () => process.disconnect?.());
    } catch (error) {
      process.send!(
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        () => process.disconnect?.(),
      );
    }
  });
}
