import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  productionEnv,
  summarizeSources,
  validateInputs,
  assertCompatible,
} from './runtime.mjs';

const ENV = {
  OTA_ENV_PREFIX: 'APP_',
  OTA_UPDATE_URL: 'https://u.expo.dev/example-project',
  OTA_APP_TITLE: 'Example App',
  OTA_APP_ID: 'com.example.mobile',
  OTA_API_BASE_URL: 'https://api.example.com',
  OTA_CN_API_BASE_URL: 'https://api.example.cn',
  OTA_WWW_URL: 'https://example.com',
  OTA_STUDIO_URL: 'https://example.com/studio',
  OTA_TARGET_GLOBAL: 'global',
  OTA_TARGET_CN: 'cn-apk',
};

test('productionEnv 按前缀生成 App 约定的 OTA 变量，并区分区域', () => {
  const prod = productionEnv('prod', ENV);
  assert.equal(prod.APP_OTA_TARGET, 'global');
  assert.equal(prod.APP_OTA_ENABLED, '1');
  assert.equal(prod.APP_OTA_UPDATE_URL, 'https://u.expo.dev/example-project');
  assert.equal(prod.EXPO_PUBLIC_REGION, 'global');
  assert.equal(prod.EXPO_PUBLIC_API_BASE_URL, 'https://api.example.com');

  const cn = productionEnv('cn-prod', ENV);
  assert.equal(cn.APP_OTA_TARGET, 'cn-apk');
  assert.equal(cn.EXPO_PUBLIC_REGION, 'cn');
  assert.equal(cn.EXPO_PUBLIC_API_BASE_URL, 'https://api.example.cn');

  assert.throws(() => productionEnv('dev', ENV), /channel/);
  assert.throws(() => productionEnv('prod', { ...ENV, OTA_ENV_PREFIX: '' }), /OTA_ENV_PREFIX/);
  assert.throws(() => productionEnv('prod', { ...ENV, OTA_UPDATE_URL: '' }), /缺少 OTA 配置/);
  assert.throws(() => productionEnv('prod', { ...ENV, OTA_UPDATE_URL: 'http://example.com/x' }), /HTTPS/);
});

test('input contract requires immutable source and an exact binary asset', () => {
  const good = {
    ref: 'a'.repeat(40),
    platform: 'android',
    channel: 'cn-prod',
    release: 'any-release-tag',
    artifact: 'mobile-1.4.7-cn.apk',
    message: '修复问题\r\n- 第二条',
    dryRun: 'true',
  };
  assert.equal(validateInputs(good, ENV).message, '修复问题\n- 第二条');
  for (const changes of [
    { ref: 'main' },
    { artifact: '../evil.apk' },
    { artifact: '*.apk' },
    { platform: 'ios' },
    { dryRun: 'yes' },
    { message: '' },
    { release: '' },
  ]) {
    assert.throws(() => validateInputs({ ...good, ...changes }, ENV));
  }
});

const snapshot = {
  schema: 1,
  platform: 'ios',
  channel: 'prod',
  version: '1.4.7',
  runtimeVersion: 'a'.repeat(40),
  recipe: 'b'.repeat(64),
  toolchain: { node: '22.16.0', bun: '1.3.6', os: 'darwin', arch: 'arm64' },
  fingerprintSources: [{ type: 'dir', filePath: 'native', hash: '1' }],
};

test('compatible snapshots can have different JS commits', () => {
  assert.doesNotThrow(() => assertCompatible({ ...snapshot, sourceCommit: 'old' }, { ...snapshot, sourceCommit: 'new' }));
});

test('runtime/config/recipe/tool changes stop before publication', () => {
  for (const changes of [
    { runtimeVersion: 'b'.repeat(40) },
    { version: '1.4.8' },
    { channel: 'cn-prod' },
    { platform: 'android' },
    { recipe: 'c'.repeat(64) },
    { toolchain: { ...snapshot.toolchain, bun: '1.3.7' } },
  ]) {
    assert.throws(() => assertCompatible(snapshot, { ...snapshot, ...changes }), /不匹配/);
  }
});

test('fingerprint records never store raw config contents', () => {
  assert.deepEqual(
    summarizeSources([{ type: 'contents', id: 'expoConfig', contents: 'SECRET', hash: '123', reasons: ['config'] }]),
    [{ type: 'contents', id: 'expoConfig', hash: '123' }],
  );
});