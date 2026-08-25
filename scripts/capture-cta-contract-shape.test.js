'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const PROVIDER_LOCK = require('../config/chipk-capture-provider.lock.json');
const {
  CaptureCliAdapterError,
  validateProviderCapabilities,
} = require('../server/chipk-capture-cli-adapter');

const LOCKED_TOOL_VERSION = PROVIDER_LOCK.toolVersion;
const CAPABILITIES = {
  schemaVersion: 1,
  providerId: 'chipk-simulator-capture',
  toolVersion: LOCKED_TOOL_VERSION,
  productionReady: true,
  operations: ['screenshot', 'record'],
  contractCapabilities: [
    {
      contractVersion: 1,
      operations: ['screenshot', 'record'],
      requestSchema: 'contracts/capture-request.schema.json',
      resultSchema: 'contracts/capture-result.schema.json',
    },
    {
      contractVersion: 2,
      operations: ['prepared-video'],
      requestSchema: 'contracts/capture-request-v2.schema.json',
      resultSchema: 'contracts/capture-result-v2.schema.json',
      presentationProfiles: [{
        id: 'chipk.stock-main-force-portrait.v1',
        version: 1,
        status: 'ready_to_place',
        sourceKind: 'screenshot',
        routeIds: ['chipk.stock.main-force'],
        stockIds: ['3441'],
        artifactRole: 'prepared-video',
      }],
    },
  ],
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function incompatible(value) {
  assert.throws(
    () => validateProviderCapabilities(value),
    (error) => error instanceof CaptureCliAdapterError
      && error.code === 'provider_contract_incompatible',
  );
}

test('legacy operations and v1/v2 schema fields retain the frozen capability shape', () => {
  const value = clone(CAPABILITIES);
  const before = clone(value);
  assert.equal(validateProviderCapabilities(value), value);
  assert.deepEqual(value, before, 'validation must not rewrite Provider capabilities');
  assert.deepEqual(value.operations, ['screenshot', 'record']);
  assert.deepEqual(value.contractCapabilities.map((entry) => entry.contractVersion), [1, 2]);

  const v1 = value.contractCapabilities[0];
  assert.deepEqual(v1, {
    contractVersion: 1,
    operations: ['screenshot', 'record'],
    requestSchema: 'contracts/capture-request.schema.json',
    resultSchema: 'contracts/capture-result.schema.json',
  });

  const v2 = value.contractCapabilities[1];
  assert.deepEqual({
    contractVersion: v2.contractVersion,
    operations: v2.operations,
    requestSchema: v2.requestSchema,
    resultSchema: v2.resultSchema,
  }, {
    contractVersion: 2,
    operations: ['prepared-video'],
    requestSchema: 'contracts/capture-request-v2.schema.json',
    resultSchema: 'contracts/capture-result-v2.schema.json',
  });
});

test('operation drift or missing existing schema fields fails closed', () => {
  const mutations = [
    (value) => { value.operations = ['record', 'screenshot']; },
    (value) => { value.operations.push('prepared-video'); },
    (value) => { value.contractCapabilities[0].operations = ['screenshot']; },
    (value) => { delete value.contractCapabilities[0].requestSchema; },
    (value) => { delete value.contractCapabilities[0].resultSchema; },
    (value) => { value.contractCapabilities[1].operations.push('record'); },
    (value) => { delete value.contractCapabilities[1].requestSchema; },
    (value) => { delete value.contractCapabilities[1].resultSchema; },
  ];
  for (const mutate of mutations) {
    const value = clone(CAPABILITIES);
    mutate(value);
    incompatible(value);
  }
});

test('chipk.stock-main-force-portrait.v1 stockIds stay exactly ["3441"]', () => {
  const profile = CAPABILITIES.contractCapabilities[1].presentationProfiles[0];
  assert.deepEqual(profile.stockIds, ['3441']);
  for (const stockIds of [[], ['2426'], ['3441', '2426'], ['3441', '3441']]) {
    const value = clone(CAPABILITIES);
    value.contractCapabilities[1].presentationProfiles[0].stockIds = stockIds;
    incompatible(value);
  }
});
