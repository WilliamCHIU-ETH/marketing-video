'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const test = require('node:test');

function readOnlyCapabilities() {
  const args = ['capabilities', '--json'];
  assert.deepEqual(args, ['capabilities', '--json'], 'conformance must remain read-only');
  return new Promise((resolve, reject) => {
    execFile('chipk-capture', args, {
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        error.message = `${error.message}\nstderr: ${stderr}`;
        reject(error);
        return;
      }
      try { resolve(JSON.parse(stdout)); } catch (parseError) {
        parseError.message = `Provider capabilities were not JSON: ${parseError.message}`;
        reject(parseError);
      }
    });
  });
}

function exactlyOne(values, predicate, label) {
  const matches = values.filter(predicate);
  assert.equal(matches.length, 1, `expected exactly one ${label}`);
  return matches[0];
}

test('Provider 0.3.1 read-only capabilities conform to frozen v1/v2 coverage', {
  timeout: 15000,
}, async () => {
  const capabilities = await readOnlyCapabilities();
  assert.equal(capabilities.schemaVersion, 1);
  assert.equal(capabilities.providerId, 'chipk-simulator-capture');
  assert.equal(capabilities.toolVersion, '0.3.1');

  assert.deepEqual(capabilities.operations, ['screenshot', 'record']);
  assert.deepEqual(capabilities.contracts, {
    request: 'contracts/capture-request.schema.json',
    result: 'contracts/capture-result.schema.json',
  });
  assert.ok(Array.isArray(capabilities.contractCapabilities));
  assert.deepEqual(
    capabilities.contractCapabilities.map((entry) => entry.contractVersion),
    [1, 2],
  );

  const v1 = exactlyOne(
    capabilities.contractCapabilities,
    (entry) => entry?.contractVersion === 1,
    'contract v1 capability',
  );
  assert.deepEqual(v1.operations, ['screenshot', 'record']);
  assert.ok(v1.operations.includes('screenshot'));
  assert.equal(v1.requestSchema, 'contracts/capture-request.schema.json');
  assert.equal(v1.resultSchema, 'contracts/capture-result.schema.json');
  assert.ok(Array.isArray(v1.routeInventory));

  const realtime = exactlyOne(
    v1.routeInventory,
    (route) => route?.id === 'chipk.stock.realtime',
    'chipk.stock.realtime route',
  );
  const realtimeScreenshot = exactlyOne(
    realtime.operations,
    (operation) => operation?.operation === 'screenshot',
    'chipk.stock.realtime screenshot operation',
  );
  assert.deepEqual(realtimeScreenshot.requiredParameters, ['stockId']);
  assert.equal(realtimeScreenshot.stockIdSupport?.scope, 'open');
  assert.equal(
    realtimeScreenshot.stockIdSupport?.constraint,
    'catalog_stock_directory',
  );

  const v2 = exactlyOne(
    capabilities.contractCapabilities,
    (entry) => entry?.contractVersion === 2,
    'contract v2 capability',
  );
  assert.deepEqual(v2.operations, ['prepared-video']);
  assert.equal(v2.requestSchema, 'contracts/capture-request-v2.schema.json');
  assert.equal(v2.resultSchema, 'contracts/capture-result-v2.schema.json');
  const profile = exactlyOne(
    v2.presentationProfiles,
    (item) => item?.id === 'chipk.stock-main-force-portrait.v1',
    'chipk.stock-main-force-portrait.v1 profile',
  );
  assert.deepEqual(profile.stockIds, ['3441']);
});
