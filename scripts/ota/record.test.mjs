import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assertBinary } from './record.mjs';

const ENV = { OTA_ENV_PREFIX: 'APP_', OTA_UPDATE_URL: 'https://u.expo.dev/example-project' };
const baseline = {
  platform: 'ios',
  channel: 'prod',
  version: '1.4.7',
  runtimeVersion: 'a'.repeat(40),
  artifact: { name: 'app.ipa', sha256: '1'.repeat(64) },
};
const binary = { ...baseline, ...baseline.artifact, updateUrl: ENV.OTA_UPDATE_URL };

test('verified native runtime and artifact bytes match', () => {
  assert.doesNotThrow(() => assertBinary(baseline, binary, ENV));
});

test('stale sidecar, different binary, region or disabled project cannot pass', () => {
  for (const changes of [
    { runtimeVersion: 'b'.repeat(40) },
    { sha256: '2'.repeat(64) },
    { name: 'new.ipa' },
    { channel: 'cn-prod' },
    { updateUrl: 'https://evil.test' },
  ]) {
    assert.throws(() => assertBinary(baseline, { ...binary, ...changes }, ENV), /不匹配/);
  }
});