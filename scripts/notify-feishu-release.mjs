#!/usr/bin/env node

/**
 * 发布流水线的飞书通知（Android / iOS 共用）。
 * 未配置 FEISHU_RELEASE_WEBHOOK_URL 时静默跳过。
 */

import { createHmac } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReleaseTag, privateReleasePrefix } from './lib/release.mjs';

const SUCCESS_RESULTS = new Set(['success', 'skipped']);
const PLATFORM_LABEL = { android: 'Android', ios: 'iOS' };
const WORKFLOW_PLATFORM = {
  '.github/workflows/mobile-android-apk.yml': 'android',
  '.github/workflows/mobile-ios-release.yml': 'ios',
};
const ENVIRONMENT_LABEL = { test: '测试环境', production: '正式环境' };
const STATUS_TEXT = { success: '成功', cancelled: '已取消', failure: '失败' };
const STATUS_TEMPLATE = { success: 'green', cancelled: 'grey', failure: 'red' };

export function resolveOverallStatus(jobResults) {
  const results = jobResults.map((result) => String(result ?? '').toLowerCase());
  if (results.some((result) => !SUCCESS_RESULTS.has(result) && result !== 'cancelled')) {
    return 'failure';
  }
  return results.includes('cancelled') ? 'cancelled' : 'success';
}

export function readReleaseSummaries(dir) {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => JSON.parse(readFileSync(path.join(dir, file), 'utf8')));
}

export function buildSignedBody(payload, options = {}) {
  if (!options.secret) return payload;
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const sign = createHmac('sha256', `${timestamp}\n${options.secret}`).update('').digest('base64');
  return { timestamp, sign, ...payload };
}

function field(label, value) {
  return {
    is_short: true,
    text: { tag: 'lark_md', content: `**${label}**\n${value || '—'}` },
  };
}

function link(label, url) {
  return url ? `[${label}](${url})` : label;
}

function assetUrl({ repo, tag, fileName }) {
  if (!repo || !tag || !fileName) return '';
  return `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(fileName)}`;
}

export function buildCard(input) {
  const platform = input.platform ?? 'android';
  const label = PLATFORM_LABEL[platform] ?? platform;
  const status = input.status ?? 'failure';
  const environment = ENVIRONMENT_LABEL[input.releaseEnv];
  const version = input.version ? `v${input.version}` : '';
  const sourceUrl = input.sourceRepo && input.ref
    ? `https://github.com/${input.sourceRepo}/tree/${encodeURIComponent(input.ref)}`
    : '';
  const fields = [
    field('平台', label),
    field('数据环境', environment),
    field('源码 ref', link(input.ref, sourceUrl)),
    field('版本', version),
    field('构建号', input.buildNumber),
    field('发布目标', input.targets?.join(', ')),
  ];
  if (platform === 'ios' && typeof input.submitToStore === 'boolean') {
    fields.push(field('提交 TestFlight', input.submitToStore ? '是' : '否'));
  }
  if (status === 'failure' && input.failureStage) fields.push(field('失败阶段', input.failureStage));

  const artifacts = (input.summaries ?? []).filter((item) => item.artifactName).map((item) => {
    const url = input.uploaded && (item.downloadUrl || assetUrl({ repo: input.repo, tag: input.tag, fileName: item.artifactName }));
    return link(item.artifactName, url);
  });
  if (artifacts.length > 0) {
    fields.push(field('产物', artifacts.join('\n')));
  } else if (input.releaseUrl) {
    fields.push(field('产物', link('查看私库 Release', input.releaseUrl)));
  }
  if (input.runUrl) fields.push(field('Actions', link(input.runNumber ? `#${input.runNumber}` : '查看运行', input.runUrl)));

  const summary = [input.ref, environment, version, input.buildNumber && `构建 ${input.buildNumber}`]
    .filter(Boolean).join(' · ');
  const elements = summary ? [
    { tag: 'div', text: { tag: 'lark_md', content: summary } },
    { tag: 'hr' },
  ] : [];
  elements.push({ tag: 'div', fields });

  if (input.signingMode === 'temp') {
    elements.push({
      tag: 'note',
      elements: [{ tag: 'lark_md', content: '⚠️ 本次使用临时签名，仅用于安装验证；正式分发前需配置签名 secrets。' }],
    });
  }

  return {
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true },
      header: {
        template: STATUS_TEMPLATE[status] ?? 'red',
        title: { tag: 'plain_text', content: `${label} 打包${STATUS_TEXT[status] ?? '未知'}` },
      },
      elements,
    },
  };
}

