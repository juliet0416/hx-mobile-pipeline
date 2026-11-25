import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { backupToOss, readOssSettings } from './release-oss.mjs';

test('validates explicit private backup settings', () => {
  assert.equal(readOssSettings({}), null);
  assert.throws(() => readOssSettings({ RELEASE_OSS_ENABLED: 'true' }), /缺少配置/);
  const env = {
    RELEASE_OSS_ENABLED: 'true',
    RELEASE_OSS_BUCKET: 'example-mobile',
    RELEASE_OSS_REGION: 'oss-cn-zhangjiakou',
    RELEASE_OSS_PREFIX: 'private/mobile/',
    OSS_ACCESS_KEY_ID: 'fixture',
    OSS_ACCESS_KEY_SECRET: 'fixture',
  };
  assert.equal(readOssSettings(env).region, 'cn-zhangjiakou');
  assert.equal(readOssSettings(env).prefix, 'private/mobile');
  assert.throws(() => readOssSettings({ ...env, RELEASE_OSS_PREFIX: '../' }), /前缀无效/);
  assert.throws(() => readOssSettings({ ...env, RELEASE_OSS_ENDPOINT: 'http://example.invalid' }), /HTTPS/);
});

test('stores a signed APK privately and reuses a verified copy after an overwrite conflict', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mobile-oss-test-'));
  try {
    const artifactName = 'app.apk';
    const sha256 = 'a'.repeat(64);
    const tag = 'test-android-v1.0.0-1';
    writeFileSync(path.join(dir, artifactName), 'bytes');
    const opts = {
      settings: { bucket: 'example-mobile', region: 'cn-zhangjiakou', prefix: 'private/mobile' },
      releaseEnv: 'test', platform: 'android', tag, entries: [{ artifactName, sha256 }], dir,
    };
    const key = `private/mobile/test/android/${tag}/${sha256}/app.apk`;
    const url = 'https://example.invalid/short-lived-url';
    const client = {
      async put(name, file, options) {
        assert.equal(name, key);
        assert.equal(file, path.join(dir, 'app.apk'));
        assert.equal(options.headers['x-oss-object-acl'], 'private');
        assert.equal(options.headers['x-oss-forbid-overwrite'], 'true');
        assert.equal(options.meta.sha256, sha256);
        throw Object.assign(new Error(), { code: 'FileAlreadyExists', status: 409 });
      },
      async head(name) {
        assert.equal(name, key);
        return { meta: { sha256 }, res: { headers: { 'content-length': '5' } } };
      },
      async signatureUrlV4(method, seconds, _, name) {
        assert.deepEqual([method, seconds, name], ['GET', 604_800, key]);
        return url;
      },
    };
    const manifest = await backupToOss({ ...opts, client });
    assert.deepEqual(manifest.files.map((file) => [file.key, file.url]), [[key, url]]);
    await assert.rejects(
      backupToOss({ ...opts, client: { ...client, head: async () => ({ meta: {} }) } }),
      /不一致/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('uploads large artifacts in private parts and verifies the completed object', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mobile-oss-multipart-'));
  try {
    const artifactName = 'large.apk';
    const filePath = path.join(dir, artifactName);
    const sha256 = 'b'.repeat(64);
    const size = 64 * 1024 * 1024;
    writeFileSync(filePath, '');
    truncateSync(filePath, size);
    const options = {
      settings: { bucket: 'example-mobile', region: 'cn-zhangjiakou', prefix: 'private/mobile' },
      dir, releaseEnv: 'test', platform: 'android', tag: 'test-android-v1.0.0-1',
      entries: [{ artifactName, sha256 }],
    };
    let aborted;
    const client = {
      async multipartUpload(_key, file, settings) {
        assert.equal(file, filePath);
        assert.equal(settings.partSize, 8 * 1024 * 1024);
        assert.equal(settings.parallel, 3);
        assert.deepEqual(settings.headers, { 'x-oss-object-acl': 'private', 'x-oss-forbid-overwrite': 'true' });
        assert.equal(settings.meta.sha256, sha256);
      },
      async head() { return { meta: { sha256 }, res: { headers: { 'content-length': String(size) } } }; },
      async signatureUrlV4() { return 'https://example.invalid/download'; },
      async abortMultipartUpload(key, uploadId) { aborted = { key, uploadId }; },
    };
    const manifest = await backupToOss({ ...options, client });
    assert.equal(manifest.files[0].sizeBytes, size);
    await assert.rejects(backupToOss({
      ...options,
      client: {
        ...client,
        async multipartUpload(_key, _file, settings) {
          settings.progress(0, { uploadId: 'example-upload' });
          throw Object.assign(new Error('internal request details'), { name: 'ConnectionTimeoutError' });
        },
      },
    }), /分片上传失败（ConnectionTimeoutError）/);
    assert.deepEqual(aborted, { key: manifest.files[0].key, uploadId: 'example-upload' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
