#!/usr/bin/env node

/**
 * 把版本号写进 expo prebuild 生成的 android/app/build.gradle。
 * 只在 prebuild 之后执行；写入失败直接中断，避免产出错误 versionCode 的包。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { patchGradleVersion } from './lib/release.mjs';

const gradlePath = resolve(process.argv[2] ?? 'source/apps/mobile/android/app/build.gradle');
const version = process.env.BUILD_VERSION?.trim();
const buildNumber = process.env.BUILD_NUMBER?.trim();

if (!version || !buildNumber) {
  console.error('[android-version] BUILD_VERSION 与 BUILD_NUMBER 必填');
  process.exit(1);
}

try {
  const text = readFileSync(gradlePath, 'utf8');
  writeFileSync(gradlePath, patchGradleVersion(text, { version, buildNumber }));
  console.log(`[android-version] versionName=${version} versionCode=${buildNumber} (${gradlePath})`);
} catch (error) {
  console.error(`[android-version] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}