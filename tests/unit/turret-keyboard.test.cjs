const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function setup(sendOverride) {
  const calls = [], errors = []; let tick;
  const compiled = ts.transpileModule(fs.readFileSync('apps/desktop/src/renderer/turret-keyboard.ts', 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}
  }).outputText;
  const context = {exports: {}, setInterval: fn => {tick = fn; return 1;}, clearInterval: () => {tick = undefined;}};
  vm.runInNewContext(compiled, context);
  const control = new context.exports.TurretKeyboard(async intent => {calls.push({...intent}); await sendOverride?.(intent);}, e => errors.push(e));
  return {control, calls, errors, tick: () => tick?.()};
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('held arrows refresh, diagonals combine, opposing keys cancel, release holds', async () => {
  const {control, calls, tick} = setup();
  assert.equal(control.key('ArrowRight', true), false);
  control.start('new-session');
  control.key('ArrowRight', true); await settle();
  tick(); await settle();
  assert.equal(calls.length, 2); assert.equal(calls[1].yaw, 1);
  control.key('ArrowRight', true); await settle(); assert.equal(calls.length, 2);
  control.key('ArrowUp', true); await settle(); assert.equal(calls.at(-1).pitch, 1);
  control.key('ArrowLeft', true); await settle(); assert.equal(calls.at(-1).yaw, 0);
  control.key('ArrowLeft', false); control.key('ArrowRight', false); control.key('ArrowUp', false);
  await settle();
  assert.equal(calls.at(-1).yaw, 0); assert.equal(calls.at(-1).pitch, 0);
  const count = calls.length; tick(); await settle(); assert.equal(calls.length, count);
  assert.ok(calls.every((v, i) => v.sequence === i + 1)); control.stop();
});

test('slow requests do not queue old directions and stop discards pending keys', async () => {
  let resolve; const {control, calls, tick} = setup(() => new Promise(r => {resolve = r;}));
  control.start('session'); control.key('ArrowRight', true); tick(); tick();
  control.key('ArrowRight', false);
  assert.equal(calls.length, 1);
  resolve(); await settle();
  assert.equal(calls.length, 2); assert.equal(calls[1].yaw, 0);
  control.key('ArrowUp', true); control.stop(); resolve(); await settle(); tick();
  assert.equal(calls.length, 2);
});

test('direction preferences apply and a failed request revokes keyboard input', async () => {
  const {control, calls, errors, tick} = setup(async () => {throw new Error('connection lost');});
  control.configure(true, true, true); control.start('session'); control.key('ArrowUp', true);
  await settle(); assert.equal(calls[0].fine, true); assert.equal(calls[0].pitch, -1);
  assert.equal(errors.length, 1); tick(); assert.equal(control.key('ArrowLeft', true), false);
  assert.equal(calls.length, 1);
});
