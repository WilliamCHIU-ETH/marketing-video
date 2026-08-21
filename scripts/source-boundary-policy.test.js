#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  MAX_DOC_IMAGE_BYTES,
  MAX_SANITIZED_FIXTURE_BYTES,
  scanRepository,
} = require('./source-boundary.test');

const BASE_IGNORE = `
/assets
/.cache/
/.data/
/.dual-tmp/
/.local/
/.remotion/
/.verify-dual-tmp/
/_frames_check/
/audio/
/backups/
/build/
/captures/
/coverage/
/exports/
/internal-snapshots/
/jobs/
/keychain-data/
/out/
/persona-values/
/provider-cache/
/public/jobs/
/recordings/
/runtime-data/
/screenshots/
/sessions/
/test-results/
/videos/
/成品/
`;

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function git(root, args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: options.encoding === undefined ? 'utf8' : options.encoding,
    env: options.environment || process.env,
    input: options.input,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${String(result.stderr || result.error || '')}`);
  }
  return result.stdout;
}

function writeEntry(root, relative, value) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value);
}

function makeRepository(t, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marketing-video-source-boundary-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  git(root, ['init', '--quiet']);
  writeEntry(root, '.gitignore', BASE_IGNORE);
  writeEntry(root, 'src/index.js', "'use strict';\nmodule.exports = true;\n");
  for (const [relative, value] of Object.entries(files)) writeEntry(root, relative, value);
  git(root, ['add', '--force', '--', '.']);
  return root;
}

function rulesFor(result, relative) {
  return result.findings
    .filter((finding) => finding.file === relative)
    .map((finding) => `${finding.rule}:${finding.origin}`);
}

function assertFinding(result, relative, rule, origin) {
  assert.ok(
    result.findings.some((finding) => finding.file === relative
      && finding.rule === rule
      && (origin === undefined || finding.origin === origin)),
    `expected ${rule}${origin ? `:${origin}` : ''} for ${relative}; got ${JSON.stringify(rulesFor(result, relative))}`,
  );
}

test('canonical clean source allows capped docs images and sanitized text fixtures', (t) => {
  const root = makeRepository(t, {
    'docs/images/architecture.png': PNG_1X1,
    'docs/images/architecture.svg': '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>\n',
    'fixtures/sanitized/project.json': '{"project":"fixture-project","revision":"V1"}\n',
  });
  const result = scanRepository({ root });
  assert.deepEqual(result.findings, []);
  assert.equal(result.trackedCount, 5);
});

test('sanitized fixtures reject real credentials, identities and non-example endpoints', (t) => {
  const credentialFieldName = ['api', 'Key'].join('');
  const secondaryCredentialField = ['client', 'Secret'].join('');
  const escapedCredentialField = ['api', '\\u004b', 'ey'].join('');
  const unsafeFixtureValue = ['live', 'secret', 'value'].join('-');
  const personaField = ['persona', ' name'].join('');
  const deceptiveFixtureValue = ['test', 'live', 'actual', 'provider', 'secret'].join('-');
  const root = makeRepository(t, {
    'fixtures/sanitized/safe.json': JSON.stringify({
      [credentialFieldName]: 'test-api-key',
      email: 'fixture@example.com',
      endpoint: 'https://api.example.com/catalog',
      projectId: 'test-project-1',
    }),
    'fixtures/sanitized/credentials.json': JSON.stringify({
      [credentialFieldName]: unsafeFixtureValue,
      [secondaryCredentialField]: ['live', 'client', 'secret'].join('-'),
    }),
    'fixtures/sanitized/escaped.json': `{"${escapedCredentialField}":"${unsafeFixtureValue}"}`,
    'fixtures/sanitized/nested.json': JSON.stringify({
      meta: {
        [credentialFieldName]: unsafeFixtureValue,
        endpoint: 'builder.company.internal',
        persona: 'Alice Chen',
      },
    }),
    'fixtures/sanitized/spaced-fields.json': JSON.stringify({
      'api key': unsafeFixtureValue,
      [personaField]: 'Alice Chen',
    }),
    'fixtures/sanitized/deceptive.json': JSON.stringify({
      [credentialFieldName]: deceptiveFixtureValue,
      persona: 'fixture Alice Chen',
    }),
    'fixtures/sanitized/duplicate.json': '{"meta":{"persona":"Alice Chen","persona":"fixture-persona","endpoint":"builder.company.internal","endpoint":"example.com"}}',
    'fixtures/sanitized/encoded-endpoint.json': '{"endpoint":"https:\\u002f\\u002fbuilder.company.internal","email":"person\\u0040company.internal"}',
    'fixtures/sanitized/host.json': '{"host":"10.0.0.1"}',
    'fixtures/sanitized/identity.json': JSON.stringify({
      persona: 'Alice Chen',
      projectId: 'project-123',
      email: 'person@company.internal',
      endpoint: 'https://builder.company.internal/catalog',
    }),
    'fixtures/sanitized/runtime.json': JSON.stringify({
      projectId: 'project-123456',
      userId: 'user-98765',
    }),
    'fixtures/sanitized/columns.csv': 'name,status\nfixture,ok\n',
    'fixtures/sanitized/notes.md': '# fixture\n',
    'fixtures/sanitized/config.yaml': 'project: fixture-project\n',
    'fixtures/sanitized/invalid.json': '{"project":',
  });
  const result = scanRepository({ root });

  assert.deepEqual(rulesFor(result, 'fixtures/sanitized/safe.json'), []);
  assertFinding(result, 'fixtures/sanitized/credentials.json', 'sanitized-credential-value', 'index');
  assertFinding(result, 'fixtures/sanitized/escaped.json', 'sanitized-credential-value', 'index');
  assertFinding(result, 'fixtures/sanitized/nested.json', 'sanitized-credential-value', 'index');
  assertFinding(result, 'fixtures/sanitized/nested.json', 'sanitized-identity-value', 'index');
  assertFinding(result, 'fixtures/sanitized/nested.json', 'sanitized-non-example-url', 'index');
  assertFinding(result, 'fixtures/sanitized/spaced-fields.json', 'sanitized-credential-value', 'index');
  assertFinding(result, 'fixtures/sanitized/spaced-fields.json', 'sanitized-identity-value', 'index');
  assertFinding(result, 'fixtures/sanitized/deceptive.json', 'sanitized-credential-value', 'index');
  assertFinding(result, 'fixtures/sanitized/deceptive.json', 'sanitized-identity-value', 'index');
  assertFinding(result, 'fixtures/sanitized/duplicate.json', 'sanitized-identity-value', 'index');
  assertFinding(result, 'fixtures/sanitized/duplicate.json', 'sanitized-non-example-url', 'index');
  assertFinding(result, 'fixtures/sanitized/encoded-endpoint.json', 'sanitized-non-example-url', 'index');
  assertFinding(result, 'fixtures/sanitized/encoded-endpoint.json', 'sanitized-personal-email', 'index');
  assertFinding(result, 'fixtures/sanitized/host.json', 'sanitized-non-example-url', 'index');
  assertFinding(result, 'fixtures/sanitized/identity.json', 'sanitized-identity-value', 'index');
  assertFinding(result, 'fixtures/sanitized/identity.json', 'sanitized-personal-email', 'index');
  assertFinding(result, 'fixtures/sanitized/identity.json', 'sanitized-non-example-url', 'index');
  assertFinding(result, 'fixtures/sanitized/runtime.json', 'sanitized-identity-value', 'index');
  assertFinding(result, 'fixtures/sanitized/columns.csv', 'sanitized-fixture-type');
  assertFinding(result, 'fixtures/sanitized/columns.csv', 'tracked-sheet-artifact');
  assertFinding(result, 'fixtures/sanitized/notes.md', 'sanitized-fixture-type');
  assertFinding(result, 'fixtures/sanitized/config.yaml', 'sanitized-fixture-type');
  assertFinding(result, 'fixtures/sanitized/invalid.json', 'sanitized-structure-invalid', 'index');
});

test('credential scan allows source references and explicit test sentinels but rejects literal secrets', (t) => {
  const heygenKey = ['HEYGEN', 'API', 'KEY'].join('_');
  const minimaxKey = ['MINIMAX', 'API', 'KEY'].join('_');
  const minimaxGroup = ['MINIMAX', 'GROUP', 'ID'].join('_');
  const openaiToken = ['OPENAI', 'ACCESS', 'TOKEN'].join('_');
  const providerSecrets = ['provider', 'Secrets'].join('');
  const unsafeFixtureValue = ['live', 'secret', 'value'].join('-');
  const camelCredentialField = ['api', 'Key'].join('');
  const deceptiveFixtureValue = ['test', 'live', 'actual', 'provider', 'secret'].join('-');
  const npmConfigField = ['_auth', 'Token'].join('');
  const root = makeRepository(t, {
    'src/provider.js': [
      `let ${heygenKey};`,
      `${heygenKey} = ${providerSecrets}.${heygenKey};`,
      `${minimaxGroup} = ${providerSecrets}.${minimaxGroup};`,
      `const ${openaiToken} = process.env.${openaiToken};`,
      `if (${heygenKey} === ${providerSecrets}.${heygenKey}) module.exports = true;`,
      '',
    ].join('\n'),
    'src/provider.test.js': [
      `const fixture = { ${heygenKey}: 'test-shell-heygen-key' };`,
      `const fromFile = { ${minimaxKey}: 'test-file-minimax-key' };`,
      `const blocked = { ${openaiToken}: 'test-must-not-be-read' };`,
      '',
    ].join('\n'),
    'src/leaked.js': `const ${heygenKey} = '${unsafeFixtureValue}';\n`,
    'src/leaked.test.js': `const ${minimaxKey} = '${unsafeFixtureValue}';\n`,
    'src/mismatched.js': `${heygenKey} = ${providerSecrets}.${minimaxKey};\n`,
    'src/group.js': `${minimaxGroup} = '${unsafeFixtureValue}';\n`,
    'src/provider-fallback.js': `${heygenKey} = ${providerSecrets}.${heygenKey} || '${unsafeFixtureValue}';\n`,
    'src/environment-fallback.js': `${openaiToken} = process.env.${openaiToken} || '${unsafeFixtureValue}';\n`,
    'src/multiline-fallback.js': [
      `${heygenKey} = ${providerSecrets}.${heygenKey}`,
      `  || '${unsafeFixtureValue}';`,
      '',
    ].join('\n'),
    'src/multiline-literal.js': [
      `const ${heygenKey} =`,
      `  '${unsafeFixtureValue}';`,
      '',
    ].join('\n'),
    'src/multiline-gap.js': [
      `const ${heygenKey} =`,
      '',
      `  '${unsafeFixtureValue}';`,
      '',
    ].join('\n'),
    'src/multiline-operator.js': [
      `const ${heygenKey}`,
      `  = '${unsafeFixtureValue}';`,
      '',
    ].join('\n'),
    'src/parenthesized-literal.js': [
      `const ${heygenKey} = (`,
      `  '${unsafeFixtureValue}'`,
      ');',
      '',
    ].join('\n'),
    'src/camel-literal.js': `const config = { ${camelCredentialField}: '${unsafeFixtureValue}' };\n`,
    'src/camel-deceptive.js': `const config = { ${camelCredentialField}: '${deceptiveFixtureValue}' };\n`,
    'src/camel-reference.js': `const config = { ${camelCredentialField}: ${providerSecrets}.${heygenKey} };\n`,
    'src/logical-assignments.js': [
      `config.${camelCredentialField} ||= '${unsafeFixtureValue}';`,
      `config.${camelCredentialField} ??= '${unsafeFixtureValue}';`,
      `config.${camelCredentialField} &&= '${unsafeFixtureValue}';`,
      '',
    ].join('\n'),
    'src/destructuring-default.js': `const { ${camelCredentialField}: key = '${unsafeFixtureValue}' } = config;\n`,
    'config/leaked.json': `{"${camelCredentialField}":\n  "${unsafeFixtureValue}"}\n`,
    'config/invalid.json': `{"${camelCredentialField}":\n  "${unsafeFixtureValue}",\n}\n`,
    'config/leaked.yaml': `${camelCredentialField}:\n  ${unsafeFixtureValue}\n`,
    'server/public/leaked.html': `<script>\nconst ${camelCredentialField} =\n  '${unsafeFixtureValue}';\n</script>\n`,
    '.env.example': `${heygenKey}=\n`,
    '.npmrc': `${npmConfigField}=${deceptiveFixtureValue}\n`,
  });
  const result = scanRepository({ root });
  const unsafeEnvironmentRoot = makeRepository(t, {
    '.env.example': `${heygenKey}=${unsafeFixtureValue}\n`,
  });
  const unsafeEnvironmentResult = scanRepository({ root: unsafeEnvironmentRoot });

  assert.deepEqual(rulesFor(result, 'src/provider.js'), []);
  assert.deepEqual(rulesFor(result, 'src/provider.test.js'), []);
  assert.deepEqual(rulesFor(result, 'src/camel-reference.js'), []);
  assert.deepEqual(rulesFor(result, '.env.example'), []);
  assertFinding(result, 'src/leaked.js', 'credential-assignment', 'index');
  assertFinding(result, 'src/leaked.js', 'credential-assignment', 'worktree');
  assertFinding(result, 'src/leaked.test.js', 'credential-assignment', 'index');
  assertFinding(result, 'src/leaked.test.js', 'credential-assignment', 'worktree');
  assertFinding(result, 'src/mismatched.js', 'credential-assignment', 'index');
  assertFinding(result, 'src/mismatched.js', 'credential-assignment', 'worktree');
  assertFinding(result, 'src/group.js', 'credential-assignment', 'index');
  assertFinding(result, 'src/group.js', 'credential-assignment', 'worktree');
  assertFinding(result, 'src/provider-fallback.js', 'credential-assignment', 'index');
  assertFinding(result, 'src/provider-fallback.js', 'credential-assignment', 'worktree');
  assertFinding(result, 'src/environment-fallback.js', 'credential-assignment', 'index');
  assertFinding(result, 'src/environment-fallback.js', 'credential-assignment', 'worktree');
  assertFinding(result, 'src/multiline-fallback.js', 'credential-assignment', 'index');
  assertFinding(result, 'src/multiline-fallback.js', 'credential-assignment', 'worktree');
  assertFinding(result, 'src/multiline-literal.js', 'credential-assignment', 'index');
  assertFinding(result, 'src/multiline-literal.js', 'credential-assignment', 'worktree');
  assertFinding(result, 'src/multiline-gap.js', 'credential-assignment', 'index');
  assertFinding(result, 'src/multiline-gap.js', 'credential-assignment', 'worktree');
  assertFinding(result, 'src/multiline-operator.js', 'credential-assignment', 'index');
  assertFinding(result, 'src/multiline-operator.js', 'credential-assignment', 'worktree');
  assertFinding(result, 'src/parenthesized-literal.js', 'credential-assignment', 'index');
  assertFinding(result, 'src/parenthesized-literal.js', 'credential-assignment', 'worktree');
  assertFinding(result, 'src/camel-literal.js', 'credential-assignment', 'index');
  assertFinding(result, 'src/camel-literal.js', 'credential-assignment', 'worktree');
  assertFinding(result, 'src/camel-deceptive.js', 'credential-assignment', 'index');
  assertFinding(result, 'src/camel-deceptive.js', 'credential-assignment', 'worktree');
  assertFinding(result, 'src/logical-assignments.js', 'credential-assignment', 'index');
  assertFinding(result, 'src/logical-assignments.js', 'credential-assignment', 'worktree');
  assertFinding(result, 'src/destructuring-default.js', 'credential-assignment', 'index');
  assertFinding(result, 'src/destructuring-default.js', 'credential-assignment', 'worktree');
  assertFinding(result, 'config/leaked.json', 'credential-assignment', 'index');
  assertFinding(result, 'config/leaked.json', 'credential-assignment', 'worktree');
  assertFinding(result, 'config/invalid.json', 'source-structure-invalid', 'index');
  assertFinding(result, 'config/invalid.json', 'source-structure-invalid', 'worktree');
  assertFinding(result, 'config/leaked.yaml', 'credential-assignment', 'index');
  assertFinding(result, 'config/leaked.yaml', 'credential-assignment', 'worktree');
  assertFinding(result, 'server/public/leaked.html', 'credential-assignment', 'index');
  assertFinding(result, 'server/public/leaked.html', 'credential-assignment', 'worktree');
  assertFinding(result, '.npmrc', 'credential-assignment', 'index');
  assertFinding(result, '.npmrc', 'credential-assignment', 'worktree');
  assertFinding(unsafeEnvironmentResult, '.env.example', 'credential-assignment', 'index');
  assertFinding(unsafeEnvironmentResult, '.env.example', 'credential-assignment', 'worktree');
});

test('ambient Git variables cannot redirect the canonical index or object store', (t) => {
  const machinePath = ['', 'Users', 'alice', 'private-project'].join('/');
  const target = makeRepository(t, {
    'src/index.js': `module.exports = ${JSON.stringify(machinePath)};\n`,
  });
  const decoy = makeRepository(t, {
    'src/index.js': "module.exports = 'safe';\n",
  });
  const environment = {
    ...process.env,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(decoy, '.git', 'objects'),
    GIT_COMMON_DIR: path.join(decoy, '.git'),
    GIT_DIR: path.join(decoy, '.git'),
    GIT_INDEX_FILE: path.join(decoy, '.git', 'index'),
    GIT_OBJECT_DIRECTORY: path.join(decoy, '.git', 'objects'),
    GIT_REPLACE_REF_BASE: 'refs/replace-decoy/',
    GIT_WORK_TREE: decoy,
  };
  const result = scanRepository({ environment, root: target });
  assertFinding(result, 'src/index.js', 'machine-path', 'index');
  assertFinding(result, 'src/index.js', 'machine-path', 'worktree');
});

test('an empty canonical index fails closed', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marketing-video-source-boundary-empty-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  git(root, ['init', '--quiet']);
  git(root, ['read-tree', '--empty']);
  const result = scanRepository({ root });
  assert.equal(result.trackedCount, 0);
  assertFinding(result, '.git', 'git-inventory-unavailable', 'git');
});

test('index and worktree mismatches cannot hide sensitive bytes in either side', async (t) => {
  const machinePath = ['', 'Users', 'alice', 'private-project'].join('/');
  await t.test('sensitive index with safe worktree', (subtest) => {
    const root = makeRepository(subtest, {
      'src/index.js': `module.exports = ${JSON.stringify(machinePath)};\n`,
    });
    writeEntry(root, 'src/index.js', "module.exports = 'safe-worktree';\n");
    const result = scanRepository({ root });
    assertFinding(result, 'src/index.js', 'machine-path', 'index');
    assertFinding(result, 'src/index.js', 'index-worktree-mismatch', 'worktree');
  });

  await t.test('safe index with sensitive worktree', (subtest) => {
    const root = makeRepository(subtest, {
      'src/index.js': "module.exports = 'safe-index';\n",
    });
    writeEntry(root, 'src/index.js', `module.exports = ${JSON.stringify(machinePath)};\n`);
    const result = scanRepository({ root });
    assertFinding(result, 'src/index.js', 'machine-path', 'worktree');
    assertFinding(result, 'src/index.js', 'index-worktree-mismatch', 'worktree');
  });
});

test('replace refs and dishonest blob bytes cannot replace the indexed object', async (t) => {
  const machinePath = ['', 'Users', 'alice', 'private-project'].join('/');
  const root = makeRepository(t, {
    'src/index.js': `module.exports = ${JSON.stringify(machinePath)};\n`,
    'src/safe.js': "module.exports = 'safe';\n",
  });
  const sensitiveOid = String(git(root, ['rev-parse', ':src/index.js'])).trim();
  const safeOid = String(git(root, ['rev-parse', ':src/safe.js'])).trim();
  git(root, ['replace', sensitiveOid, safeOid]);
  const replaceResult = scanRepository({ root });
  assertFinding(replaceResult, 'src/index.js', 'machine-path', 'index');

  const dishonestRunner = (command, args, options) => {
    if (args.includes('cat-file') && args.at(-1) === sensitiveOid) {
      return { status: 0, stdout: Buffer.from("module.exports = 'safe';\n") };
    }
    return spawnSync(command, args, options);
  };
  const oidResult = scanRepository({ gitRunner: dishonestRunner, root });
  assertFinding(oidResult, 'src/index.js', 'index-blob-oid-mismatch', 'index');
});

test('tracked media, delivery documents and spreadsheets fail closed outside explicit boundaries', (t) => {
  const bytes = Buffer.from([0, 1, 2, 3]);
  const root = makeRepository(t, {
    'audio/voice.mp3': bytes,
    'docs/images/screenshot.png': PNG_1X1,
    'image.png': bytes,
    'out/final.mp4': bytes,
    'recordings/take.mov': bytes,
    'report.pdf': bytes,
    'sheet.xlsx': bytes,
    'video.webm': bytes,
  });
  const result = scanRepository({ root });
  assertFinding(result, 'audio/voice.mp3', 'tracked-audio-artifact');
  assertFinding(result, 'docs/images/screenshot.png', 'runtime-named-doc-image');
  assertFinding(result, 'image.png', 'tracked-image-artifact');
  assertFinding(result, 'out/final.mp4', 'tracked-video-artifact');
  assertFinding(result, 'recordings/take.mov', 'tracked-video-artifact');
  assertFinding(result, 'report.pdf', 'tracked-document-artifact');
  assertFinding(result, 'sheet.xlsx', 'tracked-sheet-artifact');
  assertFinding(result, 'video.webm', 'tracked-video-artifact');
});

test('docs images require valid signatures and a small size cap', async (t) => {
  await t.test('invalid image signature', (subtest) => {
    const root = makeRepository(subtest, {
      'docs/images/architecture.png': 'not a png\n',
    });
    const result = scanRepository({ root });
    assertFinding(result, 'docs/images/architecture.png', 'doc-image-signature', 'index');
  });

  await t.test('oversized documentation image', (subtest) => {
    const oversized = Buffer.concat([
      PNG_1X1.subarray(0, 8),
      Buffer.alloc(MAX_DOC_IMAGE_BYTES + 1),
    ]);
    const root = makeRepository(subtest, {
      'docs/images/architecture.png': oversized,
    });
    const result = scanRepository({ root });
    assertFinding(result, 'docs/images/architecture.png', 'doc-image-too-large', 'index');
  });
});

test('sanitized fixtures require the explicit location, text type and size cap', async (t) => {
  await t.test('raw fixture location', (subtest) => {
    const root = makeRepository(subtest, {
      'fixtures/raw/project.json': '{"project":"internal"}\n',
    });
    const result = scanRepository({ root });
    assertFinding(result, 'fixtures/raw/project.json', 'unsanitized-fixture-location');
  });

  await t.test('binary fixture type', (subtest) => {
    const root = makeRepository(subtest, {
      'fixtures/sanitized/frame.png': PNG_1X1,
    });
    const result = scanRepository({ root });
    assertFinding(result, 'fixtures/sanitized/frame.png', 'sanitized-fixture-type');
    assertFinding(result, 'fixtures/sanitized/frame.png', 'tracked-image-artifact');
  });

  await t.test('oversized fixture', (subtest) => {
    const root = makeRepository(subtest, {
      'fixtures/sanitized/project.json': Buffer.alloc(MAX_SANITIZED_FIXTURE_BYTES + 1, 0x20),
    });
    const result = scanRepository({ root });
    assertFinding(result, 'fixtures/sanitized/project.json', 'sanitized-fixture-too-large', 'index');
  });
});

test('tracked symlinks and hidden index entries fail closed', async (t) => {
  await t.test('tracked symlink', (subtest) => {
    const root = makeRepository(subtest);
    fs.symlinkSync('src/index.js', path.join(root, 'linked.js'));
    git(root, ['add', '--force', '--', 'linked.js']);
    const result = scanRepository({ root });
    assertFinding(result, 'linked.js', 'unsupported-index-mode', 'index');
  });

  await t.test('assume-unchanged index flag', (subtest) => {
    const root = makeRepository(subtest);
    git(root, ['update-index', '--assume-unchanged', '--', 'src/index.js']);
    const result = scanRepository({ root });
    assertFinding(result, 'src/index.js', 'hidden-or-sparse-index-entry', 'index');
  });

  await t.test('tracked file below a replaced symlink directory', (subtest) => {
    const root = makeRepository(subtest, {
      'nested/source.js': "module.exports = 'indexed';\n",
    });
    const original = path.join(root, 'nested-original');
    fs.renameSync(path.join(root, 'nested'), original);
    fs.symlinkSync(original, path.join(root, 'nested'), 'dir');
    const result = scanRepository({ root });
    assertFinding(result, 'nested/source.js', 'worktree-entry-unavailable', 'worktree');
  });
});
