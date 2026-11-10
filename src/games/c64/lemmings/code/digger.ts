import { readLevelByte as read, sampleTerrain, type RecoveredMemory } from './level-data.js';

export interface LemmingState {
  x: number;
  y: number;
  mode: number;
  animation: number;
  extra: number;
}
export interface TerrainWrite {
  address: number;
  before: number;
  after: number;
}
export interface MutableLevelMemory extends RecoveredMemory {
  write?: (address: number, value: number) => void;
}

export function readLemming(memory: RecoveredMemory, index: number): LemmingState {
  if (!Number.isInteger(index) || index < 0 || index >= 50) {
    throw new Error('Lemming index must be 0–49.');
  }
  const animation = read(memory, 0x456 + index);
  return {
    x: (animation & 1) * 256 + read(memory, 0x488 + index),
    y: read(memory, 0x4ba + index),
    mode: read(memory, 0x424 + index),
    animation,
    extra: read(memory, 0x51e + index),
  };
}

/** $1568 renders two decimal digits. $DFA0 borrows from tens when units are
 * zero. An unavailable skill is displayed with the paired blank code 10/10. */
export function readSkillStock(memory: RecoveredMemory, slot: number): number {
  if (!Number.isInteger(slot) || slot < 0 || slot > 7) {
    throw new Error('Skill slot must be 0–7.');
  }
  const tens = read(memory, 0x5c8 + slot),
    units = read(memory, 0x5d2 + slot);
  if (tens === 10 && units === 10) {
    return 0;
  }
  if (tens > 9 || units > 9) {
    throw new Error('Unsupported skill-stock digits.');
  }
  return tens * 10 + units;
}

/** Raised from $164C–$167B and the trainers-disabled path through $DFA0.
 * The caller must already have selected this entity with the cursor. Falling,
 * digging, blocker states and the excluded $10 state reject this assignment.
 * This is game state only; it does not promise original CPU flags or timing. */
export function assignDigger(actor: LemmingState, stock: number) {
  if (!Number.isInteger(stock) || stock < 0 || stock > 99) {
    throw new Error('Skill stock must be 0–99.');
  }
  const mode = actor.mode & 31;
  if (!stock || mode === 2 || mode === 6 || (mode & 30) === 0 || (mode & 30) === 16) {
    return { assigned: false, actor: { ...actor }, stock };
  }
  return {
    assigned: true,
    actor: {
      ...actor,
      mode: (actor.mode & 0xc0) | 6,
      animation: actor.animation & 7,
      extra: actor.extra & 128,
    },
    stock: stock - 1,
  };
}

/** $2930 clears a pair in the world bitmap and, for a visible column, in the
 * separate display bitmap. Preserve the display byte's other pairs: it can
 * also contain composited graphics. An already empty world pair skips both
 * stores ($2995–$299A); an actual edit can still store an unchanged display
 * value. The returned writes preserve these original STA paths. */
export function eraseTerrainPair(memory: MutableLevelMemory, x: number, y: number) {
  const sample = sampleTerrain(memory, x, y);
  const writes: TerrainWrite[] = [];
  if (!sample.pair) {
    return { occupied: false, writes };
  }
  const store = (address: number): void => {
    const before = read(memory, address),
      after = before & ~sample.mask;
    writes.push({ address, before, after });
    if (memory.write) {
      memory.write(address, after);
    } else {
      memory.bytes[address] = after;
      memory.known[address] = 1;
    }
  };
  const high = sample.address >>> 8;
  if (high >= 0x80 && high < 0xb4) {
    store(sample.address);
    const visibleColumn = Math.floor(x / 4) - read(memory, 0x40d);
    if (visibleColumn >= 0 && visibleColumn < 24) {
      store(0x6000 | (sample.address & 0xfff));
    }
  }
  return { occupied: sample.pair !== 0, writes };
}

/** One original digger handler call ($244A–$24EE), before the common movement
 * and animation tail. Animation tables describe the pixels cleared by each
 * stroke. Reaching the final point ends a cut: move down if any terrain was
 * found, otherwise switch to falling. The ordinary first-level terrain path
 * has $E07C=0; steel/special-terrain handling is deliberately outside this lift. */
export function updateDiggerStroke(memory: MutableLevelMemory, actor: LemmingState) {
  if ((actor.mode & 31) !== 6 || actor.animation >>> 3 >= 16) {
    throw new Error('Expected a digger in a reviewed animation frame.');
  }
  if (read(memory, 0xe07c) !== 0) {
    throw new Error('Special-terrain digger behavior has not been raised.');
  }
  let mode = actor.mode & 0xdf,
    animation = actor.animation,
    extra = actor.extra,
    erasedSamples = 0;
  const writes: TerrainWrite[] = [];
  const phase = (frame: number): boolean => {
    const count = read(memory, 0x3f98 + frame);
    if (!count) {
      return false;
    }
    let point = read(memory, 0x3fa8 + frame);
    for (let remaining = count; remaining > 0; remaining--) {
      const dx = read(memory, 0x3fb8 + point),
        dy = read(memory, 0x4bf2 + point);
      const edit = eraseTerrainPair(memory, actor.x + dx, actor.y + dy);
      if (edit.occupied) {
        extra = (extra + 1) & 255;
        erasedSamples++;
      }
      writes.push(...edit.writes);
      if (++point === 13) {
        return true;
      }
    }
    return false;
  };
  const frame = animation >>> 3;
  const cutFinished = phase(frame) || phase(frame + 1);
  let movementIndex = 8;
  if (cutFinished) {
    if (!extra) {
      mode = (mode & 0xc0) | 2;
      animation &= 7;
      movementIndex = 7;
    } else {
      movementIndex = 10;
    }
    extra = 0;
  }
  return { actor: { ...actor, mode, animation, extra }, movementIndex, erasedSamples, writes };
}
