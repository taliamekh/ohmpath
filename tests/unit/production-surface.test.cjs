const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');

test('production has no scripted filming UI, routes, or screenshot motion presets', () => {
  for (const file of [
    'apps/desktop/src/main/main.cjs',
    'apps/desktop/src/renderer/App.tsx',
    'apps/desktop/src/renderer/PhotoHelpPage.tsx',
    'apps/desktop/src/renderer/TurretPage.tsx',
    'services/bench/src/ohmpath/api/turret.py',
    'services/bench/src/ohmpath/devices/turret.py',
  ]) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(source, /DemoRehearsal|motionDemo|filming-profile-update|film-supply|film-led|demo_points|Saved demo points|Open LED walkthrough/, file);
  }
  assert.equal(fs.existsSync(path.join(root, 'apps/desktop/src/renderer/DemoRehearsal.tsx')), false);
  const app = fs.readFileSync(path.join(root, 'apps/desktop/src/renderer/App.tsx'), 'utf8');
  assert.match(app, /id: "turret", label: "Turret control"/);
  assert.match(app, /tab === "turret" \? \(\s*<TurretPage/);
});
