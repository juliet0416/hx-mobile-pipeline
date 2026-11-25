import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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

test('publish-release only sends signed artifacts to the private source and pins its commit', () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'mobile-private-release-'));
  try {
    const dir = path.join(temp, 'artifacts');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'only.json'), JSON.stringify(SUMMARY));
    writeFileSync(path.join(dir, SUMMARY.artifactName), 'fixture');
    const hash = 'a'.repeat(40);
    const log = path.join(temp, 'gh.log');
    writeFileSync(path.join(temp, 'gh'), [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$GH_CALLS"',
      'case "$1:$2" in',
      '  api:repos/example/source) printf "%s\\n" "$SOURCE_PRIVATE";;',
      '  api:repos/example/source/commits/*) printf "%s\\n" "$TEST_COMMIT";;',
      '  release:view) if [ "${RELEASE_EXISTS:-false}" = true ]; then',
      '    printf \'%s\\n\' \'{"assets":[{"name":"oss-download.json"}]}\'',
      '    else exit 1; fi;;',
      'esac',
    ].join('\n') + '\n', { mode: 0o700 });
    writeFileSync(path.join(temp, 'git'), '#!/bin/sh\nprintf "%s\\n" "$TEST_COMMIT"\n', { mode: 0o700 });
    const cli = fileURLToPath(new URL('./publish-release.mjs', import.meta.url));
    const env = {
      PATH: temp + ':' + process.env.PATH,
      GH_CALLS: log,
      GH_TOKEN: 'test-token',
      GITHUB_REPOSITORY: 'example/public-pipeline',
      RELEASE_SUMMARIES_DIR: dir,
      RELEASE_SOURCE_REPO: 'example/source',
      RELEASE_TAG_PREFIX: 'example-release',
      RELEASE_RELEASE_ENV: 'test',
      RELEASE_EXPECTED_TARGETS: 'cn',
      RELEASE_OSS_ENABLED: 'false',
      TEST_COMMIT: hash,
      UPLOAD_RELEASE: 'true',
    };
    const rejected = spawnSync(process.execPath, [cli], { env: { ...env, SOURCE_PRIVATE: 'false' }, encoding: 'utf8' });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /私有源码仓库/);
    assert.doesNotMatch(readFileSync(log, 'utf8'), /release (create|upload)/);

    const published = spawnSync(process.execPath, [cli], { env: { ...env, SOURCE_PRIVATE: 'true' }, encoding: 'utf8' });
    assert.equal(published.status, 0, published.stderr);
    const calls = readFileSync(log, 'utf8');
    assert.match(calls, new RegExp(`release create example-release-test-android-v1\\.5\\.4-29712345 --repo example/source --target ${hash} --latest=false --prerelease`));
    assert.match(calls, /release upload .* --repo example\/source --clobber/);
    assert.doesNotMatch(calls, /example\/public-pipeline/);

    const retried = spawnSync(process.execPath, [cli], {
      env: { ...env, SOURCE_PRIVATE: 'true', RELEASE_EXISTS: 'true' },
      encoding: 'utf8',
    });
    assert.equal(retried.status, 0, retried.stderr);
    const retryCalls = readFileSync(log, 'utf8').slice(calls.length);
    assert.match(retryCalls, /release delete-asset .* oss-download\.json[^\n]*\nrelease upload /);
    assert.match(retryCalls, /release edit .* --notes/);
  } finally {
    rmSync(temp, { force: true, recursive: true });
  }
});
