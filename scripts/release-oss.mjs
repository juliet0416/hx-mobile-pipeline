import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const MULTIPART_THRESHOLD = 64 * 1024 * 1024;
const MULTIPART_PART_SIZE = 8 * 1024 * 1024;

//#region OSS 私有备份

export function readOssSettings(env) {
  if (env.RELEASE_OSS_ENABLED !== 'true') return null;
  const required = [
    'RELEASE_OSS_BUCKET', 'RELEASE_OSS_REGION', 'RELEASE_OSS_PREFIX',
    'OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET',
  ];
  const missing = required.filter((name) => !env[name]?.trim());
  if (missing.length) throw new Error(`OSS 备份缺少配置：${missing.join(', ')}`);
  const prefix = env.RELEASE_OSS_PREFIX.trim().replace(/\/$/, '');
  const region = env.RELEASE_OSS_REGION.trim().replace(/^oss-/, '');
  const bucket = env.RELEASE_OSS_BUCKET.trim();
  if (!/^[a-z0-9][a-z0-9-]+[a-z0-9]$/.test(bucket)
      || !/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(region)
      || !prefix.split('/').every((part) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part))) {
    throw new Error('OSS bucket、region 或路径前缀无效');
  }
  const endpoint = env.RELEASE_OSS_ENDPOINT?.trim();
  if (endpoint) {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) {
      throw new Error('OSS 自定义 endpoint 必须是 HTTPS origin');
    }
  }
  return { bucket, region, prefix, endpoint, accessKeyId: env.OSS_ACCESS_KEY_ID, accessKeySecret: env.OSS_ACCESS_KEY_SECRET };
}

function createClient({ bucket, region, endpoint, accessKeyId, accessKeySecret }) {
  const requireFromSource = createRequire(path.resolve('source/package.json'));
  const OSS = requireFromSource('ali-oss');
  return new OSS({
    bucket, region: `oss-${region}`, accessKeyId, accessKeySecret,
    authorizationV4: true, secure: true, timeout: 120_000, retryMax: 2,
    ...(endpoint ? { endpoint, cname: true } : {}),
  });
}

function uploadErrorLabel(error) {
  return [error?.code, error?.name, error?.status].find((value) =>
    /^[a-z0-9_-]+$/i.test(String(value ?? '')) && value !== 'Error') ?? '未知错误';
}

async function uploadObject(client, key, file, size, sha256) {
  const options = {
    headers: { 'x-oss-object-acl': 'private', 'x-oss-forbid-overwrite': 'true' },
    meta: { sha256 },
  };
  let uploadId;
  try {
    if (size >= MULTIPART_THRESHOLD) {
      await client.multipartUpload(key, file, {
        ...options,
        partSize: MULTIPART_PART_SIZE,
        parallel: 3,
        progress(_progress, checkpoint) { uploadId = checkpoint?.uploadId; },
      });
    } else {
      await client.put(key, file, options);
    }
  } catch (error) {
    if (uploadId) {
      try {
        await client.abortMultipartUpload(key, uploadId);
      } catch (cleanupError) {
        console.warn(`[oss] 清理分片上传失败（${uploadErrorLabel(cleanupError)}）`);
      }
    }
    if (error?.code !== 'FileAlreadyExists' && error?.status !== 409) {
      throw new Error(`OSS ${size >= MULTIPART_THRESHOLD ? '分片上传' : '上传'}失败（${uploadErrorLabel(error)}）`);
    }
  }
}

export async function describeOssObject({ client, key, artifactName, sha256, size, fetchImpl = fetch }) {
  const stored = await client.head(key);
  if (stored.meta?.sha256 !== sha256 || Number(stored.res?.headers?.['content-length']) !== size) {
    throw new Error('OSS 对象与待备份产物不一致');
  }
  const expiresSeconds = 604_800;
  const expiresAt = new Date(Date.now() + expiresSeconds * 1000).toISOString();
  const entry = { fileName: artifactName, key, sha256, sizeBytes: size };
  try {
    const url = await client.signatureUrlV4('GET', expiresSeconds, undefined, key);
    const response = await fetchImpl(url, {
      headers: { Range: 'bytes=0-0' },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 400) {
      const forbidden = /<Code>ApkDownloadForbidden<\/Code>/.test(await response.text());
      return { ...entry, downloadError: forbidden ? 'ApkDownloadForbidden' : 'HTTP 400' };
    }
    await response.body?.cancel();
    if ((response.status === 206 && response.headers.get('content-range') === `bytes 0-0/${size}`)
      || (response.status === 200 && Number(response.headers.get('content-length')) === size)) {
      return { ...entry, expiresAt, url };
    }
    return { ...entry, downloadError: `HTTP ${response.status}` };
  } catch (error) {
    return { ...entry, downloadError: uploadErrorLabel(error) };
  }
}

export async function backupToOss({ settings, platform, entries, dir, client = createClient(settings), fetchImpl = fetch }) {
  const files = [];
  for (const { artifactName, sha256 } of entries) {
    const expectedExtension = platform === 'ios' ? '.ipa' : '.apk';
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(artifactName)
        || !artifactName.endsWith(expectedExtension)
        || !/^[a-f0-9]{64}$/.test(sha256)
        || !['ios', 'android'].includes(platform)) {
      throw new Error('OSS 备份产物名称、摘要或发布路径无效');
    }
    const file = path.join(dir, artifactName);
    const size = statSync(file).size;
    const key = `${settings.prefix}/appupdate/${artifactName}`;
    await uploadObject(client, key, file, size, sha256);
    files.push(await describeOssObject({ client, key, artifactName, sha256, size, fetchImpl }));
  }
  return { bucket: settings.bucket, region: settings.region, files };
}

//#endregion
