import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { repositoryRoot, toolsDirectory } from '../paths.js';

/** Select source-owned tests, avoiding stale compiled files after a rename. */
const mode = process.argv[2] ?? 'all',
  source = join(repositoryRoot, 'src');
if (!['all', 'unit', 'integration'].includes(mode)) {
  throw new Error('Choose all, unit or integration.');
}
async function discover(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await discover(path)));
    } else if (entry.name.endsWith('.test.ts')) {
      const integration = entry.name.endsWith('.integration.test.ts');
      if (mode === 'all' || integration === (mode === 'integration')) {
        found.push(join(toolsDirectory, 'src', relative(source, path).replace(/\.ts$/, '.js')));
      }
    }
  }
  return found;
}
const files = (await discover(source)).sort();
if (!files.length) {
  throw new Error('No tests selected.');
}
const child = spawn(
  process.execPath,
  ['--max-opt=1', '--no-concurrent-sparkplug', '--test', '--test-concurrency=2', ...files],
  { stdio: 'inherit' },
);
child.once('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
