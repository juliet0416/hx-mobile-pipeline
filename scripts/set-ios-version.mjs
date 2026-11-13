#!/usr/bin/env node

/**
 * 把版本号写进 expo prebuild 生成的 iOS 工程。
 *
 * 不依赖固定工程名：自动发现 ios/*.xcodeproj，并改写所有非 Pods/build 的
 * Info.plist。工程或 plist 结构变化时直接失败，避免静默漏改。
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function fail(message) {
  throw new Error(message);
}

function collectInfoPlists(dir, output = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'Pods' || entry.name === 'build' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectInfoPlists(full, output);
    } else if (entry.name === 'Info.plist') {
      output.push(full);
    }
  }
  return output;
}

function patchProject(projectPath, version, buildNumber) {
  const pbxproj = path.join(projectPath, 'project.pbxproj');
  let text;
  try {
    text = readFileSync(pbxproj, 'utf8');
  } catch {
    fail(`读取失败：${pbxproj}`);
  }

  if (!/MARKETING_VERSION = [^;]+;/.test(text)) fail(`${pbxproj} 中找不到 MARKETING_VERSION`);
  if (!/CURRENT_PROJECT_VERSION = [^;]+;/.test(text)) fail(`${pbxproj} 中找不到 CURRENT_PROJECT_VERSION`);

  text = text
    .replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`)
    .replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${buildNumber};`);
  writeFileSync(pbxproj, text);
  return pbxproj;
}

function patchPlist(plistPath, version, buildNumber) {
  let text = readFileSync(plistPath, 'utf8');
  if (!text.includes('<key>CFBundleVersion</key>') && !text.includes('<key>CFBundleShortVersionString</key>')) {
    return false;
  }

  const before = text;
  text = text
    .replace(
      /(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]*(<\/string>)/,
      `$1${version}$2`,
    )
    .replace(
      /(<key>CFBundleVersion<\/key>\s*<string>)[^<]*<\/string>/,
      `$1${buildNumber}</string>`,
    );

  if (text === before) return false;
  writeFileSync(plistPath, text);
  return true;
}

export function setIosVersion({ appRoot, version, buildNumber }) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) fail(`BUILD_VERSION 非法：${version}`);
  if (!/^[1-9]\d*$/.test(buildNumber ?? '')) fail(`BUILD_NUMBER 非法：${buildNumber}`);

  const iosDir = path.join(appRoot, 'ios');
  let entries;
  try {
    entries = readdirSync(iosDir, { withFileTypes: true });
  } catch {
    fail(`找不到 iOS 工程目录：${iosDir}`);
  }

  const projects = entries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('.xcodeproj'))
    .map((entry) => path.join(iosDir, entry.name));
  if (projects.length === 0) fail(`${iosDir} 下没有 .xcodeproj`);

  const patchedProjects = projects.map((project) => patchProject(project, version, buildNumber));
  const plists = collectInfoPlists(iosDir);
  const patchedPlists = plists.filter((plist) => patchPlist(plist, version, buildNumber));
  if (patchedPlists.length === 0) fail('没有找到需要写入版本号的 Info.plist');

  return { patchedProjects, patchedPlists };
}

function main() {
  const appRoot = path.resolve(process.argv[2] ?? 'source/apps/mobile');
  const version = process.env.BUILD_VERSION?.trim();
  const buildNumber = process.env.BUILD_NUMBER?.trim();
  const { patchedProjects, patchedPlists } = setIosVersion({ appRoot, version, buildNumber });

  for (const project of patchedProjects) console.log(`[ios-version] project ${path.relative(appRoot, project)}`);
  for (const plist of patchedPlists) console.log(`[ios-version] plist ${path.relative(appRoot, plist)}`);
  console.log(`[ios-version] MARKETING_VERSION=${version} CURRENT_PROJECT_VERSION=${buildNumber}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`[ios-version] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}