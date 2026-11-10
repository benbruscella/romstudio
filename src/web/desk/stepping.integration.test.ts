import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gameBuildDirectory } from '../../paths.js';
import type { BrowserTitle } from '../shell-types.js';
import type { Machine } from '../../runtime/mos6502.js';
import type { Mos6502DeskHost } from './mos6502.js';
import { N64Player } from '../../systems/n64/player.js';
import { clearN64Trace, type N64Launch } from '../../systems/n64/checkpoint.js';
import type { Vr4300Program } from '../../runtime/vr4300.js';
import type { RspProgram } from '../../runtime/rsp.js';
import { createHash } from 'node:crypto';

/** ROM Desk acceptance (docs/DESK.md): stepping must agree with ordinary
 * execution at the same machine boundary. Uses each game's built package;
 * a game without one (for example before the first build) is skipped. */
const packaged = async (key: string) => {
  const directory = gameBuildDirectory(key as never);
  try {
    await access(join(directory, 'manifest.json'));
    return directory;
  } catch {
    return undefined;
  }
};

for (const key of ['nes/smb', 'nes/tetris', 'c64/lemmings', 'c64/nebulus', 'c64/elite']) {
  test(`${key}: Desk instruction stepping matches ordinary frames`, async (context) => {
    const directory = await packaged(key);
    if (!directory) {
      context.skip('no built package');
      return;
    }
    const { title } = (await import(
      pathToFileURL(join(import.meta.dirname, '../../games', key, 'web/title.js')).href
    )) as { title: BrowserTitle };
    const checkpoint = JSON.parse(await readFile(join(directory, 'checkpoint.json'), 'utf8'));
    const { step } = (await import(
      pathToFileURL(join(directory, 'game-code/program.js')).href
    )) as { step: (machine: Machine) => void };
    const idle = () => ({ pressed: [] as string[] });
    const ordinary = title.create(checkpoint, step, idle),
      stepped = title.create(checkpoint, step, idle);
    const a = ordinary.desk!,
      b: Mos6502DeskHost = stepped.desk!;
    const frames = 150;
    for (let frame = 0; frame < frames; frame++) {
      ordinary.advanceFrame();
    }
    let operations = 0;
    while (b.clock.frames < frames && !b.gap) {
      let asked = false;
      b.runFrame(() => {
        const stop = asked;
        asked = true;
        return stop;
      });
      operations++;
    }
    assert.ok(operations > frames * 50, `stepped ${operations} operations`);
    assert.equal(a.gap, undefined, 'ordinary play must not reach a recovery gap');
    assert.equal(b.gap, undefined);
    assert.equal(a.clock.frames, frames);
    for (const register of ['a', 'x', 'y', 'sp', 'p', 'pc', 'cycles', 'instructions'] as const) {
      assert.equal(b.machine[register], a.machine[register], register);
    }
    const memory = (host: Mos6502DeskHost) =>
      Array.from({ length: 65536 }, (_, address) => host.peek(address) ?? -1);
    assert.deepEqual(memory(b), memory(a));
    assert.equal(b.controlFrames, a.controlFrames);
  });
}

test('n64/sm64: Desk ticks match ordinary reference-tier frames', async (context) => {
  const directory = await packaged('n64/sm64');
  if (!directory) {
    context.skip('no built package');
    return;
  }
  const launch = JSON.parse(
    await readFile(join(directory, 'checkpoint.json'), 'utf8'),
  ) as N64Launch;
  const load = async (name: string) => new Uint8Array(await readFile(join(directory, name)));
  const [rom, ram, signal] = await Promise.all([
    load(launch.assets.cartridge),
    load(launch.assets.rdram),
    load(launch.assets.signal),
  ]);
  const cpu = (await import(
    pathToFileURL(join(directory, 'game-code/program.js')).href
  )) as Vr4300Program;
  const rsp = (await import(
    pathToFileURL(join(directory, 'game-code/rsp-play/program.js')).href
  )) as RspProgram;
  const create = () =>
    new N64Player(
      launch,
      rom,
      ram,
      signal,
      cpu.step,
      rsp.step,
      rsp.prepareLinear,
      cpu.idleAddresses,
      rsp.runLocal,
    );
  const ordinary = create(),
    stepped = create();
  const frames = 2;
  const start = ordinary.system.memory.display.fullSyncs;
  while (ordinary.system.memory.display.fullSyncs < start + frames && !ordinary.gap) {
    ordinary.advance(1000);
  }
  let ticks = 0;
  while (stepped.system.memory.display.fullSyncs < start + frames && !stepped.gap) {
    stepped.tick();
    if ((++ticks & 0xffff) === 0) {
      clearN64Trace(stepped.system);
    }
  }
  clearN64Trace(stepped.system);
  assert.equal(ordinary.gap, undefined, 'ordinary play must not reach a recovery gap');
  assert.equal(stepped.gap, undefined);
  assert.ok(ticks > 1000000, `stepped ${ticks} ticks`);
  assert.ok(stepped.system.rsp.instructions > 0, 'the RSP ran during the stepped frames');
  const a = ordinary.system,
    b = stepped.system;
  assert.equal(b.ticks, a.ticks, 'ticks at the FullSync boundary');
  assert.equal(b.cpu.pc, a.cpu.pc);
  assert.deepEqual([...b.cpu.registers], [...a.cpu.registers]);
  assert.equal(b.rsp.pc, a.rsp.pc);
  assert.deepEqual([...b.rsp.registers], [...a.rsp.registers]);
  const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  assert.equal(digest(b.memory.ram.bytes), digest(a.memory.ram.bytes), 'RDRAM');
  assert.equal(digest(b.memory.signal.memory), digest(a.memory.signal.memory), 'RSP memories');
});
