const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { createTurretPreference } = require('../../apps/desktop/src/main/turret-preference.cjs');

test('turret preference persists without enabling motion or laser', t => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'ohmpath-turret-preference-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'turret.json');
  const preference = createTurretPreference(file);
  assert.equal(preference.status().enabled, false);
  assert.deepEqual(preference.set(true), { enabled: true, connected: false, motion_enabled: false, laser_enabled: false, state: 'awaiting_hardware_setup' });
  assert.equal(createTurretPreference(file).status().enabled, true);
  preference.set(false);
  assert.equal(createTurretPreference(file).status().enabled, false);
  assert.throws(() => preference.set('true'));
  fs.writeFileSync(file, 'broken');
  assert.equal(createTurretPreference(file).status().enabled, false);
});
