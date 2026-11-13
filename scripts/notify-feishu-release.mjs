#!/usr/bin/env node

/**
 * 发布流水线的飞书通知（Android / iOS 共用）。
 * 未配置 FEISHU_RELEASE_WEBHOOK_URL 时静默跳过。
 */

import { createHmac } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SUCCESS_RESULTS = new Set(['success', 'skipped']);
const PLATFORM_LABEL = { android: 'Android APK', ios: 'iOS IPA' };
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
    text: { tag: 'lark_md', content: `**${label}**\n${value}` },
  };
}

function assetUrl({ repo, tag, fileName }) {
  if (!repo || !tag || !fileName) return '';
  return `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(fileName)}`;
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '';
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function buildCard(input) {
  const platform = input.platform ?? 'android';
  const label = PLATFORM_LABEL[platform] ?? platform;
  const status = input.status ?? 'failure';
  const targets = input.targets?.length ? input.targets.join(', ') : '—';
  const version = input.version ? `v${input.version}` : '—';

  const elements = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**${label}**${input.releaseEnv ? ` · release_env \`${input.releaseEnv}\`` : ''}`,
      },
    },
    {
      tag: 'div',
      fields: [
        field('源码', `${input.sourceRepo ?? '—'}\n\`${input.ref ?? '—'}\``),
        field('目标', targets),
        field('版本', `${version}\nbuild \`${input.buildNumber ?? '—'}\``),
      ],
    },
  ];

  const summaries = input.summaries ?? [];
  if (summaries.length > 0) {
    const lines = summaries.map((summary) => {
      const url = input.uploaded
        ? (summary.downloadUrl ?? assetUrl({ repo: input.repo, tag: input.tag, fileName: summary.artifactName }))
        : '';
      const meta = [summary.artifactName, summary.sizeBytes ? formatBytes(summary.sizeBytes) : '']
        .filter(Boolean)
        .join(' · ');
      return url ? `- [${summary.target}](${url}) · ${meta}` : `- ${summary.target} · ${meta}（未生成下载链接）`;
    });
    elements.push({ tag: 'hr' }, { tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } });
  }

  if (input.signingMode === 'temp') {
    elements.push({
      tag: 'note',
      elements: [{ tag: 'lark_md', content: '⚠️ 本次使用临时签名，仅用于安装验证；正式分发前需配置签名 secrets。' }],
    });
  }

  if (input.releaseUrl) {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `[发布页](${input.releaseUrl})${input.runUrl ? ` · [流水线](${input.runUrl})` : ''}`,
      },
    });
  } else if (input.runUrl) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: `[流水线](${input.runUrl})` } });
  }

  return {
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true },
      header: {
        template: STATUS_TEMPLATE[status] ?? 'red',
        title: { tag: 'plain_text', content: `${label} 构建${STATUS_TEXT[status] ?? '未知'}` },
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
  });
  const text = await response.text().catch(() => '');
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  const code = parsed?.code ?? parsed?.StatusCode;
  const ok = response.ok && (code === undefined || code === 0);
  if (!ok) warn(`[feishu] webhook returned ${response.status}: ${text}`);
  return { ok, status: response.status, text };
}

async function main() {
  const webhookUrl = process.env.FEISHU_RELEASE_WEBHOOK_URL?.trim();
  if (!webhookUrl) {
    console.log('[feishu] skipped: FEISHU_RELEASE_WEBHOOK_URL is not configured');
    return;
  }

  const platform = process.env.RELEASE_PLATFORM?.trim() || 'android';
  const status = resolveOverallStatus([process.env.PREPARE_RESULT, process.env.BUILD_RESULT]);
  const summaries = readReleaseSummaries(process.env.RELEASE_SUMMARIES_DIR);
  const version = process.env.RELEASE_VERSION?.trim() || summaries[0]?.version || '';
  const buildNumber = process.env.RELEASE_BUILD_NUMBER?.trim() || summaries[0]?.buildNumber || '';

  const payload = buildCard({
    uploaded: process.env.RELEASE_UPLOADED === 'true',
    platform,
    buildNumber,
    ref: process.env.RELEASE_REF,
    releaseEnv: process.env.RELEASE_RELEASE_ENV,
    releaseUrl: process.env.RELEASE_URL,
    repo: process.env.RELEASE_PIPELINE_REPO,
    runUrl: process.env.RELEASE_RUN_URL,
    signingMode: process.env.RELEASE_SIGNING_MODE,
    sourceRepo: process.env.RELEASE_SOURCE_REPO,
    status,
    summaries,
    tag: process.env.RELEASE_TAG,
    targets: (process.env.RELEASE_TARGETS ?? '').split(',').map((item) => item.trim()).filter(Boolean),
    version,
  });

  const result = await sendFeishuNotification({
    payload,
    secret: process.env.FEISHU_RELEASE_WEBHOOK_SECRET,
    webhookUrl,
  });
  console.log(`[feishu] status=${result.status}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}