'use strict';

/**
 * Permanently stop legacy one-off scripts before they load dotenv, inspect provider credentials,
 * upload assets, run MiniMax, or call a paid create endpoint. Keeping the old script body below the
 * call site preserves its historical implementation in Git without leaving an executable bypass.
 */
function stopRetiredPaidProviderScript(scriptName) {
  const safeName = String(scriptName || 'unknown-script').replace(/[^A-Za-z0-9._-]/g, '');
  process.stderr.write(
    `PAID_PROVIDER_SCRIPT_RETIRED: ${safeName} is disabled. `
      + 'Use run.js with an explicit Project/Run or EXP/Revision identity; use --dry-run first.\n',
  );
  process.exit(2);
}

module.exports = { stopRetiredPaidProviderScript };
