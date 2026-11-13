import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { setIosVersion } from './set-ios-version.mjs';

function writeFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'ios-version-'));
  const app = path.join(root, 'apps/mobile');
  const ios = path.join(app, 'ios');
  mkdirSync(path.join(ios, 'App.xcodeproj'), { recursive: true });
  mkdirSync(path.join(ios, 'App'), { recursive: true });
  mkdirSync(path.join(ios, 'AppWidget'), { recursive: true });
  mkdirSync(path.join(ios, 'Pods', 'Pods'), { recursive: true });

  writeFileSync(
    path.join(ios, 'App.xcodeproj/project.pbxproj'),
    [
      '/* Begin XCBuildConfiguration section */',
      '\t\t\t\tMARKETING_VERSION = 1.0;',
      '\t\t\t\tCURRENT_PROJECT_VERSION = 1;',
      '\t\t\t\tMARKETING_VERSION = 1.0;',
      '\t\t\t\tCURRENT_PROJECT_VERSION = 1;',
      '/* End XCBuildConfiguration section */',
    ].join('\n'),
  );
  writeFileSync(
    path.join(ios, 'App/Info.plist'),
    '<plist><dict><key>CFBundleShortVersionString</key><string>$(MARKETING_VERSION)</string>'
      + '<key>CFBundleVersion</key><string>$(CURRENT_PROJECT_VERSION)</string></dict></plist>',
  );
  writeFileSync(
    path.join(ios, 'AppWidget/Info.plist'),
    '<plist><dict><key>CFBundleShortVersionString</key><string>1.0</string>'
      + '<key>CFBundleVersion</key><string>1</string></dict></plist>',
  );
  writeFileSync(
    path.join(ios, 'Pods/Pods/Info.plist'),
    '<plist><dict><key>CFBundleShortVersionString</key><string>9.9.9</string></dict></plist>',
  );
  return { root, app, ios };
}

test('setIosVersion 写入 pbxproj 与所有非 Pods 的 Info.plist', () => {
  const { root, app, ios } = writeFixture();
  try {
    const result = setIosVersion({ appRoot: app, version: '2.3.4', buildNumber: '567' });
    assert.equal(result.patchedProjects.length, 1);
    assert.equal(result.patchedPlists.length, 2);

    const project = readFileSync(path.join(ios, 'App.xcodeproj/project.pbxproj'), 'utf8');
    assert.match(project, /MARKETING_VERSION = 2\.3\.4;/);
    assert.match(project, /CURRENT_PROJECT_VERSION = 567;/);
    assert.doesNotMatch(project, /MARKETING_VERSION = 1\.0;/);

    const appPlist = readFileSync(path.join(ios, 'App/Info.plist'), 'utf8');
    assert.match(appPlist, /<string>2\.3\.4<\/string>/);
    assert.match(appPlist, /<string>567<\/string>/);
    assert.match(readFileSync(path.join(ios, 'AppWidget/Info.plist'), 'utf8'), /<string>2\.3\.4<\/string>/);

    const pods = readFileSync(path.join(ios, 'Pods/Pods/Info.plist'), 'utf8');
    assert.match(pods, /9\.9\.9/, 'Pods 内的 plist 不应被修改');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('setIosVersion 在结构缺失时失败', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ios-version-empty-'));
  try {
    assert.throws(
      () => setIosVersion({ appRoot: path.join(root, 'apps/mobile'), version: '1.0.0', buildNumber: '1' }),
      /找不到 iOS 工程目录/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});