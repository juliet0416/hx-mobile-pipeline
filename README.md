# mobile-pipeline

移动端发布流水线（GitHub Actions），当前覆盖：

| 平台 | 产物 | 触发 | 商店上传 |
| --- | --- | --- | --- |
| Android | APK（`cn` / `global` 二选一） | `android-apk-release` | 无（不接 Google Play） |
| iOS | IPA | `ios-release` | 可选 TestFlight |

一次运行只构建一个目标；产物默认发布到本仓库的 GitHub Release，并保留 Actions Artifact。
EAS OTA 发布使用 `mobile-ota-update.yml`（配置见下）。

## 目录

```
.github/workflows/mobile-android-apk.yml   Android APK
.github/workflows/mobile-ios-release.yml   iOS IPA
.github/actions/prepare-mobile/            锁定依赖安装 + 原生预编译包校验
scripts/                                   解析输入、写版本、签名、发布、通知
```

## 使用

```bash
# Android：cn 或 global 二选一
gh workflow run mobile-android-apk.yml \
  -f ref=<source-ref> -f target=cn \
  -f api_base_url=https://api.example.cn

# iOS
gh workflow run mobile-ios-release.yml -f ref=<source-ref>
```

也可通过 `repository_dispatch` 触发（事件名同上），payload 字段与 workflow 输入同名。

### 版本与构建号

- `version` 留空时读取源码 `apps/mobile/app.config.ts`
- `build_number` 留空时按 epoch 分钟单调生成；同一分钟重复构建需显式传值或 offset
- iOS 与 Android 的 release tag 带平台前缀（`android-v…` / `ios-v…`），互不覆盖

### 后端地址（Android）

流水线不写死业务地址，按以下优先级取值：

1. workflow 输入 `api_base_url` / `www_url` / `studio_url`
2. 仓库变量 `MOBILE_CN_API_BASE_URL` / `MOBILE_GLOBAL_API_BASE_URL` / `MOBILE_WWW_URL` / `MOBILE_STUDIO_URL`
3. 留空则沿用源码 `app.config.ts` 的默认值

`cn` 目标必须能拿到 API 地址（源码通常对国区包有域名校验，地址不匹配会直接构建失败）。

## 需要配置的 Secrets / Variables

| 名称 | 类型 | 用途 |
| --- | --- | --- |
| `SOURCE_REPO` | variable/secret | 源码仓库 `owner/repo` |
| `SOURCE_REPO_PAT` | secret | 读取源码仓库 |
| `ANDROID_KEYSTORE_BASE64` 等 | secret | 正式 APK 签名；未配置时使用一次性临时签名 |
| `GOOGLE_SERVICES_PROD_JSON_BASE64` | secret | Android 推送配置（可选） |
| `ASC_API_KEY_P8_BASE64` / `ASC_KEY_ID` / `ASC_ISSUER_ID` | secret | iOS TestFlight 上传 |
| `IOS_DISTRIBUTION_CERT_BASE64` / `IOS_CERT_PASSWORD` / `IOS_KEYCHAIN_PASSWORD` | secret | iOS 签名证书 |
| `IOS_PROFILE_APP_BASE64` / `IOS_PROFILE_WIDGET_BASE64` | secret | iOS Provisioning Profile |
| `IOS_PROJECT_NAME` / `IOS_SCHEME` / `IOS_APP_TARGET` / `IOS_WIDGET_TARGET` | secret | iOS 工程信息 |
| `IOS_APP_BUNDLE_ID` / `IOS_WIDGET_BUNDLE_ID` / `APPLE_TEAM_ID` | secret | iOS 签名身份 |
| `FEISHU_RELEASE_WEBHOOK_URL` / `FEISHU_RELEASE_WEBHOOK_SECRET` | secret/variable | 构建通知（可选） |
| `MOBILE_ARTIFACT_PREFIX` | variable | 产物文件名前缀，默认 `mobile-app` |
| `RELEASE_TAG_PREFIX` | variable | Release tag 前缀，默认取平台名 |
| `OTA_ENV_PREFIX` | variable | OTA 环境变量前缀，如 `APP_`（需与源码 App 约定一致） |
| `OTA_UPDATE_URL` | variable | Expo 更新地址 |
| `OTA_APP_TITLE` / `OTA_APP_ID` | variable | 发布目标 App 标识 |
| `OTA_API_BASE_URL` / `OTA_CN_API_BASE_URL` | variable | 海外 / 国区后端地址 |
| `OTA_WWW_URL` / `OTA_STUDIO_URL` | variable | Web / Studio 地址 |
| `OTA_TARGET_GLOBAL` / `OTA_TARGET_CN` | variable | 源码 App 的 OTA target 名称 |
| `EXPO_TOKEN` | secret | EAS 发布令牌 |

Android 未配置正式 keystore 时会生成仅本次运行有效的临时 keystore：能安装、能互相覆盖，
但跨运行升级需要卸载重装。正式分发前请配置 `ANDROID_KEYSTORE_*`。

## 本地校验

```bash
node --test "scripts/**/*.test.mjs"
```

## OTA

`mobile-ota-update.yml` 按 Expo fingerprint 校验母包兼容性后再发布补丁，支持
`prod` / `cn-prod` 两个渠道和 `ios` / `android`。发布前需要：

1. 目标安装包的 Release 里带同名 `.ota.json` 构建记录（由构建阶段落盘）；
2. 上述 `OTA_*` 变量与母包构建时完全一致；
3. `EXPO_TOKEN`，以及 Expo 项目已绑定到源码仓库。

构建阶段写入 `.ota.json` 的步骤尚未接入，接入自定义 OTA 时再补。
