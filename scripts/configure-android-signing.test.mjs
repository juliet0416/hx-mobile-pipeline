import assert from 'node:assert/strict';
import test from 'node:test';

import { configureReleaseSigning } from './configure-android-signing.mjs';

const TEMPLATE = [
  'android {',
  '    signingConfigs {',
  '        debug {',
  "            storeFile file('debug.keystore')",
  "            storePassword 'android'",
  "            keyAlias 'androiddebugkey'",
  "            keyPassword 'android'",
  '        }',
  '    }',
  '    buildTypes {',
  '        release {',
  '            signingConfig signingConfigs.debug',
  '        }',
  '    }',
  '}',
  '',
].join('\n');

test('configureReleaseSigning 注入 release 配置并切换 buildType', () => {
  const out = configureReleaseSigning(TEMPLATE);
  assert.match(out, /CI_UPLOAD_STORE_FILE/);
  assert.match(out, /signingConfig signingConfigs\.release/);
  assert.doesNotMatch(out, /signingConfig signingConfigs\.debug/);
  assert.equal(out.match(/release \{/g)?.length, 2);
});

test('configureReleaseSigning 重复执行不会重复注入', () => {
  const once = configureReleaseSigning(TEMPLATE);
  const twice = configureReleaseSigning(once);
  assert.equal(twice, once);
});

test('configureReleaseSigning 在模板变化时失败', () => {
  assert.throws(() => configureReleaseSigning('android {}'), /signingConfigs/);
  assert.throws(() => configureReleaseSigning('android { signingConfigs { } buildTypes { } }'), /debug signing block/);
});