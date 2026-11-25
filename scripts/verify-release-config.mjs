import { readFileSync } from 'node:fs';

const platform = process.argv[2];
const config = JSON.parse(readFileSync(0, 'utf8'));
const expectedAppId = process.env.EXPECTED_APP_ID;
const expectedFlavor = process.env.EXPO_PUBLIC_APP_FLAVOR;
const expectedEnvironment = process.env.EXPO_PUBLIC_RELEASE_ENV;
const appId = platform === 'ios' ? config.ios?.bundleIdentifier : config.android?.package;

if (!['android', 'ios'].includes(platform) || !expectedAppId || appId !== expectedAppId) {
  throw new Error('Expo app identity does not match the signing configuration');
}
if (expectedFlavor && (
  config.extra?.flavor !== expectedFlavor
  || config.extra?.releaseEnv !== expectedEnvironment
  || config.updates?.enabled !== false
  || !config.extra?.apiBaseUrl
  || new URL(config.extra.apiBaseUrl).protocol !== 'https:'
)) {
  throw new Error('Expo archive must use the configured flavor and HTTPS data environment with OTA disabled');
}
if (platform === 'android' && process.env.EXPECTED_FIREBASE_FILE &&
    config.android?.googleServicesFile !== process.env.EXPECTED_FIREBASE_FILE) {
  throw new Error('Firebase configuration does not match the expected Android package');
}
