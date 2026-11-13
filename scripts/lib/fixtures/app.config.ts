// 仅用于单测的最小化 app.config.ts 片段，结构对齐真实 App。
const runtimeVersion = { policy: 'fingerprint' };

const config: ExpoConfig = {
  name: 'Example App',
  slug: 'example-mobile',
  version: '1.5.4',
  orientation: 'default',
  android: {
    package: 'com.example.mobile',
  },
};

export default config;