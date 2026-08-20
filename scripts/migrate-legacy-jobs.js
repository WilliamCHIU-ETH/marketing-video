#!/usr/bin/env node

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { inspectMediaFile } = require('../server/project-store');

const ROOT = path.resolve(__dirname, '..');
const TOOL_VERSION = 1;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArgs(argv) {
  const options = { apply: false, verify: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--verify') options.verify = true;
    else if (arg === '--source') options.source = argv[++index];
    else if (arg === '--data-dir') options.dataDir = argv[++index];
    else throw new Error(`不支援的參數：${arg}`);
  }
  invariant(!(options.apply && options.verify), '--apply 與 --verify 不能同時使用');
  invariant(options.source, '必須提供 --source /path/to/legacy-runtime-data');
  return {
    ...options,
    source: path.resolve(options.source),
    dataDir: path.resolve(options.dataDir || path.join(ROOT, 'runtime-data')),
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

function hashFile(file) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let count;
    while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, count));
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function shortHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function normalizedTitle(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function safeId(value, label) {
  const id = String(value || '');
  invariant(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id), `${label} 不合法：${id || '(空白)'}`);
  return id;
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function regularOwnedFile(root, file) {
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  const realRoot = fs.realpathSync(root);
  const realFile = fs.realpathSync(file);
  return isWithin(realRoot, realFile) ? realFile : null;
}

function ownedDirectory(root, directory) {
  if (!fs.existsSync(directory)) return null;
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
  const realRoot = fs.realpathSync(root);
  const realDirectory = fs.realpathSync(directory);
  return isWithin(realRoot, realDirectory) ? realDirectory : null;
}

function canonicalFuturePath(target) {
  const suffix = [];
  let cursor = path.resolve(target);
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    invariant(parent !== cursor, `找不到 target 的既有 parent：${target}`);
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  return path.join(fs.realpathSync(cursor), ...suffix);
}

function parseLegacyScript(file, fallbackTitle) {
  if (!file) return { title: fallbackTitle || '', body: '', voice: '' };
  const raw = fs.readFileSync(file, 'utf8');
  const sections = raw.split(/^===\s*$/m);
  if (sections.length >= 4) {
    return {
      voice: sections[1].trim(),
      title: sections[2].trim() || fallbackTitle || '',
      body: sections.slice(3).join('\n===\n').trim(),
    };
  }
  return { title: fallbackTitle || '', body: raw.trim(), voice: '' };
}

function timestamp(job) {
  return job.finishedAt || job.preparedAt || job.startedAt || job.createdAt;
}

function classifyAsset(name) {
  if (/^heygen\.mp4$/i.test(name)) return 'speaker-video';
  if (/\.(png|jpe?g)$/i.test(name)) return 'image';
  if (/\.(mp4|mov|m4v|webm)$/i.test(name)) return 'video';
  return null;
}

function collectAssetSources(sourceRoot, jobDir) {
  const assets = [];
  const inputDir = path.join(jobDir, 'input');
  if (fs.existsSync(inputDir) && fs.lstatSync(inputDir).isDirectory() && !fs.lstatSync(inputDir).isSymbolicLink()) {
    for (const entry of fs.readdirSync(inputDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      const kind = classifyAsset(entry.name);
      const file = regularOwnedFile(sourceRoot, path.join(inputDir, entry.name));
      if (kind && file) assets.push({ name: entry.name, kind, file });
    }
  }
  const paidMaster = regularOwnedFile(sourceRoot, path.join(jobDir, 'state', 'public', 'heygen.mp4'));
  if (paidMaster && !assets.some((asset) => asset.kind === 'speaker-video' && hashFile(asset.file) === hashFile(paidMaster)))
    assets.push({ name: 'heygen.mp4', kind: 'speaker-video', file: paidMaster });
  return assets;
}

function scan(options) {
  invariant(fs.existsSync(options.source), `找不到 legacy runtime：${options.source}`);
  const sourceRoot = fs.realpathSync(options.source);
  const jobsDir = path.join(sourceRoot, 'jobs');
  invariant(fs.existsSync(jobsDir) && fs.lstatSync(jobsDir).isDirectory()
    && !fs.lstatSync(jobsDir).isSymbolicLink(), `找不到安全的 legacy jobs 目錄：${jobsDir}`);
  const records = [];
  for (const entry of fs.readdirSync(jobsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const id = safeId(entry.name, 'Legacy Job ID');
    const sourceDir = path.join(jobsDir, id);
    const jobFile = regularOwnedFile(sourceRoot, path.join(sourceDir, 'job.json'));
    if (!jobFile) continue;
    const job = readJson(jobFile);
    invariant(job && job.id === id, `job ID 與資料夾不一致：${jobFile}`);
    invariant(job.createdAt && job.template, `job 缺少 createdAt/template：${id}`);
    const assets = collectAssetSources(sourceRoot, sourceDir);
    const speaker = assets.find((asset) => asset.kind === 'speaker-video');
    records.push({
      job,
      sourceDir,
      assets,
      normalizedTitle: normalizedTitle(job.title),
      speakerHash: speaker ? hashFile(speaker.file) : null,
    });
  }
  records.sort((left, right) => String(left.job.createdAt).localeCompare(String(right.job.createdAt))
    || left.job.id.localeCompare(right.job.id));
  invariant(records.length, `沒有找到 legacy job.json：${jobsDir}`);
  return records;
}

// 只有非空 title 或相同 paid speaker master 才是合併證據。空 title 絕不互相合併。
function groupRecords(records) {
  const parent = records.map((_, index) => index);
  const find = (index) => (parent[index] === index ? index : (parent[index] = find(parent[index])));
  const join = (leftIndex, rightIndex) => {
    const left = find(leftIndex);
    const right = find(rightIndex);
    if (left !== right) parent[right] = left;
  };
  for (let left = 0; left < records.length; left += 1) {
    for (let right = left + 1; right < records.length; right += 1) {
      if (records[left].job.template !== records[right].job.template) continue;
      const sameTitle = records[left].normalizedTitle
        && records[left].normalizedTitle === records[right].normalizedTitle;
      const sameSpeaker = records[left].speakerHash
        && records[left].speakerHash === records[right].speakerHash;
      if (sameTitle || sameSpeaker) join(left, right);
    }
  }
  const groups = new Map();
  records.forEach((record, index) => {
    const key = find(index);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  });
  return [...groups.values()].map((items) => items.sort((left, right) =>
    String(left.job.createdAt).localeCompare(String(right.job.createdAt))
      || left.job.id.localeCompare(right.job.id)));
}

function buildPlan(groups) {
  return groups.map((records) => {
    const latest = records[records.length - 1].job;
    const identity = records.map((record) => record.job.id).sort().join('|');
    return {
      id: `project-legacy-${shortHash(identity)}`,
      name: normalizedTitle(latest.title) || `未命名影片 ${latest.id}`,
      template: latest.template,
      brand: latest.brand || null,
      owner: latest.owner || '未署名',
      records,
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
}

function locateOutput(sourceRoot, record, output) {
  const name = path.basename(String(output && output.name || ''));
  invariant(name, `job ${record.job.id} 的 output 缺少 name`);
  const candidates = [];
  if (output.archive && typeof output.archive === 'string')
    candidates.push(path.isAbsolute(output.archive) ? output.archive : path.resolve(sourceRoot, output.archive));
  candidates.push(path.join(record.sourceDir, 'out', name));
  for (const candidate of candidates) {
    const file = regularOwnedFile(sourceRoot, candidate);
    if (file) return file;
  }
  return null;
}

function outputRecords(sourceRoot, record) {
  return (record.job.outputs || []).map((output) => {
    invariant(output && typeof output === 'object', `job ${record.job.id} 的 output 格式錯誤`);
    const file = locateOutput(sourceRoot, record, output);
    invariant(file, `找不到 job ${record.job.id} 的成品 ${output.name || '(未命名)'}`);
    const size = fs.statSync(file).size;
    if (output.size !== undefined)
      invariant(Number.isFinite(output.size) && output.size === size, `job ${record.job.id} 的成品 size 不一致`);
    return { source: file, name: path.basename(output.name), size, sha256: hashFile(file) };
  });
}

function validateSource(options, plans) {
  const sourceRoot = fs.realpathSync(options.source);
  for (const plan of plans) {
    for (const record of plan.records) {
      record.outputs = outputRecords(sourceRoot, record);
      if (record.job.status === 'done')
        invariant(record.outputs.length > 0, `done job ${record.job.id} 沒有可驗證成品`);
      for (const asset of record.assets) {
        const media = inspectMediaFile(asset.file);
        const expectedKind = asset.kind === 'speaker-video' ? 'video' : asset.kind;
        invariant(media && media.kind === expectedKind, `素材無法辨識或角色不符：${asset.file}`);
        asset.media = media;
        asset.size = fs.statSync(asset.file).size;
        asset.sha256 = hashFile(asset.file);
      }
    }
  }
}

function preview(options, plans) {
  return {
    mode: options.apply ? 'apply' : (options.verify ? 'verify' : 'preview'),
    source: options.source,
    dataDir: options.dataDir,
    projects: plans.length,
    revisions: plans.reduce((sum, plan) => sum + plan.records.length, 0),
    done: plans.flatMap((plan) => plan.records).filter((record) => record.job.status === 'done').length,
    groups: plans.map((plan) => ({
      id: plan.id,
      name: plan.name,
      template: plan.template,
      runs: plan.records.map((record) => ({ id: record.job.id, legacyStatus: record.job.status })),
    })),
  };
}

function migratedStatus(job) {
  if (['done', 'failed', 'cancelled'].includes(job.status)) return job.status;
  return 'failed';
}

function archiveReference(file) {
  const relative = path.relative(ROOT, file);
  return isWithin(ROOT, file) ? relative : file;
}

function buildStaging(options, plans, stagingRoot, migratedAt) {
  const stagingProjects = path.join(stagingRoot, 'projects');
  const stagingJobs = path.join(stagingRoot, 'jobs');
  fs.mkdirSync(stagingProjects, { recursive: true });
  fs.mkdirSync(stagingJobs, { recursive: true });

  for (const plan of plans) {
    const projectDir = path.join(stagingProjects, plan.id);
    const assetsDir = path.join(projectDir, 'assets');
    const revisionsDir = path.join(projectDir, 'revisions');
    const outputsDir = path.join(projectDir, 'outputs');
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.mkdirSync(revisionsDir, { recursive: true });
    fs.mkdirSync(outputsDir, { recursive: true });
    const project = {
      schemaVersion: 1,
      id: plan.id,
      name: plan.name,
      template: plan.template,
      brand: plan.brand,
      owner: plan.owner,
      createdAt: plan.records[0].job.createdAt,
      updatedAt: timestamp(plan.records[plan.records.length - 1].job),
      latestRevision: plan.records.length,
      assets: [],
      revisions: [],
      migration: { tool: 'migrate-legacy-jobs', version: TOOL_VERSION, migratedAt },
    };
    const assetByKey = new Map();

    plan.records.forEach((record, index) => {
      const revisionNumber = index + 1;
      const revisionId = `v${String(revisionNumber).padStart(3, '0')}`;
      const assetRefs = [];
      for (const sourceAsset of record.assets) {
        const key = `${sourceAsset.kind}:${sourceAsset.sha256}`;
        let asset = assetByKey.get(key);
        if (!asset) {
          const relativePath = path.join('assets', `${sourceAsset.sha256}${sourceAsset.media.extension}`);
          const target = path.join(projectDir, relativePath);
          if (!fs.existsSync(target))
            fs.copyFileSync(sourceAsset.file, target, fs.constants.COPYFILE_EXCL);
          invariant(fs.statSync(target).size === sourceAsset.size && hashFile(target) === sourceAsset.sha256,
            `素材複製驗證失敗：${record.job.id}/${sourceAsset.name}`);
          asset = {
            id: `asset-${sourceAsset.kind.replace(/[^a-z0-9]+/g, '-')}-${sourceAsset.sha256.slice(0, 16)}`,
            kind: sourceAsset.kind,
            mediaType: sourceAsset.media.mediaType,
            originalName: sourceAsset.name,
            sha256: sourceAsset.sha256,
            size: sourceAsset.size,
            path: relativePath,
            createdAt: record.job.createdAt,
          };
          assetByKey.set(key, asset);
          project.assets.push(asset);
        }
        assetRefs.push(asset.id);
      }

      const outputs = record.outputs.map((output) => {
        const target = path.join(outputsDir, `${revisionId}-${output.name}`);
        const durableTarget = path.join(options.dataDir, 'projects', plan.id, 'outputs', `${revisionId}-${output.name}`);
        fs.copyFileSync(output.source, target, fs.constants.COPYFILE_EXCL);
        invariant(fs.statSync(target).size === output.size && hashFile(target) === output.sha256,
          `成品複製驗證失敗：${record.job.id}/${output.name}`);
        return {
          name: output.name,
          size: output.size,
          sha256: output.sha256,
          archive: archiveReference(durableTarget),
        };
      });
      const scriptFile = regularOwnedFile(options.source, path.join(record.sourceDir, 'input', 'script.txt'));
      const status = migratedStatus(record.job);
      const interrupted = status === 'failed' && !['failed', 'cancelled'].includes(record.job.status);
      const revision = {
        schemaVersion: 1,
        id: revisionId,
        number: revisionNumber,
        projectId: plan.id,
        jobId: record.job.id,
        runId: record.job.id,
        createdAt: record.job.createdAt,
        updatedAt: timestamp(record.job),
        status,
        owner: record.job.owner || '未署名',
        title: record.job.title || '',
        script: parseLegacyScript(scriptFile, record.job.title),
        options: {
          skipGenerate: !!record.job.skipGenerate,
          noSpeed: !!record.job.noSpeed,
          withAd: !!record.job.withAd,
          autoApprove: !!record.job.autoApprove,
        },
        assetRefs: [...new Set(assetRefs)],
        files: record.assets.map((asset) => asset.name),
        outputs,
        archived: outputs.map((output) => output.archive),
        finishedAt: record.job.finishedAt || null,
        error: interrupted
          ? `Legacy migration：原狀態 ${record.job.status} 無法跨版本安全續跑；素材與紀錄已保存。`
          : record.job.error,
        migration: { legacyJobId: record.job.id, legacyStatus: record.job.status },
      };
      writeJson(path.join(revisionsDir, `${revisionId}.json`), revision);
      project.revisions.push({
        id: revisionId,
        number: revisionNumber,
        jobId: record.job.id,
        status,
        createdAt: revision.createdAt,
        updatedAt: revision.updatedAt,
        outputs,
      });

      const targetJobDir = path.join(stagingJobs, record.job.id);
      fs.mkdirSync(targetJobDir, { recursive: false });
      const migratedJob = {
        ...record.job,
        pid: null,
        projectId: plan.id,
        projectName: plan.name,
        revisionId,
        revisionNumber,
        status,
        error: revision.error,
        files: revision.files,
        assetRefs: revision.assetRefs,
        createdAssetRefs: [],
        outputs,
        archived: revision.archived,
        migration: { tool: 'migrate-legacy-jobs', version: TOOL_VERSION, legacyStatus: record.job.status, migratedAt },
      };
      delete migratedJob.pidArgs;
      writeJson(path.join(targetJobDir, 'job.json'), migratedJob);
      const sourceLog = regularOwnedFile(options.source, path.join(record.sourceDir, 'log.txt'));
      if (sourceLog) fs.copyFileSync(sourceLog, path.join(targetJobDir, 'log.txt'), fs.constants.COPYFILE_EXCL);
    });
    writeJson(path.join(projectDir, 'project.json'), project);
  }
}

function expectedTargets(options, plans) {
  const targets = [];
  for (const plan of plans) {
    targets.push(path.join(options.dataDir, 'projects', plan.id));
    for (const record of plan.records) targets.push(path.join(options.dataDir, 'jobs', record.job.id));
  }
  return targets;
}

function targetMode(options, plans) {
  const states = expectedTargets(options, plans).map((target) => fs.existsSync(target));
  if (states.every(Boolean)) return 'complete';
  if (states.some(Boolean)) return 'partial';
  return 'empty';
}

function applyMigration(options, plans, hooks = {}) {
  const sourceRoot = fs.realpathSync(options.source);
  const targetRoot = canonicalFuturePath(options.dataDir);
  if (fs.existsSync(options.dataDir)) {
    invariant(!fs.lstatSync(options.dataDir).isSymbolicLink(), `target data-dir 不得是 symlink：${options.dataDir}`);
    invariant(!isWithin(sourceRoot, targetRoot) && !isWithin(targetRoot, sourceRoot),
      'source 與 target data-dir 必須彼此分離');
  } else {
    invariant(!isWithin(sourceRoot, targetRoot) && !isWithin(targetRoot, sourceRoot),
      'source 與 target data-dir 必須彼此分離');
  }
  validateSource(options, plans);
  const existing = targetMode(options, plans);
  invariant(existing !== 'partial', '目標含部分 migration 結果；請先人工確認，不會覆寫或補寫');
  if (existing === 'complete') return { reused: true, ...verifyMigration(options, plans) };

  fs.mkdirSync(options.dataDir, { recursive: true });
  const stagingRoot = path.join(options.dataDir, `.legacy-migration-${process.pid}-${crypto.randomUUID()}`);
  invariant(!fs.existsSync(stagingRoot), `staging 已存在：${stagingRoot}`);
  const promoted = [];
  try {
    buildStaging(options, plans, stagingRoot, new Date().toISOString());
    fs.mkdirSync(path.join(options.dataDir, 'projects'), { recursive: true });
    fs.mkdirSync(path.join(options.dataDir, 'jobs'), { recursive: true });
    for (const plan of plans) {
      const source = path.join(stagingRoot, 'projects', plan.id);
      const target = path.join(options.dataDir, 'projects', plan.id);
      invariant(!fs.existsSync(target), `目標已存在：${target}`);
      fs.renameSync(source, target);
      promoted.push(target);
      if (hooks.afterPromote) hooks.afterPromote({ type: 'project', id: plan.id, target });
    }
    for (const plan of plans) {
      for (const record of plan.records) {
        const source = path.join(stagingRoot, 'jobs', record.job.id);
        const target = path.join(options.dataDir, 'jobs', record.job.id);
        invariant(!fs.existsSync(target), `目標已存在：${target}`);
        fs.renameSync(source, target);
        promoted.push(target);
        if (hooks.afterPromote) hooks.afterPromote({ type: 'job', id: record.job.id, target });
      }
    }
    const result = verifyMigration(options, plans);
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    return { reused: false, ...result };
  } catch (error) {
    for (const target of promoted.reverse()) fs.rmSync(target, { recursive: true, force: true });
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

function resolveArchive(output) {
  invariant(output && typeof output.archive === 'string' && output.archive, '成品缺少 archive');
  return path.isAbsolute(output.archive) ? output.archive : path.resolve(ROOT, output.archive);
}

function verifyFile(root, file, expectedSize, expectedHash, label) {
  const owned = regularOwnedFile(root, file);
  invariant(owned, `${label} 路徑不存在或不安全：${file}`);
  invariant(Number.isFinite(expectedSize) && fs.statSync(owned).size === expectedSize, `${label} size 不一致：${file}`);
  invariant(/^[a-f0-9]{64}$/.test(expectedHash) && hashFile(owned) === expectedHash, `${label} SHA-256 不一致：${file}`);
  return owned;
}

function verifyMigration(options, plans) {
  const projectsRoot = path.join(options.dataDir, 'projects');
  const jobsRoot = path.join(options.dataDir, 'jobs');
  invariant(fs.existsSync(options.dataDir) && fs.lstatSync(options.dataDir).isDirectory()
    && !fs.lstatSync(options.dataDir).isSymbolicLink(), `target data-dir 不存在或不安全：${options.dataDir}`);
  invariant(ownedDirectory(options.dataDir, projectsRoot), `projects 目錄不存在或不安全：${projectsRoot}`);
  invariant(ownedDirectory(options.dataDir, jobsRoot), `jobs 目錄不存在或不安全：${jobsRoot}`);
  let revisions = 0;
  let jobs = 0;
  let assets = 0;
  let outputs = 0;
  for (const plan of plans) {
    const projectDir = ownedDirectory(projectsRoot, path.join(projectsRoot, plan.id));
    invariant(projectDir, `Project 目錄不存在或不安全：${plan.id}`);
    const projectFile = regularOwnedFile(projectDir, path.join(projectDir, 'project.json'));
    invariant(projectFile, `Project manifest 不存在或不安全：${plan.id}`);
    const project = readJson(projectFile);
    invariant(project.schemaVersion === 1 && project.id === plan.id, `Project schema 驗證失敗：${plan.id}`);
    invariant(project.revisions.length === plan.records.length
      && project.latestRevision === plan.records.length, `Project revision 數量錯誤：${plan.id}`);
    const assetIds = new Set();
    const assetKeys = new Set();
    for (const asset of project.assets) {
      invariant(!assetIds.has(asset.id), `重複 asset id：${asset.id}`);
      const key = `${asset.kind}:${asset.sha256}`;
      invariant(!assetKeys.has(key), `Project 素材未去重：${key}`);
      assetIds.add(asset.id);
      assetKeys.add(key);
      const file = path.resolve(projectDir, asset.path);
      verifyFile(projectDir, file, asset.size, asset.sha256, '素材');
      assets += 1;
    }
    const revisionIds = new Set();
    const jobIds = new Set();
    for (let index = 0; index < plan.records.length; index += 1) {
      const expectedRecord = plan.records[index];
      const expectedRevisionId = `v${String(index + 1).padStart(3, '0')}`;
      const summary = project.revisions[index];
      invariant(summary && summary.id === expectedRevisionId && summary.number === index + 1
        && summary.jobId === expectedRecord.job.id, `Revision 順序或 identity 不一致：${plan.id}/${expectedRevisionId}`);
      invariant(!revisionIds.has(summary.id) && !jobIds.has(summary.jobId),
        `重複 Revision/Run identity：${plan.id}/${summary.id}`);
      revisionIds.add(summary.id);
      jobIds.add(summary.jobId);
      const revisionsDir = ownedDirectory(projectDir, path.join(projectDir, 'revisions'));
      invariant(revisionsDir, `Revision 目錄不存在或不安全：${plan.id}`);
      const revisionFile = regularOwnedFile(revisionsDir,
        path.join(revisionsDir, `${safeId(summary.id, 'Revision ID')}.json`));
      invariant(revisionFile, `Revision manifest 不存在或不安全：${summary.id}`);
      const revision = readJson(revisionFile);
      const jobDir = ownedDirectory(jobsRoot, path.join(jobsRoot, safeId(summary.jobId, 'Job ID')));
      invariant(jobDir, `Run 目錄不存在或不安全：${summary.jobId}`);
      const jobFile = regularOwnedFile(jobDir, path.join(jobDir, 'job.json'));
      invariant(jobFile, `Run manifest 不存在或不安全：${summary.jobId}`);
      const job = readJson(jobFile);
      invariant(revision.projectId === project.id && job.projectId === project.id
        && job.id === summary.jobId && job.revisionId === revision.id
        && job.revisionNumber === index + 1 && revision.id === expectedRevisionId
        && revision.number === index + 1 && revision.jobId === job.id && revision.runId === job.id,
      `Project/Revision/Run 關聯不一致：${summary.jobId}`);
      for (const ref of revision.assetRefs) invariant(assetIds.has(ref), `素材引用失效：${ref}`);
      invariant(JSON.stringify(summary.outputs || []) === JSON.stringify(revision.outputs || [])
        && JSON.stringify(job.outputs || []) === JSON.stringify(revision.outputs || []),
      `成品 manifest 不一致：${summary.jobId}`);
      for (const output of revision.outputs || []) {
        invariant(typeof output.name === 'string' && output.name
          && path.basename(output.name) === output.name, `成品 name 不安全：${summary.jobId}`);
        const file = resolveArchive(output);
        const outputsDir = ownedDirectory(projectDir, path.join(projectDir, 'outputs'));
        invariant(outputsDir, `Project output 目錄不存在或不安全：${plan.id}`);
        verifyFile(outputsDir, file, output.size, output.sha256, '成品');
        outputs += 1;
      }
      revisions += 1;
      jobs += 1;
    }
  }
  return { ok: true, projects: plans.length, revisions, jobs, assets, outputs };
}

function loadPlan(options) {
  return buildPlan(groupRecords(scan(options)));
}

function run(options, hooks) {
  const plans = loadPlan(options);
  if (options.apply) return applyMigration(options, plans, hooks);
  if (options.verify) return verifyMigration(options, plans);
  validateSource(options, plans);
  return preview(options, plans);
}

function main() {
  try {
    console.log(JSON.stringify(run(parseArgs(process.argv.slice(2))), null, 2));
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  applyMigration,
  buildPlan,
  groupRecords,
  loadPlan,
  parseArgs,
  preview,
  run,
  scan,
  verifyMigration,
};
