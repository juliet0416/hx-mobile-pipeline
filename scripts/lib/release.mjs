/**
 * 移动端发布流水线的纯函数集合。
 *
 * 平台无关：Android 目前只出 APK（cn / global 二选一），iOS 出 IPA。
 * 这里不包含任何业务方地址或包名，具体后端地址由 workflow 变量/输入提供。
 */

export const ANDROID_TARGETS = ['cn', 'global', 'production'];
export const IOS_TARGETS = ['production'];
export const MAX_VERSION_CODE = 2100000000;

const SEMVER = /^\d+\.\d+\.\d+$/;
const POSITIVE_INT = /^[1-9]\d*$/;
const NON_NEGATIVE_INT = /^(0|[1-9]\d*)$/;

function fail(message) {
  throw new Error(message);
}

function trim(value) {
  return String(value ?? '').trim();
}

export function parsePlatform(raw) {
  const value = trim(raw) || 'android';
  if (value !== 'android' && value !== 'ios') {
    fail(`platform 只能是 android 或 ios，收到 "${raw}"`);
  }
  return value;
}

export function parseTarget(raw, platform) {
  const value = trim(raw);
  const allowed = platform === 'ios' ? IOS_TARGETS : ANDROID_TARGETS;
  if (!allowed.includes(value)) {
    fail(`target 只能是 ${allowed.join(' / ')}，收到 "${raw}"`);
  }
  return value;
}

export function parseReleaseEnv(raw) {
  const value = trim(raw) || 'production';
  if (value !== 'production' && value !== 'test') {
    fail(`release_env 只能是 production 或 test，收到 "${raw}"`);
  }
  return value;
}

/** cn 需要区域标记；global 清空区域。 */
export function resolveRegion(target) {
  return trim(target) === 'cn' ? 'cn' : '';
}

export function parseSemver(raw, label = 'version') {
  const value = trim(raw);
  if (!SEMVER.test(value)) {
    fail(`${label} 必须是 x.y.z 形式的 semver，收到 "${raw}"`);
  }
  return value;
}

export function parseBuildNumber(raw, label = 'build_number') {
  const value = trim(raw);
  if (!POSITIVE_INT.test(value)) {
    fail(`${label} 必须是正整数，收到 "${raw}"`);
  }
  const number = Number(value);
  if (number > MAX_VERSION_CODE) {
    fail(`${label} 不能超过上限 ${MAX_VERSION_CODE}，收到 "${raw}"`);
  }
  return String(number);
}

export function parseBuildNumberOffset(raw) {
  const value = trim(raw) || '0';
  if (!NON_NEGATIVE_INT.test(value)) {
    fail(`build_number_offset 必须是非负整数，收到 "${raw}"`);
  }
  return Number(value);
}

/**
 * 不依赖应用商店时的构建号来源：自 epoch 起的分钟数。
 * 同一分钟内重复构建会得到相同编号，需要时可显式传 build_number 或 offset。
 */
export function resolveBuildNumber({ explicit, offset = 0, now = Date.now() } = {}) {
  if (trim(explicit)) return parseBuildNumber(explicit);

  const offsetNumber = typeof offset === 'number' ? offset : parseBuildNumberOffset(offset);
  const value = Math.floor(now / 60000) + offsetNumber;
  if (value <= 0) fail(`解析出的 build number 非法：${value}`);
  if (value > MAX_VERSION_CODE) {
    fail(`解析出的 build number ${value} 超过上限 ${MAX_VERSION_CODE}`);
  }
  return String(value);
}

export function buildArtifactName({ prefix = 'mobile-app', version, buildNumber, target, extension, releaseEnv }) {
  const safePrefix = trim(prefix) || 'mobile-app';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(safePrefix)) fail('产物前缀无效');
  const releaseTarget = trim(target);
  const fileType = trim(extension);
  if (!ANDROID_TARGETS.includes(releaseTarget)) {
    fail(`未知 target "${target}"`);
  }
  if (!['apk', 'ipa'].includes(fileType)) {
    fail(`未知产物类型 "${extension}"`);
  }
  const kind = fileType === 'ipa' ? 'iOS' : releaseTarget === 'cn' ? 'Android' : 'Android_global';
  const env = parseReleaseEnv(releaseEnv) === 'test' ? 'test' : 'prod';
  return `${safePrefix}_${kind}_${parseSemver(version)}-${parseBuildNumber(buildNumber)}_${env}.${fileType}`;
}

/**
 * 从 app.config.ts 读取顶层 version。只接受 `const config: ExpoConfig` 之后的
 * 第一个 version 字段，避免误命中 runtimeVersion 之类的字段。
 */
export function parseAppConfigVersion(text) {
  const marker = text.indexOf('const config: ExpoConfig');
  if (marker < 0) fail('app.config.ts 中找不到 `const config: ExpoConfig`');
  const match = text.slice(marker).match(/^\s*version:\s*'(\d+\.\d+\.\d+)'/m);
  if (!match) fail('app.config.ts 中找不到顶层 version');
  return match[1];
}

/**
 * 修改 Expo prebuild 生成的 android/app/build.gradle。
 * 要求 versionName / versionCode 各出现一次，出现变化时直接失败而不是静默漏改。
 */
export function patchGradleVersion(text, { version, buildNumber }) {
  const nextVersion = parseSemver(version);
  const nextCode = parseBuildNumber(buildNumber);

  const nameMatches = text.match(/versionName\s+["'][^"']+["']/g) ?? [];
  if (nameMatches.length !== 1) {
    fail(`build.gradle 中 versionName 出现 ${nameMatches.length} 次，预期 1 次`);
  }
  const codeMatches = text.match(/versionCode\s+\d+/g) ?? [];
  if (codeMatches.length !== 1) {
    fail(`build.gradle 中 versionCode 出现 ${codeMatches.length} 次，预期 1 次`);
  }

  const patched = text
    .replace(/(versionName\s+["'])[^"']+(["'])/, `$1${nextVersion}$2`)
    .replace(/(versionCode\s+)\d+/, `$1${nextCode}`);

  if (!patched.includes(`versionName "${nextVersion}"`) && !patched.includes(`versionName '${nextVersion}'`)) {
    fail('build.gradle versionName 写入后校验失败');
  }
  if (!new RegExp(`versionCode\\s+${nextCode}\\b`).test(patched)) {
    fail('build.gradle versionCode 写入后校验失败');
  }
  return patched;
}

/** 各平台和环境的产物按品牌源码版本聚合。 */
export function buildReleaseTag({ version, prefix = '', ref = '' }) {
  const brand = trim(prefix);
  if (brand && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(brand)) fail('release tag 前缀无效');
  const tagPrefix = `${brand ? `${brand}-` : ''}mobile-v`;
  const tag = `${tagPrefix}${parseSemver(version)}`;
  const source = trim(ref).replace(/^refs\/tags\//, '');
  if (source.startsWith(tagPrefix) && SEMVER.test(source.slice(tagPrefix.length)) && source !== tag) {
    fail('构建版本与所选源码 tag 不一致');
  }
  return tag;
}
