import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import { buildCard, buildFallbackInput, buildSignedBody, resolveOverallStatus } from './notify-feishu-release.mjs';

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
  assert.equal(card.card.header.title.content, 'Android 打包成功');
  assert.deepEqual(card.card.elements.slice(0, 3).map((item) => item.tag), ['div', 'hr', 'div']);
  assert.match(serialized, /v1\.5\.4/);
  assert.match(serialized, /releases\/download\/android-v1\.5\.4-29712345\/mobile-app-1\.5\.4-29712345-cn\.apk/);
  assert.match(serialized, /临时签名/);
});

test('buildCard 显示 iOS 失败、测试环境和 TestFlight 目标，不显示空构建号标记', () => {
  const card = buildCard({
    uploaded: false,
    platform: 'ios',
    version: '1.5.4',
    targets: ['production'],
    ref: 'main',
    sourceRepo: 'example/repo',
    status: 'failure',
    releaseEnv: 'test',
    submitToStore: true,
    failureStage: '准备发布',
    summaries: [{ target: 'production', artifactName: 'mobile-app-1.5.4-100-production.ipa' }],
  });
  const serialized = JSON.stringify(card);
  assert.equal(card.card.header.template, 'red');
  assert.equal(card.card.header.title.content, 'iOS 打包失败');
  assert.match(serialized, /测试环境/);
  assert.match(serialized, /提交 TestFlight.*是/);
  assert.match(serialized, /构建号.*—/);
  assert.match(serialized, /准备发布/);
  assert.doesNotMatch(serialized, /临时签名/);
  assert.doesNotMatch(serialized, /releases\/download/);
});

const sampleRun = {
  name: 'iOS IPA mobile-v1.5.4 · test · production · TestFlight',
  path: '.github/workflows/mobile-ios-release.yml',
  display_title: 'iOS IPA mobile-v1.5.4 · test · production · TestFlight',
  run_number: 17,
  html_url: 'https://github.com/example/pipeline/actions/runs/55',
};

test('构建取消且原通知未执行时生成灰色卡片和原运行链接', () => {
  const input = buildFallbackInput({ ...sampleRun, conclusion: 'cancelled' }, [], 'example/source');
  const card = buildCard(input);
  assert.equal(card.card.header.title.content, 'iOS 打包已取消');
  assert.equal(card.card.header.template, 'grey');
  assert.match(JSON.stringify(card), /\[#17\]\(https:\/\/github\.com\/example\/pipeline\/actions\/runs\/55\)/);
  assert.equal(input.releaseEnv, 'test');
  assert.equal(input.submitToStore, true);
});

test('补发失败时保留失败步骤，已有成功通知时不再发送', () => {
  const run = { ...sampleRun, conclusion: 'failure' };
  const build = { name: 'build', conclusion: 'failure', steps: [{ name: 'Verify Expo', conclusion: 'failure' }] };
  const notice = { name: 'notify', steps: [{ name: 'Notify Feishu release bot', conclusion: 'success' }] };
  assert.equal(buildFallbackInput(run, [build], 'example/source').failureStage, 'Verify Expo');
  assert.equal(buildFallbackInput(run, [build, notice], 'example/source'), null);
});
