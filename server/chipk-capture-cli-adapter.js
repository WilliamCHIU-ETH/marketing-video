'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const PROVIDER_LOCK = Object.freeze(require('../config/chipk-capture-provider.lock.json'));

const RESULT_STATUSES = new Set(['completed', 'rejected', 'failed', 'human_action_required']);

class CaptureCliAdapterError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CaptureCliAdapterError';
    this.code = code;
  }
}

function parseJson(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  try { return JSON.parse(text); } catch (_) { return null; }
}

function typedStderrCode(stderr) {
  const parsed = parseJson(stderr);
  const code = parsed && parsed.error && parsed.error.code;
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(code) ? code : null;
}

function runJson(command, args, { timeoutMs, runner, acceptResultOnNonzero = false }) {
  return new Promise((resolve, reject) => {
    runner(command, args, {
      encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1024 * 1024,
      windowsHide: true, env: process.env,
    }, (error, stdout, stderr) => {
      const value = parseJson(stdout);
      if (!error) {
        if (value === null) {
          reject(new CaptureCliAdapterError(
            'ChipK Capture CLI returned invalid JSON', 'provider_invalid_json'));
          return;
        }
        if (acceptResultOnNonzero && value.status !== 'completed') {
          reject(new CaptureCliAdapterError(
            'ChipK Capture CLI exit status disagrees with its result',
            'provider_exit_status_mismatch'));
          return;
        }
        resolve(value);
        return;
      }
      if (acceptResultOnNonzero && !error.killed && !error.signal
          && Number(error.code) === 3 && value
          && RESULT_STATUSES.has(value.status) && value.status !== 'completed') {
        resolve(value);
        return;
      }
      let code = typedStderrCode(stderr);
      if (error.code === 'ENOENT') code = 'provider_unavailable';
      else if (error.killed || error.code === 'ETIMEDOUT') code = 'provider_timeout';
      reject(new CaptureCliAdapterError(
        'ChipK Capture CLI invocation failed', code || 'provider_cli_failed'));
    });
  });
}

function validateProviderCapabilities(value, expected = PROVIDER_LOCK) {
  if (!value || value.providerId !== expected.providerId
      || value.schemaVersion !== expected.capabilitySchemaVersion
      || typeof value.toolVersion !== 'string' || !value.toolVersion.trim()
      || !Array.isArray(value.operations)
      || !Array.isArray(value.contractCapabilities)) {
    throw new CaptureCliAdapterError(
      'ChipK Capture CLI returned an incompatible capability document',
      'provider_contract_incompatible');
  }
  if (value.toolVersion !== expected.toolVersion) {
    throw new CaptureCliAdapterError(
      'ChipK Capture CLI version does not match the consumer lock',
      'provider_version_incompatible');
  }
  for (const [versionText, contractLock] of Object.entries(expected.contracts || {})) {
    const version = Number(versionText);
    const matches = value.contractCapabilities.filter(
      (item) => item && item.contractVersion === version,
    );
    if (matches.length !== 1) {
      throw new CaptureCliAdapterError(
        `ChipK Capture CLI must advertise Contract v${version} exactly once`,
        'provider_contract_incompatible');
    }
    const capability = matches[0];
    if (!Array.isArray(capability.operations)
        || contractLock.operations.some((operation) => !capability.operations.includes(operation))
        || capability.requestSchema !== contractLock.requestSchema
        || capability.resultSchema !== contractLock.resultSchema) {
      throw new CaptureCliAdapterError(
        `ChipK Capture CLI Contract v${version} capability is incompatible`,
        'provider_contract_incompatible');
    }
    if (version === 2) {
      const profiles = capability.presentationProfiles;
      const validProfiles = Array.isArray(profiles) && profiles.length > 0
        && new Set(profiles.map((profile) => profile?.id)).size === profiles.length
        && profiles.every((profile) => (
          profile && typeof profile.id === 'string' && profile.id.trim()
          && Number.isInteger(profile.version) && profile.version > 0
          && profile.status === 'ready_to_place'
          && profile.sourceKind === 'screenshot'
          && Array.isArray(profile.routeIds) && profile.routeIds.length > 0
          && profile.routeIds.every((routeId) => typeof routeId === 'string' && routeId.trim())
          && Array.isArray(profile.stockIds) && profile.stockIds.length > 0
          && profile.stockIds.every((stockId) => typeof stockId === 'string' && stockId.trim())
          && profile.artifactRole === 'prepared-video'
        ));
      if (!validProfiles) {
        throw new CaptureCliAdapterError(
          'ChipK Capture CLI Contract v2 presentation profile capability is incompatible',
          'provider_contract_incompatible');
      }
    }
  }
  return value;
}

async function probeChipKCaptureCli({
  command = process.env.CHIPK_CAPTURE_BIN || 'chipk-capture',
  timeoutMs = 5000,
  runner = execFile,
} = {}) {
  const value = await runJson(command, ['capabilities', '--json'], { timeoutMs, runner });
  return validateProviderCapabilities(value);
}

function writeRequestFile(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
      || !path.isAbsolute(request.outputDirectory || '')) {
    throw new CaptureCliAdapterError('Capture request is invalid', 'invalid_request');
  }
  const outputDirectory = path.resolve(request.outputDirectory);
  let stat;
  try { stat = fs.lstatSync(outputDirectory); } catch (_) {}
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink())
    throw new CaptureCliAdapterError('Capture output directory is invalid', 'invalid_request');
  const file = path.join(outputDirectory,
    `.request-${process.pid}-${crypto.randomBytes(8).toString('hex')}.json`);
  fs.writeFileSync(file, JSON.stringify(request), { flag: 'wx', mode: 0o600 });
  return file;
}

function createChipKCaptureCliAdapter({
  command = process.env.CHIPK_CAPTURE_BIN || 'chipk-capture',
  probeTimeoutMs = 5000,
  acquireTimeoutMs = 120000,
  runner = execFile,
} = {}) {
  return {
    capabilities: () => probeChipKCaptureCli({ command, timeoutMs: probeTimeoutMs, runner }),
    async acquire(request) {
      const requestFile = writeRequestFile(request);
      try {
        return await runJson(command, ['acquire', '--request', requestFile, '--json'], {
          timeoutMs: acquireTimeoutMs, runner, acceptResultOnNonzero: true,
        });
      } finally {
        try { fs.unlinkSync(requestFile); } catch (_) {}
      }
    },
  };
}

module.exports = {
  CaptureCliAdapterError,
  PROVIDER_LOCK,
  createChipKCaptureCliAdapter,
  probeChipKCaptureCli,
  validateProviderCapabilities,
};
