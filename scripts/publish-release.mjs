#!/usr/bin/env node

/**
 * 汇总本次构建产物，创建/更新 GitHub Release，并把下载链接回写到 summary。
 * Android / iOS 共用；UPLOAD_RELEASE=false 时只输出 tag，不创建 release。
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildReleaseTag } from './lib/release.mjs';

const PLATFORM_LABEL = { android: 'Android', ios: 'iOS' };

function fail(message) {
  console.error(`[release] ${message}`);
  process.exit(1);
}

function writeOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  console.log(`[release] ${name}=${value}`);
}

function readSummaries(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => ({ file, path: path.join(dir, file), data: JSON.parse(readFileSync(path.join(dir, file), 'utf8')) }));
}

export function planRelease({ summaries, expectedTargets = [], tagPrefix = '' }) {
  if (summaries.length === 0) return { skipped: true, reason: '没有可发布的产物' };

  const platforms = new Set(summaries.map((item) => item.platform));
  const versions = new Set(summaries.map((item) => item.version));
  const buildNumbers = new Set(summaries.map((item) => item.buildNumber));
  if (platforms.size !== 1 || versions.size !== 1 || buildNumbers.size !== 1) {
    throw new Error(
      `产物元数据不一致：platforms=${[...platforms]} versions=${[...versions]} builds=${[...buildNumbers]}`,
    );
  }

  const produced = new Set(summaries.map((item) => item.target));
  const missing = expectedTargets.filter((target) => !produced.has(target));
  if (missing.length > 0) {
    return { skipped: true, reason: `缺少目标产物：${missing.join(', ')}；不创建不完整的 release` };
  }

  const [platform] = platforms;
  const [version] = versions;
  const [buildNumber] = buildNumbers;
  return {
    skipped: false,
    platform,
    version,
    buildNumber,
    tag: buildReleaseTag({ platform, version, buildNumber, prefix: tagPrefix }),
  };
}

export function releaseAssets({ dir, summary, exists = existsSync }) {
  const artifactPath = path.join(dir, summary.artifactName);
  if (!exists(artifactPath)) return null;
  const assets = [artifactPath];
  const shaPath = path.join(dir, `${summary.target}.sha256`);
  if (exists(shaPath)) assets.push(shaPath);
  return assets;
}

export function buildReleaseNotes({ platform, sourceRepo, ref, releaseEnv, summaries, signingMode }) {
  const lines = [
    `${PLATFORM_LABEL[platform] ?? platform} build · ${sourceRepo}@${ref}`,
    '',
    `- 版本：\`${summaries[0]?.version}\``,
    `- build：\`${summaries[0]?.buildNumber}\``,
    `- 环境：\`${releaseEnv}\``,
    '',
    '| 目标 | 文件 | SHA256 |',
    '| --- | --- | --- |',
    ...summaries.map((item) => `| ${item.target} | \`${item.artifactName}\` | \`${item.sha256}\` |`),
  ];
  if (signingMode === 'temp') {
    lines.push(
      '',
      '> ⚠️ 本构建使用临时签名 keystore，仅用于安装验证。正式分发前请配置 `ANDROID_KEYSTORE_*` secrets 并重新构建。',
    );
  }
  return lines.join('\n');
}

function gh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8', stdio: 'inherit' });
  return result.status ?? 1;
}

function main() {
  const dir = process.env.RELEASE_SUMMARIES_DIR?.trim() || '.private/artifacts';
  const tagPrefix = process.env.RELEASE_TAG_PREFIX?.trim() || '';
  const upload = (process.env.UPLOAD_RELEASE ?? 'true').trim() !== 'false';
  const repo = process.env.GITHUB_REPOSITORY?.trim() || '';

  const entries = readSummaries(dir);
  const summaries = entries.map((entry) => entry.data);
  const expectedTargets = (process.env.RELEASE_EXPECTED_TARGETS ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  const plan = planRelease({ summaries, expectedTargets, tagPrefix });
  if (plan.skipped) {
    writeOutput('release_url', '');
    writeOutput('tag', '');
    writeOutput('uploaded', 'false');
    console.log(`[release] skipped: ${plan.reason}`);
    return;
  }

  const platform = plan.platform;
  const signingMode = summaries.some((item) => item.signingMode === 'temp') ? 'temp' : 'provided';
  const releaseUrl = `https://github.com/${repo}/releases/tag/${plan.tag}`;
  const assetBase = `https://github.com/${repo}/releases/download/${plan.tag}`;

  if (!upload) {
    console.log('[release] UPLOAD_RELEASE=false，跳过 GitHub Release 上传');
  } else {
    if (!repo) fail('GITHUB_REPOSITORY 缺失');
    if (!process.env.GH_TOKEN) fail('GH_TOKEN 缺失');

    const view = spawnSync('gh', ['release', 'view', plan.tag, '--repo', repo, '--json', 'tagName'], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    if ((view.status ?? 1) !== 0) {
      const notes = buildReleaseNotes({
        platform,
        sourceRepo: process.env.RELEASE_SOURCE_REPO ?? '',
        ref: process.env.RELEASE_REF ?? '',
        releaseEnv: process.env.RELEASE_RELEASE_ENV ?? '',
        summaries,
        signingMode,
      });
      const status = gh([
        'release', 'create', plan.tag,
        '--repo', repo,
        '--title', `${PLATFORM_LABEL[platform] ?? platform} ${plan.version} (${plan.buildNumber})`,
        '--notes', notes,
      ]);
      if (status !== 0) {
        // 并发任务可能刚创建同名 release：再确认一次，存在则继续上传。
        const recheck = spawnSync('gh', ['release', 'view', plan.tag, '--repo', repo, '--json', 'tagName'], {
          encoding: 'utf8',
          stdio: 'pipe',
        });
        if ((recheck.status ?? 1) !== 0) fail(`创建 release 失败：${plan.tag}`);
        console.log('[release] release 已由并发任务创建，继续上传产物');
      }
    }

    for (const entry of entries) {
      const assets = releaseAssets({ dir, summary: entry.data });
      if (!assets) {
        console.warn(`[release] 跳过缺失产物：${entry.data.artifactName}`);
        continue;
      }
      const status = gh(['release', 'upload', plan.tag, '--repo', repo, '--clobber', ...assets]);
      if (status !== 0) fail(`上传产物失败：${entry.file}`);
    }
    console.log(`[release] release 已更新：${releaseUrl}`);
  }

  for (const entry of entries) {
    entry.data.downloadUrl = upload ? `${assetBase}/${encodeURIComponent(entry.data.artifactName)}` : '';
    writeFileSync(entry.path, `${JSON.stringify(entry.data, null, 2)}\n`);
  }

  writeOutput('release_url', upload ? releaseUrl : '');
  writeOutput('tag', plan.tag);
  writeOutput('uploaded', String(upload));
  writeOutput('platform', platform);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}