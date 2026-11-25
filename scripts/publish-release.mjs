#!/usr/bin/env node

/**
 * 汇总本次构建产物，创建/更新 GitHub Release，并把下载链接回写到 summary。
 * Android / iOS 共用；UPLOAD_RELEASE=false 时只输出 tag，不创建 release。
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildReleaseTag, privateReleasePrefix } from './lib/release.mjs';
import { backupToOss, OSS_DOWNLOAD_MANIFEST, readOssSettings } from './release-oss.mjs';

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
    .filter((file) => file.endsWith('.json') && file !== OSS_DOWNLOAD_MANIFEST)
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
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(apk|ipa)$/.test(summary.artifactName)) return null;
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

//#region 私有 Release 发布

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: 'pipe' });
  if (result.status !== 0) fail(`${command} 操作失败`);
  return result.stdout.trim();
}

function viewReleaseAssets(repo, tag) {
  return spawnSync('gh', ['release', 'view', tag, '--repo', repo, '--json', 'assets'], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

async function main() {
  const dir = process.env.RELEASE_SUMMARIES_DIR?.trim() || '.private/artifacts';
  const tagPrefix = process.env.RELEASE_TAG_PREFIX?.trim() || '';
  const upload = (process.env.UPLOAD_RELEASE ?? 'true').trim() !== 'false';
  const oss = upload ? readOssSettings(process.env) : null;
  const repo = process.env.RELEASE_SOURCE_REPO?.trim() || '';

  const entries = readSummaries(dir);
  const summaries = entries.map((entry) => entry.data);
  const expectedTargets = (process.env.RELEASE_EXPECTED_TARGETS ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  const releaseEnv = process.env.RELEASE_RELEASE_ENV?.trim() || 'production';
  const prefix = privateReleasePrefix({ tagPrefix, releaseEnv, platform: summaries[0]?.platform });
  const plan = planRelease({ summaries, expectedTargets, tagPrefix: prefix });
  if (plan.skipped) {
    writeOutput('release_url', '');
    writeOutput('tag', '');
    writeOutput('uploaded', 'false');
    if (upload) fail(plan.reason);
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
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) fail('RELEASE_SOURCE_REPO 缺失或非法');
    if (!process.env.GH_TOKEN) fail('GH_TOKEN 缺失');
    if (capture('gh', ['api', `repos/${repo}`, '--jq', '.private']) !== 'true') {
      fail('签名产物只允许写入私有源码仓库');
    }
    const sha = capture('git', ['-C', 'source', 'rev-parse', 'HEAD']);
    if (!/^[a-f0-9]{40}$/.test(sha)) fail('无法确认实际构建的源码提交');
    const assets = entries.flatMap((entry) => {
      const found = releaseAssets({ dir, summary: entry.data });
      if (!found) fail(`签名产物缺失：${entry.file}`);
      return found;
    });
    const notes = buildReleaseNotes({
      platform, sourceRepo: repo, ref: process.env.RELEASE_REF ?? '', releaseEnv, summaries, signingMode,
    });

    let view = viewReleaseAssets(repo, plan.tag);
    if ((view.status ?? 1) !== 0) {
      const status = gh([
        'release', 'create', plan.tag,
        '--repo', repo,
        '--target', sha,
        '--latest=false',
        ...(releaseEnv === 'test' ? ['--prerelease'] : []),
        '--title', `${PLATFORM_LABEL[platform] ?? platform} ${plan.version} (${plan.buildNumber})`,
        '--notes', notes,
      ]);
      if (status !== 0) {
        view = viewReleaseAssets(repo, plan.tag);
        if ((view.status ?? 1) !== 0) fail(`创建 release 失败：${plan.tag}`);
        console.log('[release] release 已由并发任务创建，继续上传产物');
      }
    }

    const tagSha = capture('gh', ['api', `repos/${repo}/commits/${encodeURIComponent(plan.tag)}`, '--jq', '.sha']);
    if (tagSha !== sha) {
      fail('已有 Release tag 指向不同源码提交');
    }
    // 重打包可能改变文件摘要。替换安装包前先撤下旧 OSS 清单。
    const previousAssets = view.status === 0 ? JSON.parse(view.stdout).assets : [];
    if (previousAssets.some((asset) => asset.name === OSS_DOWNLOAD_MANIFEST)) {
      const removed = gh(['release', 'delete-asset', plan.tag, OSS_DOWNLOAD_MANIFEST, '--repo', repo, '--yes']);
      if (removed !== 0) fail('移除上次构建的 OSS 下载清单失败');
    }
    const status = gh(['release', 'upload', plan.tag, '--repo', repo, '--clobber', ...assets]);
    if (status !== 0) fail('上传签名产物失败');
    writeOutput('uploaded', 'true');
    console.log(`[release] release 已更新：${releaseUrl}`);
    if (view.status === 0 && gh(['release', 'edit', plan.tag, '--repo', repo, '--notes', notes]) !== 0) {
      fail('刷新 Release 校验信息失败');
    }
    if (oss) {
      const manifest = await backupToOss({ settings: oss, releaseEnv, platform, tag: plan.tag, entries: summaries, dir });
      const manifestPath = path.join(dir, OSS_DOWNLOAD_MANIFEST);
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      const manifestUpload = gh(['release', 'upload', plan.tag, '--repo', repo, '--clobber', manifestPath]);
      if (manifestUpload !== 0) fail('上传私有 OSS 下载清单失败');
      console.log('[release] OSS 备份已完成，备份清单已写入私有 Release');
      for (const { downloadError } of manifest.files) {
        if (downloadError) console.warn(`[release] OSS 下载链接暂不可用（${downloadError}），请从私库 Release 下载`);
      }
    }
  }

  for (const entry of entries) {
    entry.data.downloadUrl = upload ? `${assetBase}/${encodeURIComponent(entry.data.artifactName)}` : '';
    writeFileSync(entry.path, `${JSON.stringify(entry.data, null, 2)}\n`);
  }

  writeOutput('release_url', upload ? releaseUrl : '');
  writeOutput('tag', plan.tag);
  if (!upload) writeOutput('uploaded', 'false');
  writeOutput('platform', platform);
}

//#endregion

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