export async function sendFeishuNotification({ fetchImpl = fetch, payload, secret, webhookUrl, warn = console.warn }) {
  const body = buildSignedBody(payload, { secret });
  const response = await fetchImpl(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text().catch(() => '');
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  const code = parsed?.code ?? parsed?.StatusCode;
  const ok = response.ok && code === 0;
  if (!ok) warn(`[feishu] webhook returned HTTP ${response.status}, code=${code ?? 'missing'}`);
  return { ok, status: response.status, text };
}

//#region 独立的失败和取消通知

export function buildFallbackInput(run, jobs, sourceRepo) {
  const platform = WORKFLOW_PLATFORM[run.path];
  if (!platform || jobs.some((job) => job.name === 'notify' && job.steps?.some((step) =>
    step.name === 'Notify Feishu release bot' && step.conclusion === 'success'))) return null;

  const [title, releaseEnv, target, store] = (run.display_title ?? '').split(' · ');
  const ref = /^(?:Android APK|iOS IPA) ([A-Za-z0-9][A-Za-z0-9._/-]*)$/.exec(title)?.[1];
  const failedJob = jobs.find((job) => job.name !== 'notify' && job.conclusion === 'failure');
  const failedStep = failedJob?.steps?.find((step) => step.conclusion === 'failure');
  const build = jobs.find((job) => job.name === 'build');
  const status = build?.conclusion === 'success' && !failedJob && run.conclusion !== 'cancelled'
    ? 'success'
    : resolveOverallStatus([run.conclusion, ...jobs.filter((job) => job.name !== 'notify').map((job) => job.conclusion)]);
  return {
    platform, status, sourceRepo, ref, releaseEnv,
    targets: target ? [target] : [],
    version: /-v(\d+\.\d+\.\d+)$/.exec(ref)?.[1],
    submitToStore: platform === 'ios' && store ? store === 'TestFlight' : undefined,
    failureStage: failedStep?.name || failedJob?.name,
    runNumber: run.run_number,
    runUrl: run.html_url,
  };
}

async function loadFallbackInput(env) {
  const run = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')).workflow_run;
  if (!run || !WORKFLOW_PLATFORM[run.path]) return null;
  const url = `${env.GITHUB_API_URL}/repos/${env.GITHUB_REPOSITORY}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`;
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${env.GH_TOKEN}`,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Failed to read Actions jobs (HTTP ${response.status})`);
  return buildFallbackInput(run, (await response.json()).jobs, env.RELEASE_SOURCE_REPO);
}

//#endregion

async function main() {
  const webhookUrl = process.env.FEISHU_RELEASE_WEBHOOK_URL?.trim();
  if (!webhookUrl) {
    console.log('[feishu] skipped: FEISHU_RELEASE_WEBHOOK_URL is not configured');
    return;
  }
  const secret = process.env.FEISHU_RELEASE_WEBHOOK_SECRET;
  if (process.env.GITHUB_EVENT_NAME === 'workflow_run') {
    const fallback = await loadFallbackInput(process.env);
    if (!fallback) {
      console.log('[feishu] no fallback notification needed');
      return;
    }
    const result = await sendFeishuNotification({ payload: buildCard(fallback), secret, webhookUrl });
    if (!result.ok) throw new Error('Feishu fallback notification failed');
    return;
  }

  const platform = process.env.RELEASE_PLATFORM?.trim() || 'android';
  const status = resolveOverallStatus([process.env.PREPARE_RESULT, process.env.BUILD_RESULT]);
  const summaries = readReleaseSummaries(process.env.RELEASE_SUMMARIES_DIR);
  const version = process.env.RELEASE_VERSION?.trim() || summaries[0]?.version || '';
  const buildNumber = process.env.RELEASE_BUILD_NUMBER?.trim() || summaries[0]?.buildNumber || '';
  const uploaded = process.env.RELEASE_UPLOADED === 'true';
  const repo = process.env.RELEASE_SOURCE_REPO;
  const releaseEnv = process.env.RELEASE_RELEASE_ENV;
  const tag = uploaded ? buildReleaseTag({
    prefix: privateReleasePrefix({ tagPrefix: process.env.RELEASE_TAG_PREFIX, releaseEnv, platform }),
    platform,
    version,
    buildNumber,
  }) : '';

  const payload = buildCard({
    uploaded,
    platform,
    buildNumber,
    ref: process.env.RELEASE_REF,
    releaseEnv,
    releaseUrl: tag && repo ? `https://github.com/${repo}/releases/tag/${tag}` : '',
    repo,
    runNumber: process.env.GITHUB_RUN_NUMBER,
    runUrl: process.env.RELEASE_RUN_URL,
    signingMode: process.env.RELEASE_SIGNING_MODE,
    sourceRepo: process.env.RELEASE_SOURCE_REPO,
    status,
    summaries,
    tag,
    targets: (process.env.RELEASE_TARGETS ?? '').split(',').map((item) => item.trim()).filter(Boolean),
    submitToStore: process.env.RELEASE_SUBMIT_TO_STORE === undefined ? undefined : process.env.RELEASE_SUBMIT_TO_STORE === 'true',
    failureStage: process.env.PREPARE_RESULT === 'failure' ? '准备发布' : '构建或上传',
    version,
  });

  const result = await sendFeishuNotification({
    payload,
    secret,
    webhookUrl,
  });
  if (!result.ok) throw new Error('Feishu notification failed');
  console.log(`[feishu] status=${result.status}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
