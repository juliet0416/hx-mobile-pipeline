#!/usr/bin/env node

/**
 * 解析单次移动端发布的构建输入，输出 GitHub Actions outputs。
 *
 * 设计原则：
 * - 一次运行只构建一份 IPA 或直装 APK；
 * - iOS 自动查询 App Store Connect，Android 在 CI 中使用构建号基数加运行号；
 * - 业务地址不写死在流水线里，由输入或仓库变量提供。
 */

import { appendFileSync } from 'node:fs';

import {
  parseBuildNumberOffset,
  parseBuildNumber,
  parsePlatform,
  parseReleaseEnv,
  parseSemver,
  parseTarget,
  resolveBuildNumber,
  resolveRegion,
} from './lib/release.mjs';
import { resolveStoreBuildNumber } from './resolve-store-build-number.mjs';

function readEnv(name, fallback = '') {
  return process.env[name]?.trim() || fallback;
}

function fail(message) {
  console.error(`[resolve] ${message}`);
  process.exit(1);
}

function writeOutputs(values) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  } else {
    console.log(lines.join('\n'));
  }
}

async function main() {
  const sourceRef = readEnv('MOBILE_SOURCE_REF');
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(sourceRef)) {
    fail('MOBILE_SOURCE_REF 必须是有效的源码 branch/tag/commit');
  }

  let platform;
  let target;
  let releaseEnv;
  let buildNumber;
  let version = '';
  try {
    platform = parsePlatform(readEnv('MOBILE_PLATFORM', 'android'));
    target = parseTarget(readEnv('MOBILE_TARGET', platform === 'ios' ? 'production' : ''), platform);
    releaseEnv = parseReleaseEnv(readEnv('MOBILE_RELEASE_ENV'));
    const explicit = readEnv('MOBILE_BUILD_NUMBER');
    const offset = parseBuildNumberOffset(readEnv('MOBILE_BUILD_NUMBER_OFFSET', '0'));
    const runNumber = readEnv('GITHUB_RUN_NUMBER');
    if (explicit) {
      buildNumber = parseBuildNumber(explicit);
    } else if (platform === 'ios') {
      buildNumber = parseBuildNumber(await resolveStoreBuildNumber({ platform, offset }));
    } else if (runNumber) {
      const base = parseBuildNumberOffset(readEnv('ANDROID_VERSION_CODE_BASE', '0'));
      buildNumber = parseBuildNumber(base + Number(parseBuildNumber(runNumber)) + offset);
    } else {
      buildNumber = resolveBuildNumber({ offset });
    }
    const versionInput = readEnv('MOBILE_VERSION');
    if (versionInput) version = parseSemver(versionInput);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  if (platform === 'android' && (
    readEnv('MOBILE_ARTIFACT_TYPE', 'apk') !== 'apk'
    || !['null', 'false', '"false"'].includes(readEnv('MOBILE_SUBMIT', 'null'))
    || !['null', '[]'].includes(readEnv('MOBILE_RELEASE_ITEMS', 'null'))
  )) fail('Android 发布仅支持单个直装 APK');

  // 业务地址只从输入或仓库变量读取：<INPUT> 优先，其次 MOBILE_<TARGET>_<KEY>。
  const targetKey = target.toUpperCase();
  const apiBaseUrl = readEnv('MOBILE_API_BASE_URL', readEnv(`MOBILE_${targetKey}_API_BASE_URL`));
  const wwwUrl = readEnv('MOBILE_WWW_URL');
  const studioUrl = readEnv('MOBILE_STUDIO_URL');

  if (platform === 'android' && target === 'cn' && !apiBaseUrl) {
    fail(
      'cn 目标必须提供 API 地址：用输入 api_base_url，或仓库变量 '
      + `MOBILE_${targetKey}_API_BASE_URL（与源码 app.config.ts 的国区校验保持一致）`,
    );
  }

  const region = platform === 'android' ? resolveRegion(target) : '';

  writeOutputs({
    source_ref: sourceRef,
    platform,
    target,
    release_env: releaseEnv,
    region,
    api_base_url: apiBaseUrl,
    www_url: wwwUrl,
    studio_url: studioUrl,
    version,
    build_number: buildNumber,
  });

  console.log(
    `[resolve] platform=${platform} target=${target} release_env=${releaseEnv} `
    + `build_number=${buildNumber} version=${version || '(from source)'}`,
  );
  if (platform === 'android') {
    console.log(`[resolve] region=${region || '(global)'} api=${apiBaseUrl || '(from source)'}`);
  }
}

try {
  await main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
