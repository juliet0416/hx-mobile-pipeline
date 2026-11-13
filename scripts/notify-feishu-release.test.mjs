import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import { buildCard, buildSignedBody, resolveOverallStatus } from './notify-feishu-release.mjs';

test('resolveOverallStatus 失败优先于取消，skipped 视为成功', () => {
  assert.equal(resolveOverallStatus(['success', 'skipped']), 'success');
  assert.equal(resolveOverallStatus(['success', 'cancelled']), 'cancelled');
  assert.equal(resolveOverallStatus(['cancelled', 'failure']), 'failure');
});

test('buildSignedBody 使用 timestamp\\nsecret 的 HMAC-SHA256', () => {
  const secret = 'test-secret';
  const payload = { msg_type: 'text' };
  const body = buildSignedBody(payload, { secret, timestamp: 1700000000 });
  const expected = createHmac('sha256', `1700000000\n${secret}`).update('').digest('base64');
  assert.deepEqual(body, { timestamp: '1700000000', sign: expected, ...payload });
  assert.deepEqual(buildSignedBody(payload, {}), payload);
});

test('buildCard 包含版本、目标和带 tag 的下载链接', () => {
  const card = buildCard({
    uploaded: true,
    platform: 'android',
    version: '1.5.4',
    buildNumber: '29712345',
    targets: ['cn'],
    ref: 'main',
    sourceRepo: 'example/repo',
    repo: 'example/pipeline',
    tag: 'android-v1.5.4-29712345',
    releaseUrl: 'https://github.com/example/pipeline/releases/tag/android-v1.5.4-29712345',
    runUrl: 'https://github.com/example/pipeline/actions/runs/1',
    signingMode: 'temp',
    status: 'success',
    summaries: [{ target: 'cn', artifactName: 'mobile-app-1.5.4-29712345-cn.apk', sizeBytes: 80 * 1024 * 1024 }],
  });

  const serialized = JSON.stringify(card);
  assert.equal(card.card.header.template, 'green');
  assert.match(serialized, /v1\.5\.4/);
  assert.match(serialized, /releases\/download\/android-v1\.5\.4-29712345\/mobile-app-1\.5\.4-29712345-cn\.apk/);
  assert.match(serialized, /临时签名/);
});

test('buildCard 对 iOS 使用 IPA 文案且不出现临时签名提示', () => {
  const card = buildCard({
    uploaded: false,
    platform: 'ios',
    version: '1.5.4',
    buildNumber: '100',
    targets: ['production'],
    ref: 'main',
    sourceRepo: 'example/repo',
    status: 'failure',
    summaries: [{ target: 'production', artifactName: 'mobile-app-1.5.4-100-production.ipa' }],
  });
  const serialized = JSON.stringify(card);
  assert.match(serialized, /iOS IPA/);
  assert.doesNotMatch(serialized, /临时签名/);
  assert.doesNotMatch(serialized, /releases\/download/);
});