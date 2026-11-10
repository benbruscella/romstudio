import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { repositoryRoot } from '../../../../paths.js';
import { fnv1a } from '../../../../systems/n64/fast3d.js';
import { aspMainMicrocode } from '../../../../systems/n64/aspmain.js';
import { RspRecovery } from '../../../../transpiler/rsp-recovery.js';
import { loadSm64Cartridge } from './cartridge.js';
import { compareAudioTask, randomAudioCases, sm64AudioMicrocode } from './audio-play.js';

test('SM64 EU play-tier audio matches the original audio microcode on random tasks', async (t) => {
  try {
    await access(join(repositoryRoot, 'roms/n64/sm64/nus-nsmp-0.u1'));
  } catch {
    t.skip('The pinned SM64 cartridge is not installed.');
    return;
  }
  const { rom } = await loadSm64Cartridge({});
  const text = rom.subarray(sm64AudioMicrocode.text, sm64AudioMicrocode.text + 0x1000),
    data = rom.subarray(
      sm64AudioMicrocode.data,
      sm64AudioMicrocode.data + sm64AudioMicrocode.dataBytes,
    );
  assert.equal(fnv1a(text, 0, aspMainMicrocode.codeBytes), aspMainMicrocode.code);
  assert.equal(fnv1a(data, 0, aspMainMicrocode.dataBytes), aspMainMicrocode.data);
  const recovery = new RspRecovery('play-audio-differential');
  let handled = 0;
  for (const item of randomAudioCases(1, 450)) {
    const result = compareAudioTask(text, data, recovery, item);
    assert.ok(result.passed, `${result.name}: ${result.detail}`);
    handled += Number(result.handled);
  }
  // Most generated buffers are inside the envelope; a few are not on purpose.
  assert.ok(handled > 350, `only ${handled} of 450 tasks stayed on the implementation`);
});
