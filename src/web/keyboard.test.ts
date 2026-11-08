import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserKey } from './keyboard.js';
test('Mac Delete, forward Delete, numeric keypad and ordinary keys normalize consistently', () => {
  assert.equal(browserKey({ code: 'Backspace', key: 'Backspace' }), 'Delete');
  assert.equal(browserKey({ code: 'Delete', key: 'Delete' }), 'Delete');
  assert.equal(browserKey({ code: 'Numpad8', key: '8' }), 'Digit8');
  assert.equal(browserKey({ code: '', key: ' ' }), 'Space');
  assert.equal(browserKey({ code: 'ArrowLeft', key: 'ArrowLeft' }), 'ArrowLeft');
});
