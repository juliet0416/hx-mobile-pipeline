#!/usr/bin/env node

/**
 * 在源码 checkout 之后确定本次发布的版本号与产物文件名。
 *
 * - 显式传了 MOBILE_VERSION：同步改写 app.config.ts / package.json；
 * - 没传：直接采用源码 app.config.ts 里的版本，不改动源码。
 */

import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { buildArtifactName, parseAppConfigVersion, parseSemver } from './lib/release.mjs';
import { updateManagedAppVersion } from './update-managed-app-version.mjs';

const SOURCE_PATH = process.env.SOURCE_PATH || 'source';
const APP_ROOT = path.resolve(SOURCE_PATH, 'apps/mobile');

function fail(message) {
  console.error(`[build-env] ${message}`);
  process.exit(1);
}

function writeEnv(values) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  for (const line of lines) console.log(`[build-env] ${line}`);
  if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `${lines.join('\n')}\n`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
}

function main() {
  const platform = process.env.BUILD_PLATFORM?.trim();
  const target = process.env.BUILD_TARGET?.trim();
  const buildNumber = process.env.BUILD_NUMBER?.trim();
  if (platform !== 'android' && platform !== 'ios') fail(`BUILD_PLATFORM 非法：${platform}`);
  if (!target) fail('BUILD_TARGET 必填');
  if (!buildNumber) fail('BUILD_NUMBER 必填');

  const prefix = process.env.MOBILE_ARTIFACT_PREFIX?.trim() || 'mobile-app';
  const sourceVersion = parseAppConfigVersion(readFileSync(path.join(APP_ROOT, 'app.config.ts'), 'utf8'));
  const explicitVersion = process.env.MOBILE_VERSION?.trim();

  let version = sourceVersion;
  if (explicitVersion) {
    try {
      version = parseSemver(explicitVersion);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    const result = updateManagedAppVersion({ root: APP_ROOT, version });
    if (result.appConfig.changed || result.packageJson.changed) {
      console.log(`[build-env] 版本已从 ${sourceVersion} 改写为 ${version}`);
    }
  }

  const artifactName = buildArtifactName({
    prefix,
    version,
    buildNumber,
    target,
    extension: platform === 'android' ? 'apk' : 'ipa',
    releaseEnv: process.env.EXPO_PUBLIC_RELEASE_ENV,
  });

  writeEnv({
    BUILD_PLATFORM: platform,
    BUILD_TARGET: target,
    BUILD_VERSION: version,
    BUILD_NUMBER: buildNumber,
    ARTIFACT_NAME: artifactName,
  });
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
