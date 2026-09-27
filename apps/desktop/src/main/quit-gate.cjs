// Electron may emit before-quit again while asynchronous cleanup is pending.
function createQuitGate(cleanup, quit) {
  let pending = null;
  let complete = false;
  return event => {
    if (complete) return;
    event.preventDefault();
    if (pending) return;
    pending = Promise.resolve().then(cleanup).catch(() => undefined).then(() => {
      complete = true;
      quit();
    });
  };
}
module.exports = { createQuitGate };
