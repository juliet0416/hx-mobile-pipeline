#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RELEASE_SIGNING_BLOCK = [
  '        release {',
  '            def requiredSigningProps = [',
  "                'CI_UPLOAD_STORE_FILE',",
  "                'CI_UPLOAD_STORE_PASSWORD',",
  "                'CI_UPLOAD_KEY_ALIAS',",
  "                'CI_UPLOAD_KEY_PASSWORD'",
  '            ]',
  '            requiredSigningProps.each { propName ->',
  '                if (!project.hasProperty(propName) || project.property(propName).toString().trim().isEmpty()) {',
  '                    throw new GradleException("Missing Android release signing property: ${propName}")',
  '                }',
  '            }',
  "            storeFile file(project.property('CI_UPLOAD_STORE_FILE'))",
  "            storePassword project.property('CI_UPLOAD_STORE_PASSWORD')",
  "            keyAlias project.property('CI_UPLOAD_KEY_ALIAS')",
  "            keyPassword project.property('CI_UPLOAD_KEY_PASSWORD')",
  '        }',
].join('\n');

const DEBUG_BLOCK = [
  '        debug {',
  "            storeFile file('debug.keystore')",
  "            storePassword 'android'",
  "            keyAlias 'androiddebugkey'",
  "            keyPassword 'android'",
  '        }',
].join('\n');

export function configureReleaseSigning(text) {
  if (!text.includes('signingConfigs {')) {
    throw new Error('Cannot find signingConfigs block in build.gradle');
  }

  let next = text;
  if (!next.includes('CI_UPLOAD_STORE_FILE')) {
    if (!next.includes(DEBUG_BLOCK)) {
      throw new Error('Cannot find expected debug signing block in build.gradle');
    }
    next = next.replace(DEBUG_BLOCK, `${DEBUG_BLOCK}\n${RELEASE_SIGNING_BLOCK}`);
  }

  const withRelease = next.replace(/signingConfig signingConfigs\.debug/g, 'signingConfig signingConfigs.release');
  if (withRelease === next && !next.includes('signingConfig signingConfigs.release')) {
    throw new Error('Cannot replace release signingConfig in build.gradle');
  }
  return withRelease;
}

function main() {
  const gradlePath = resolve(process.argv[2] ?? 'source/apps/mobile/android/app/build.gradle');
  const text = readFileSync(gradlePath, 'utf8');
  writeFileSync(gradlePath, configureReleaseSigning(text));
  console.log(`[android-signing] configured release signing in ${gradlePath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`[android-signing] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}