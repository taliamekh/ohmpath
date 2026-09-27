const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync('apps/desktop/src/renderer/camera-framing-geometry.ts', 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
}).outputText;
const context = {exports: {}, Math, Number};
vm.runInNewContext(compiled, context);
const {framedImageBox, pointInFrame} = context.exports;

function renderedPoint(box, x, y) {
  return {x: box.left + box.width * x, y: box.top + box.height * y};
}

test('portrait ROI maps both axes back to normalized original-image coordinates', () => {
  const source = {width: 1080, height: 1920};
  const stage = {width: 460, height: 300};
  const region = {x: .21, y: .62, width: .58, height: .22};
  const box = framedImageBox(stage.width, stage.height, source.width, source.height, region);
  for (const [x, y] of [[.21, .62], [.5, .73], [.79, .84]]) {
    const display = renderedPoint(box, x, y);
    const result = pointInFrame(display.x, display.y, box, region);
    assert.ok(result);
    assert.ok(Math.abs(result.x - x) < 1e-10);
    assert.ok(Math.abs(result.y - y) < 1e-10);
    assert.ok(display.x >= -1e-7 && display.x <= stage.width + 1e-7);
    assert.ok(display.y >= -1e-7 && display.y <= stage.height + 1e-7);
  }
  assert.equal(pointInFrame(box.left + box.width * .1, box.top + box.height * .7, box, region), null);
});

test('letterboxed whole portrait rejects a click in the unused sidebars', () => {
  const box = framedImageBox(600, 300, 1080, 1920);
  const visibleLeft = box.left;
  const visibleRight = box.left + box.width;
  assert.ok(visibleLeft > 0 && visibleRight < 600);
  assert.equal(pointInFrame(5, 150, box), null);
  assert.equal(pointInFrame(595, 150, box), null);
  const center = pointInFrame(300, 150, box);
  assert.ok(center);
  assert.ok(Math.abs(center.x - .5) < 1e-10);
  assert.ok(Math.abs(center.y - .5) < 1e-10);
});

test('ROI letterbox rejects click outside vertical image while retaining global coordinates', () => {
  const region = {x: .3, y: .3, width: .4, height: .2};
  const box = framedImageBox(300, 500, 1000, 1000, region);
  const top = box.top + box.height * region.y;
  assert.ok(top > 0);
  assert.equal(pointInFrame(150, top - 8, box, region), null);
  const center = pointInFrame(150, 250, box, region);
  assert.ok(center);
  assert.ok(Math.abs(center.x - .5) < 1e-10);
  assert.ok(Math.abs(center.y - .4) < 1e-10);
});
