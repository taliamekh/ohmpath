const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createQuitGate } = require('../../apps/desktop/src/main/quit-gate.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('repeat quit requests wait for listener and helper shutdown, even without a bench process', async () => {
  let finish;
  let calls = 0, quits = 0, prevented = 0;
  const cleanup = new Promise(resolve => { finish = resolve; });
  const guard = createQuitGate(() => { calls++; return cleanup; }, () => { quits++; });
  const event = { preventDefault() { prevented++; } };
  guard(event); guard(event);
  await tick();
  assert.equal(calls, 1); assert.equal(quits, 0); assert.equal(prevented, 2);
  finish(); await tick();
  assert.equal(quits, 1);
  guard(event); assert.equal(prevented, 2);
});

test('cleanup failure releases the quit gate once', async () => {
  let quits = 0;
  const guard = createQuitGate(() => { throw new Error('already closed'); }, () => { quits++; });
  guard({ preventDefault() {} }); await tick();
  assert.equal(quits, 1);
});
