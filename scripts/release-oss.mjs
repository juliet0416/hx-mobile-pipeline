import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export const OSS_DOWNLOAD_MANIFEST = 'oss-download.json';

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
    authorizationV4: true, secure: true, timeout: 600_000,
    ...(endpoint ? { endpoint, cname: true } : {}),
  });
}

export async function backupToOss({ settings, releaseEnv, platform, tag, entries, dir, client = createClient(settings) }) {
  const expiresSeconds = 604_800;
  const expiresAt = new Date(Date.now() + expiresSeconds * 1000).toISOString();
  const files = [];
  for (const { artifactName, sha256 } of entries) {
    const expectedExtension = platform === 'ios' ? '.ipa' : '.apk';
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(artifactName)
        || !artifactName.endsWith(expectedExtension)
        || !/^[a-f0-9]{64}$/.test(sha256)
        || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(tag)
        || !['test', 'production'].includes(releaseEnv)) {
      throw new Error('OSS 备份产物名称、摘要或发布路径无效');
    }
    const file = path.join(dir, artifactName);
    const size = statSync(file).size;
    const key = `${settings.prefix}/${releaseEnv}/${platform}/${tag}/${sha256}/${artifactName}`;
    try {
      await client.put(key, file, {
        headers: { 'x-oss-object-acl': 'private', 'x-oss-forbid-overwrite': 'true' },
        meta: { sha256 },
      });
    } catch (error) {
      // 同一份产物的重试复用已校验的对象。
      if (error?.code !== 'FileAlreadyExists' && error?.status !== 409) {
        throw new Error(`OSS 上传失败（${error?.code || error?.status || '未知错误'}）`);
      }
      const existing = await client.head(key);
      if (existing.meta?.sha256 !== sha256 || Number(existing.res?.headers?.['content-length']) !== size) {
        throw new Error('已存在的 OSS 对象与待备份产物不一致');
      }
    }
    const url = await client.signatureUrlV4('GET', expiresSeconds, undefined, key);
    files.push({ fileName: artifactName, key, sha256, sizeBytes: size, expiresAt, url });
  }
  return { bucket: settings.bucket, region: settings.region, files };
}

//#endregion
