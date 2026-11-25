# mobile-pipeline

移动端发布流水线（GitHub Actions），当前覆盖：

| 平台 | 产物 | 触发 | 商店上传 |
| --- | --- | --- | --- |
| Android | APK（`cn`、`global` 或 `production`） | `mobile-android-release` | 直装 |
| iOS | IPA | `mobile-ios-release` | 可选 TestFlight |

一次运行构建一个目标。构建 job 从运行器直接把签名包上传至源码私库的 GitHub Release。Android 使用独立运行器的 Gradle 缓存，关闭公开仓库的跨运行缓存。
配置 OSS 后，同一签名包还会备份到私有 OSS 前缀。私库 Release 附带 `oss-download.json`，记录对象路径、校验值和通过验证的 7 天签名链接。默认域名拒绝 APK 或 IPA 下载时，通过已绑定的 OSS 自定义 HTTPS 域名启用下载链接。
配置飞书机器人后会发送打包结果卡片。失败或取消时，独立通知工作流会检查原运行，并在通知步骤未成功时补发。

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

也可通过 `repository_dispatch` 触发，旧事件名 `android-apk-release` 与 `ios-release` 仍可识别。派发参数 `upload_private_release` 对应手动运行的 `upload_release`。

### 版本与构建号

- `version` 留空时读取源码 `apps/mobile/app.config.ts`
- `build_number` 留空时，iOS 查询 App Store Connect；Android 使用 `ANDROID_VERSION_CODE_BASE`、运行号和偏移值
- Release tag 按环境和平台生成，并指向实际 checkout 的源码提交

### 后端地址（Android）

流水线不写死业务地址，按以下优先级取值：

1. workflow 输入 `api_base_url` / `www_url` / `studio_url`
2. 仓库变量 `MOBILE_CN_API_BASE_URL` / `MOBILE_GLOBAL_API_BASE_URL` / `MOBILE_WWW_URL` / `MOBILE_STUDIO_URL`
3. 留空则沿用源码 `app.config.ts` 的默认值

`cn` 目标必须能拿到 API 地址（源码通常对国区包有域名校验，地址不匹配会直接构建失败）。

## 需要配置的 Secrets / Variables

| 名称 | 类型 | 用途 |
| --- | --- | --- |
| `RELEASE_SOURCE_REPO` | secret | 私有源码仓库 `owner/repo`，用于 checkout 和发布 |
| `RELEASE_SOURCE_REPO_PAT` | secret | 仅限上述私库的 Contents 读写权限 |
| `MOBILE_APP_FLAVOR` | secret | 源码的 Expo 品牌档案 |
| `ANDROID_PACKAGE_NAME` | secret | Android 签名包标识 |
| `ANDROID_KEYSTORE_BASE64` / `ANDROID_KEYSTORE_PASSWORD` / `ANDROID_KEY_ALIAS` / `ANDROID_KEY_PASSWORD` | secret | 正式 APK 签名材料 |
| `GOOGLE_SERVICES_PROD_JSON_BASE64` | secret | Android 推送配置（可选） |
| `ASC_API_KEY_P8_BASE64` / `ASC_KEY_ID` / `ASC_ISSUER_ID` | secret | iOS 自动构建号和 TestFlight 上传 |
| `IOS_DISTRIBUTION_CERT_BASE64` / `IOS_CERT_PASSWORD` / `IOS_KEYCHAIN_PASSWORD` | secret | iOS 签名证书 |
| `IOS_PROFILE_APP_BASE64` / `IOS_PROFILE_WIDGET_BASE64` | secret | iOS Provisioning Profile |
| `IOS_PROJECT_NAME` / `IOS_SCHEME` / `IOS_APP_TARGET` / `IOS_WIDGET_TARGET` | secret | iOS 工程信息 |
| `IOS_APP_BUNDLE_ID` / `IOS_WIDGET_BUNDLE_ID` / `APPLE_TEAM_ID` | secret | iOS 签名身份 |
| `FEISHU_RELEASE_WEBHOOK_URL` / `FEISHU_RELEASE_WEBHOOK_SECRET` | secret/variable | 构建通知（可选） |
| `MOBILE_ARTIFACT_PREFIX` | secret 或 variable | 产物文件名前缀，默认 `mobile-app` |
| `RELEASE_TAG_PREFIX` | secret 或 variable | Release tag 的可选产品前缀 |
| `SENTRY_AUTH_TOKEN` | secret | 源码映射上传 |
| `ANDROID_VERSION_CODE_BASE` | variable | 自动 versionCode 基数，默认 `0`。首次 Actions 运行从 `1` 开始 |
| `RELEASE_OSS_ENABLED` | secret | 设为 `true` 启用 OSS 私有备份 |
| `RELEASE_OSS_BUCKET` / `RELEASE_OSS_REGION` / `RELEASE_OSS_PREFIX` | secret | 私有桶、地域和独立对象前缀 |
| `RELEASE_OSS_ENDPOINT` | secret | 可选 HTTPS 自定义 OSS 域名；默认使用地域外网 endpoint |
| `OSS_ACCESS_KEY_ID` / `OSS_ACCESS_KEY_SECRET` | secret | 限定备份对象前缀的 RAM 凭据，需要 `oss:PutObject` 和 `oss:GetObject` |
| `OTA_ENV_PREFIX` | variable | OTA 环境变量前缀，如 `APP_`（需与源码 App 约定一致） |
| `OTA_UPDATE_URL` | variable | Expo 更新地址 |
| `OTA_APP_TITLE` / `OTA_APP_ID` | variable | 发布目标 App 标识 |
| `OTA_API_BASE_URL` / `OTA_CN_API_BASE_URL` | variable | 海外 / 国区后端地址 |
| `OTA_WWW_URL` / `OTA_STUDIO_URL` | variable | Web / Studio 地址 |
| `OTA_TARGET_GLOBAL` / `OTA_TARGET_CN` | variable | 源码 App 的 OTA target 名称 |
| `EXPO_TOKEN` | secret | EAS 发布令牌 |

Android 需要完整的正式签名材料。启用 OSS 后，备份对象保持私有，地址按环境、平台、Release tag 和文件摘要区分。签名链接只写入私库的下载清单。
64 MiB 或以上的文件使用分片上传。RAM 凭据具有 `oss:AbortMultipartUpload` 权限时，可自动清理失败的分片任务。

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
