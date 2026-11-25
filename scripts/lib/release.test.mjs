import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  MAX_VERSION_CODE,
  buildArtifactName,
  buildReleaseTag,
  parseAppConfigVersion,
  parsePlatform,
  parseReleaseEnv,
  parseTarget,
  patchGradleVersion,
  resolveBuildNumber,
  resolveRegion,
} from './release.mjs';

test('parsePlatform / parseTarget 限制平台与目标组合', () => {
  assert.equal(parsePlatform(''), 'android');
  assert.equal(parsePlatform('ios'), 'ios');
  assert.throws(() => parsePlatform('windows'), /platform/);

  assert.equal(parseTarget('cn', 'android'), 'cn');
  assert.equal(parseTarget('global', 'android'), 'global');
  assert.equal(parseTarget('production', 'android'), 'production');
  assert.throws(() => parseTarget('both', 'android'), /target/);
  assert.equal(parseTarget('production', 'ios'), 'production');
  assert.throws(() => parseTarget('cn', 'ios'), /target/);
});

test('parseReleaseEnv accepts test and production service environments', () => {
  assert.equal(parseReleaseEnv(''), 'production');
  assert.equal(parseReleaseEnv('test'), 'test');
  assert.throws(() => parseReleaseEnv('staging'), /release_env/);
});

test('resolveRegion 仅为 cn 设置区域', () => {
  assert.equal(resolveRegion('cn'), 'cn');
  assert.equal(resolveRegion('global'), '');
  assert.equal(resolveRegion('production'), '');
});

test('resolveBuildNumber 优先显式值，否则按分钟递增', () => {
  assert.equal(resolveBuildNumber({ explicit: '123', now: 0 }), '123');
  assert.equal(resolveBuildNumber({ offset: '0', now: 60_000 * 1_000 }), '1000');
  assert.equal(resolveBuildNumber({ offset: 7, now: 60_000 * 1_000 }), '1007');
  assert.equal(resolveBuildNumber({ now: 60_000 * 1_000 }), '1000');
  assert.throws(() => resolveBuildNumber({ explicit: '0' }), /正整数/);
  assert.throws(() => resolveBuildNumber({ explicit: String(MAX_VERSION_CODE + 1) }), /上限/);
  assert.throws(() => resolveBuildNumber({ now: 60_000 * (MAX_VERSION_CODE + 5) }), /上限/);
  assert.throws(() => resolveBuildNumber({ offset: '-1' }), /非负整数/);
});

test('buildArtifactName 生成 apk / ipa 文件名', () => {
  assert.equal(
    buildArtifactName({ version: '1.5.4', buildNumber: '29712345', target: 'cn', extension: 'apk' }),
    'mobile-app-1.5.4-29712345-cn.apk',
  );
  assert.equal(
    buildArtifactName({ prefix: 'demo', version: '1.5.4', buildNumber: '2', target: 'production', extension: 'ipa' }),
    'demo-1.5.4-2-production.ipa',
  );
  assert.throws(
    () => buildArtifactName({ version: '1.5', buildNumber: '2', target: 'cn', extension: 'apk' }),
    /semver/,
  );
  assert.throws(
    () => buildArtifactName({ version: '1.5.4', buildNumber: '2', target: 'cn', extension: 'aab' }),
    /产物类型/,
  );
});

test('parseAppConfigVersion 只读取顶层 version', () => {
  const text = readFileSync(new URL('./fixtures/app.config.ts', import.meta.url), 'utf8');
  assert.equal(parseAppConfigVersion(text), '1.5.4');
  assert.throws(() => parseAppConfigVersion('export default {}'), /const config/);
});

test('patchGradleVersion 同时更新 versionName 与 versionCode', () => {
  const gradle = [
    'android {',
    '    defaultConfig {',
    '        versionCode 1',
    '        versionName "1.0"',
    '    }',
    '}',
    '',
  ].join('\n');
  const out = patchGradleVersion(gradle, { version: '1.5.4', buildNumber: '29712345' });
  assert.match(out, /versionCode 29712345/);
  assert.match(out, /versionName "1.5.4"/);
  assert.equal(out.split('\n').filter((line) => line.includes('versionCode')).length, 1);
});

test('patchGradleVersion 在字段缺失或重复时失败', () => {
  assert.throws(() => patchGradleVersion('android {}', { version: '1.5.4', buildNumber: '2' }), /versionName/);
  const duplicated = 'versionCode 1\nversionCode 2\nversionName "1.0"\n';
  assert.throws(() => patchGradleVersion(duplicated, { version: '1.5.4', buildNumber: '2' }), /versionCode/);
  assert.throws(() => patchGradleVersion('versionCode 1\nversionName "1.0"', { version: '1.5.4', buildNumber: '0' }), /正整数/);
});

test('buildReleaseTag 区分平台，避免 Android/iOS 抢同一个 tag', () => {
  assert.equal(
    buildReleaseTag({ platform: 'android', version: '1.5.4', buildNumber: '100' }),
    'android-v1.5.4-100',
  );
  assert.equal(
    buildReleaseTag({ platform: 'ios', version: '1.5.4', buildNumber: '100' }),
    'ios-v1.5.4-100',
  );
  assert.equal(
    buildReleaseTag({ platform: 'android', version: '1.5.4', buildNumber: '100', prefix: 'apk' }),
    'apk-v1.5.4-100',
  );
});
