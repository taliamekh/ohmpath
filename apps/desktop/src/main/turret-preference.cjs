const fs = require('node:fs');
const path = require('node:path');

function createTurretPreference(filePath) {
  let enabled = false;
  try {
    if (fs.statSync(filePath).size <= 1000) enabled = JSON.parse(fs.readFileSync(filePath, 'utf8')).enabled === true;
  } catch { /* Missing or damaged preferences fail closed. */ }
  const status = () => ({ enabled, connected: false, motion_enabled: false, laser_enabled: false,
    state: enabled ? 'awaiting_hardware_setup' : 'off' });
  return {
    status,
    set(value) {
      if (typeof value !== 'boolean') throw new Error('Choose whether to use the turret.');
      // This preference never arms hardware. A future hardware adapter must also
      // require this flag and the independent local safety/acceptance gates.
      if (!value) enabled = false;
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temporary = filePath + '.tmp';
      fs.writeFileSync(temporary, JSON.stringify({ enabled: value }), { mode: 0o600 });
      fs.renameSync(temporary, filePath);
      enabled = value;
      return status();
    },
  };
}
module.exports = { createTurretPreference };
