import assert from 'node:assert/strict';
import test from 'node:test';

import { buildReleaseNotes, planRelease, releaseAssets } from './publish-release.mjs';

const SUMMARY = {
  platform: 'android',
  target: 'cn',
  version: '1.5.4',
  buildNumber: '29712345',
  artifactName: 'mobile-app-1.5.4-29712345-cn.apk',
  sha256: 'a'.repeat(64),
};

test('planRelease 生成带平台前缀的稳定 tag', () => {
  assert.deepEqual(planRelease({ summaries: [SUMMARY] }), {
    skipped: false,
    platform: 'android',
    version: '1.5.4',
    buildNumber: '29712345',
    tag: 'android-v1.5.4-29712345',
  });
  assert.equal(
    planRelease({ summaries: [{ ...SUMMARY, platform: 'ios', target: 'production' }], tagPrefix: 'release' }).tag,
    'release-v1.5.4-29712345',
  );
  assert.equal(planRelease({ summaries: [] }).skipped, true);
  assert.throws(
    () => planRelease({ summaries: [SUMMARY, { ...SUMMARY, platform: 'ios' }] }),
    /不一致/,
  );
});

test('planRelease 缺目标时不发布', () => {
  const plan = planRelease({ summaries: [SUMMARY], expectedTargets: ['cn', 'global'] });
  assert.equal(plan.skipped, true);
  assert.match(plan.reason, /global/);
  assert.equal(planRelease({ summaries: [SUMMARY], expectedTargets: ['cn'] }).skipped, false);
});

test('buildReleaseNotes 列出目标与临时签名警告', () => {
  const notes = buildReleaseNotes({
    platform: 'android',
    sourceRepo: 'example/repo',
    ref: 'main',
    releaseEnv: 'production',
    signingMode: 'temp',
    summaries: [SUMMARY, { ...SUMMARY, target: 'global', artifactName: 'mobile-app-1.5.4-29712345-global.apk' }],
  });
  assert.match(notes, /example\/repo@main/);
  assert.match(notes, /\| cn \|/);
  assert.match(notes, /\| global \|/);
  assert.match(notes, /临时签名/);
});

test('releaseAssets 上传 APK 本体与校验文件，而不是 summary', () => {
  const present = new Set(['/tmp/x/mobile-app-1.5.4-29712345-cn.apk', '/tmp/x/cn.sha256']);
  const assets = releaseAssets({
    dir: '/tmp/x',
    summary: { target: 'cn', artifactName: 'mobile-app-1.5.4-29712345-cn.apk' },
    exists: (file) => present.has(file),
  });
  assert.deepEqual(assets, ['/tmp/x/mobile-app-1.5.4-29712345-cn.apk', '/tmp/x/cn.sha256']);
  assert.equal(
    releaseAssets({
      dir: '/tmp/x',
      summary: { target: 'cn', artifactName: 'missing.apk' },
      exists: () => false,
    }),
    null,
  );
});
