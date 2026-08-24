#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProjectStore } = require('../server/project-store');
const {
  CaptureCliAdapterError,
  PROVIDER_LOCK,
  createChipKCaptureCliAdapter,
  probeChipKCaptureCli,
  validateProviderCapabilities,
} = require('../server/chipk-capture-cli-adapter');
const { normalizeMaterialAcquisitionIntent } = require('../server/material-acquisition');
const { prepareJobMaterialAcquisition } = require('../server/material-acquisition-runtime');

function providerBinFromArgs(args) {
  if (args.length !== 2 || args[0] !== '--provider-bin' || !args[1]) {
    throw new Error('Usage: npm run test:chipk-provider-compat -- --provider-bin <absolute-conformance-cli>');
  }
  const command = args[1];
  if (!path.isAbsolute(command)) throw new Error('--provider-bin must be an absolute path');
  const stat = fs.lstatSync(command);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0) {
    throw new Error('--provider-bin must be an executable regular file');
  }
  if (path.basename(command) !== 'conformance-cli.js'
      || path.basename(path.dirname(command)) !== 'test') {
    throw new Error('--provider-bin must point to the provider-owned test/conformance-cli.js');
  }
  return command;
}

function assertVersionMismatch(capabilities) {
  const mismatchedLock = { ...PROVIDER_LOCK, toolVersion: `${PROVIDER_LOCK.toolVersion}-mismatch` };
  assert.throws(
    () => validateProviderCapabilities(capabilities, mismatchedLock),
    (error) => error instanceof CaptureCliAdapterError
      && error.code === 'provider_version_incompatible',
  );
}

async function runConnectedScreenshot(providerBin, root) {
  let id = 0;
  const dataDir = path.join(root, 'data');
  const projectStore = createProjectStore({
    dataDir,
    nowISO: () => '2026-08-21T00:00:00.000Z',
    idFactory: () => `compat-${++id}`,
  });
  const project = projectStore.create({
    name: 'ChipK provider compatibility', template: 'default', owner: 'compatibility-test',
  });
  const jobDirectory = path.join(dataDir, 'jobs', 'compat-job');
  fs.mkdirSync(path.join(jobDirectory, 'input'), { recursive: true });
  const job = {
    id: 'compat-job',
    projectId: project.id,
    assetRefs: [],
    materialAcquisition: normalizeMaterialAcquisitionIntent({
      policy: 'require-capture',
      operation: 'screenshot',
      mode: 'test',
      route: 'chipk.stock.health-check',
      stock: { id: '2330', name: '台積電' },
    }),
  };
  const summary = await prepareJobMaterialAcquisition({
    job,
    jobDirectory,
    projectStore,
    requestIdFactory: () => 'compat-request-1',
    nowISO: () => '2026-08-21T00:00:01.000Z',
    saveJob: () => {},
    provider: createChipKCaptureCliAdapter({ command: providerBin }),
  });
  const savedProject = projectStore.get(project.id);
  assert.equal(summary.status, 'acquired');
  assert.equal(summary.contractVersion, 1);
  assert.equal(summary.providerVersion, PROVIDER_LOCK.toolVersion);
  assert.equal(savedProject.assets.some((asset) => asset.id === summary.artifact.assetRef), true);
  assert.equal(job.assetRefs.includes(summary.artifact.assetRef), true);
  assert.equal(fs.existsSync(path.join(jobDirectory, 'input', summary.artifact.inputName)), true);
}

async function runConnectedPreparedVideo(providerBin, root) {
  let id = 100;
  const dataDir = path.join(root, 'prepared-data');
  const projectStore = createProjectStore({
    dataDir,
    nowISO: () => '2026-08-21T00:00:00.000Z',
    idFactory: () => `compat-${++id}`,
  });
  const project = projectStore.create({
    name: 'ChipK v2 compatibility', template: 'default', owner: 'compatibility-test',
  });
  const jobDirectory = path.join(dataDir, 'jobs', 'prepared-job');
  fs.mkdirSync(path.join(jobDirectory, 'input'), { recursive: true });
  const job = {
    id: 'prepared-job', projectId: project.id, assetRefs: [],
    materialAcquisition: normalizeMaterialAcquisitionIntent({
      policy: 'require-capture', operation: 'prepared-video', mode: 'test',
      route: 'chipk.stock.main-force', stock: { id: '3441' },
      presentation: { profileId: 'chipk.stock-main-force-portrait.v1' },
    }),
  };
  const summary = await prepareJobMaterialAcquisition({
    job,
    jobDirectory,
    projectStore,
    requestIdFactory: () => 'compat-request-v2-1',
    nowISO: () => '2026-08-21T00:00:01.000Z',
    saveJob: () => {},
    provider: createChipKCaptureCliAdapter({ command: providerBin }),
  });
  const savedProject = projectStore.get(project.id);
  const asset = savedProject.assets.find((item) => item.id === summary.artifact.assetRef);
  assert.equal(summary.status, 'acquired');
  assert.equal(summary.contractVersion, 2);
  assert.equal(summary.providerVersion, PROVIDER_LOCK.toolVersion);
  assert.equal(summary.artifact.role, 'prepared-video');
  assert.equal(summary.presentation.profileId, 'chipk.stock-main-force-portrait.v1');
  assert.equal(summary.automaticTimelineUse, false);
  assert.equal(summary.artifacts.length, 5);
  assert.equal(asset.kind, 'video');
  assert.equal(asset.sha256, summary.artifact.sha256);
  assert.equal(job.assetRefs.includes(asset.id), true);
  assert.equal(fs.readdirSync(path.join(jobDirectory, 'input')).length, 0);
  assert.equal(fs.existsSync(path.join(jobDirectory, summary.evidenceFile)), true);
}

async function main() {
  const providerBin = providerBinFromArgs(process.argv.slice(2));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chipk-provider-compat-'));
  try {
    const capabilities = await probeChipKCaptureCli({ command: providerBin });
    assertVersionMismatch(capabilities);
    await runConnectedScreenshot(providerBin, root);
    await runConnectedPreparedVideo(providerBin, root);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      provider: {
        id: PROVIDER_LOCK.providerId,
        contractVersions: Object.keys(PROVIDER_LOCK.contracts).map(Number),
        toolVersion: PROVIDER_LOCK.toolVersion,
      },
      checks: {
        realCliJsonBoundary: true,
        exactVersionMismatchRejected: true,
        screenshotResultValidated: true,
        preparedVideoResultValidated: true,
        projectAssetsIngested: true,
        timelinePlacementClaimed: false,
      },
      runtime: 'synthetic-conformance',
      simulatorUsed: false,
    }, null, 2)}\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error: {
      code: typeof error?.code === 'string' ? error.code : 'compatibility_check_failed',
      message: error?.message || 'Compatibility check failed',
    },
  }, null, 2)}\n`);
  process.exitCode = 1;
});
