#!/usr/bin/env node

/**
 * Android APK 签名准备。
 *
 * generate：在 prepare job 里执行。优先使用 ANDROID_KEYSTORE_BASE64 提供的正式
 * keystore；未配置时生成一套仅本次运行有效的临时 keystore，供 cn/global 共用，
 * 让流水线在正式签名材料就绪前也能产出可安装的 APK。
 *
 * restore：在 build job 里执行，把 keystore 还原到 android/app，并把 Gradle 需要的
 * ORG_GRADLE_PROJECT_CI_UPLOAD_* 写入 GITHUB_ENV。
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const TEMP_ALIAS = 'hx-upload';
const KEYSTORE_FILE = 'ci-upload.keystore';

function fail(message) {
  console.error(`[android-signing] ${message}`);
  process.exit(1);
}

function writeOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  console.log(`[android-signing] ${name}=${value}`);
}

function writeGradleEnv(values) {
  const lines = Object.entries(values).map(([key, value]) => `ORG_GRADLE_PROJECT_${key}=${value}`);
  for (const line of lines) console.log(`[android-signing] ${line.split('=')[0]}=<set>`);
  if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `${lines.join('\n')}\n`);
}

function generate(outDir) {
  const provided = process.env.ANDROID_KEYSTORE_BASE64?.trim();
  mkdirSync(outDir, { recursive: true });

  if (provided) {
    for (const name of ['ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD']) {
      if (!process.env[name]?.trim()) {
        fail(`已配置 ANDROID_KEYSTORE_BASE64 时 ${name} 必填`);
      }
    }
    const target = path.join(outDir, KEYSTORE_FILE);
    writeFileSync(target, Buffer.from(provided, 'base64'));
    console.log(`[android-signing] 使用 ANDROID_KEYSTORE_BASE64 提供的 keystore`);
    writeOutput('signing_mode', 'provided');
    return;
  }

  const storePassword = randomBytes(18).toString('hex');
  const target = path.join(outDir, KEYSTORE_FILE);
  const result = spawnSync('keytool', [
    '-genkeypair',
    '-keystore', target,
    '-storetype', 'PKCS12',
    '-alias', TEMP_ALIAS,
    '-keyalg', 'RSA',
    '-keysize', '2048',
    '-validity', '3650',
    '-storepass', storePassword,
    '-keypass', storePassword,
    '-dname', 'CN=Temporary Mobile Signing, OU=Mobile, O=Mobile Pipeline, C=CN',
  ], { stdio: 'inherit' });

  if (result.status !== 0) fail('keytool 生成临时 keystore 失败');

  writeFileSync(
    path.join(outDir, 'temp-signing.properties'),
    [
      `storeFile=${KEYSTORE_FILE}`,
      `storePassword=${storePassword}`,
      `keyAlias=${TEMP_ALIAS}`,
      `keyPassword=${storePassword}`,
      '',
    ].join('\n'),
  );
  console.warn(
    '[android-signing] 未配置 ANDROID_KEYSTORE_BASE64，已生成仅本次运行有效的临时 keystore；'
    + '该包只能用于安装验证，跨构建升级前必须配置正式 keystore。',
  );
  writeOutput('signing_mode', 'temp');
}

function restore(target) {
  const mode = process.env.SIGNING_MODE?.trim();
  mkdirSync(path.dirname(target), { recursive: true });

  if (mode === 'provided') {
    const provided = process.env.ANDROID_KEYSTORE_BASE64?.trim();
    const storePassword = process.env.ANDROID_KEYSTORE_PASSWORD?.trim();
    const keyAlias = process.env.ANDROID_KEY_ALIAS?.trim();
    const keyPassword = process.env.ANDROID_KEY_PASSWORD?.trim();
    if (!provided || !storePassword || !keyAlias || !keyPassword) {
      fail('SIGNING_MODE=provided 时 ANDROID_KEYSTORE_BASE64/PASSWORD/KEY_ALIAS/KEY_PASSWORD 均必填');
    }
    writeFileSync(target, Buffer.from(provided, 'base64'));
    writeGradleEnv({
      CI_UPLOAD_STORE_FILE: KEYSTORE_FILE,
      CI_UPLOAD_STORE_PASSWORD: storePassword,
      CI_UPLOAD_KEY_ALIAS: keyAlias,
      CI_UPLOAD_KEY_PASSWORD: keyPassword,
    });
    console.log('[android-signing] 已还原正式 keystore');
    return;
  }

  if (mode !== 'temp') fail(`未知 SIGNING_MODE "${mode}"，只能是 provided 或 temp`);

  const sourceDir = process.env.SIGNING_SOURCE_DIR || '.private/signing';
  const source = path.join(sourceDir, KEYSTORE_FILE);
  const propertiesPath = path.join(sourceDir, 'temp-signing.properties');
  if (!existsSync(source) || !existsSync(propertiesPath)) {
    fail(`临时签名材料缺失：${source} / ${propertiesPath}`);
  }
  copyFileSync(source, target);

  const properties = Object.fromEntries(
    readFileSync(propertiesPath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
  for (const key of ['storePassword', 'keyAlias', 'keyPassword']) {
    if (!properties[key]) fail(`临时签名配置缺少 ${key}`);
  }
  writeGradleEnv({
    CI_UPLOAD_STORE_FILE: KEYSTORE_FILE,
    CI_UPLOAD_STORE_PASSWORD: properties.storePassword,
    CI_UPLOAD_KEY_ALIAS: properties.keyAlias,
    CI_UPLOAD_KEY_PASSWORD: properties.keyPassword,
  });
  console.warn('[android-signing] 已还原本次临时 keystore；产物仅用于安装验证。');
}

function main() {
  const [mode, argument] = process.argv.slice(2);
  if (mode === 'generate') {
    generate(argument || '.private/signing');
    return;
  }
  if (mode === 'restore') {
    restore(argument || 'source/apps/mobile/android/app/ci-upload.keystore');
    return;
  }
  fail('用法：prepare-signing-keystore.mjs generate <outDir> | restore <keystorePath>');
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}