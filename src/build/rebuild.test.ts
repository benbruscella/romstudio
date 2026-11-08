import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rebuildQueue } from './rebuild.js';

test('changes during a pending build coalesce and never overlap manifest writers', async () => {
  const finish: (() => void)[] = [];
  let calls = 0,
    active = 0,
    peak = 0;
  const queue = rebuildQueue(
    async () => {
      calls++;
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => {
        finish.push(resolve);
      });
      active--;
    },
    (error) => {
      throw error;
    },
  );
  queue.request();
  queue.request();
  queue.request();
  assert.equal(calls, 1);
  finish.shift()!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(peak, 1);
  queue.request();
  queue.close();
  finish.shift()!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(active, 0);
});

test('a failed rebuild is reported and the next request can recover', async () => {
  const errors: unknown[] = [];
  let calls = 0;
  const queue = rebuildQueue(
    async () => {
      calls++;
      if (calls === 1) {
        throw new Error('Changed input');
      }
    },
    (error) => {
      errors.push(error);
    },
  );
  queue.request();
  await new Promise<void>((resolve) => setImmediate(resolve));
  queue.request();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /Changed input/);
  queue.close();
});
