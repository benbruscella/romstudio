import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { decodeVr4300, liftVr4300, liftVr4300Pages } from './vr4300.js';
import { decodeRsp, liftRsp } from './rsp.js';
import { programFiles } from './static.js';
import { toolsDirectory, workDirectory } from '../paths.js';

test('generated CPU/RSP TypeScript type-checks empty, single, variant and block programs against the real runtime', async () => {
  await mkdir(workDirectory, { recursive: true });
  const root = await mkdtemp(join(workDirectory, 'vr4300-types-'));
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    const first = decodeVr4300(0x24020001, 0x80000000),
      alternate = decodeVr4300(0x24020003, 0x80000000),
      second = decodeVr4300(0x24020002, 0x80001000);
    const programs = [
      liftVr4300([]),
      liftVr4300([first]),
      liftVr4300([first, alternate, second]),
      liftVr4300Pages([]),
      liftVr4300Pages([first, alternate, second]),
      liftRsp([]),
      liftRsp([decodeRsp(0x400b3000, 0), decodeRsp(0x1560fffe, 4), decodeRsp(0, 8)]),
      liftRsp([decodeRsp(0, 0)]),
      liftRsp(
        Array.from({ length: 8 }, (_, i) =>
          decodeRsp(
            ((18 << 26) |
              (24 << 21) |
              (31 << 16) |
              ((i & 3) << 11) |
              (((i + 1) & 3) << 6) |
              (i ? 15 : 7)) >>>
              0,
            i * 4,
          ),
        ),
      ),
      liftRsp([
        ...Array.from({ length: 70 }, (_, i) => decodeRsp(0x24210001, i * 4)),
        decodeRsp(0x24210003, 4),
        decodeRsp(0x4a0208c0, 8),
        decodeRsp(0xc8253000, 12),
        decodeRsp(0x400b3000, 16),
      ]),
    ];
    const entries: string[] = [];
    for (const [index, program] of programs.entries()) {
      const directory = join(root, String(index));
      await mkdir(directory);
      await symlink(join(toolsDirectory, 'src/runtime'), join(directory, 'runtime'), 'dir');
      for (const [name, source] of Object.entries(programFiles(program, true))) {
        if (!name.endsWith('.ts')) {
          continue;
        }
        const path = join(directory, 'game-code', name);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, source);
      }
      entries.push(join(directory, 'game-code/program.ts'));
    }
    const program = ts.createProgram(entries, {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noEmit: true,
      strict: true,
      skipLibCheck: true,
      types: [],
    });
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .map(
        (diagnostic) =>
          `${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`,
      );
    assert.deepEqual(diagnostics, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
