import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from './learn.js';

test('learning pages escape source code/HTML and reject executable links', () => {
  const html = renderMarkdown(
    '# A routine\n\n<script>alert(1)</script>\n\n[x](javascript:alert)\n\n```ts\nif (x < 4) {}\n```',
  );
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(html.includes('x &lt; 4'));
  assert.ok(html.includes('<h2>A routine</h2>'));
});
test('documentation tables and mapped chapter links remain navigable', () => {
  const html = renderMarkdown(
    '| Address | Role |\n| --- | --- |\n| `$1234` | [boot](BOOT.md) |',
    () => '/c64/example/learn/boot',
  );
  assert.ok(html.includes('<table>'));
  assert.ok(html.includes('<code>$1234</code>'));
  assert.ok(html.includes('href="/c64/example/learn/boot"'));
});
