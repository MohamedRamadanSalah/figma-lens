// Compare verdict (stop the fix loop) and prototype timing units.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verdictFor } from '../tools/compare.js';
import { triggerStr, msStr } from '../bridge/render-md.js';
import { DEFAULT_ALLOWED_TOOLS } from '../tools/auto.js';

test('check verdict: stop within the target, stop on a plateau, otherwise continue', () => {
  assert.deepEqual([verdictFor(2.2, 3.4).stop, verdictFor(2.2, 3.4).why], [true, 'target']);
  assert.equal(verdictFor(3, null).why, 'target');
  assert.deepEqual([verdictFor(5.1, 5.2).stop, verdictFor(5.1, 5.2).why], [true, 'plateau']);
  assert.equal(verdictFor(6, 5.4).why, 'plateau', 'worse than before is no improvement either');
  assert.equal(verdictFor(5, 7).stop, false);
  assert.equal(verdictFor(5, null).stop, false, 'first check above the target: continue');
  assert.match(verdictFor(5, null).text, /^CONTINUE/);
});

test('prototype trigger timing is in milliseconds (Figma Plugin API)', () => {
  assert.equal(msStr(300), '300ms');
  assert.equal(msStr(1500), '1.5s');
  assert.equal(triggerStr({ type: 'AFTER_TIMEOUT', timeout: 800 }), 'after delay 800ms');
  assert.match(triggerStr({ type: 'MOUSE_ENTER', delay: 2000 }), /\(delay 2s\)$/);
});

test('auto allows the read-only helpers real runs were denied (grep, sed, git log/show; never find, whose -exec/-delete get around the denials)', () => {
  for (const t of ['Bash(grep:*)', 'Bash(sed:*)', 'Bash(git log:*)', 'Bash(git show:*)']) assert.ok(DEFAULT_ALLOWED_TOOLS.includes(t), t);
  for (const t of ['Bash(rm:*)', 'Bash(git commit:*)', 'Bash(curl:*)', 'Bash(find:*)']) assert.ok(!DEFAULT_ALLOWED_TOOLS.includes(t), t);
});
