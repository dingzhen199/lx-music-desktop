import path from 'node:path'
import { defineConfig } from 'vitest/config'

// 平台相似推荐真实联调冒烟专用配置（手动执行，不参与 npm test）：
//   npx vitest run --config vitest.smoke.config.ts
// 仅匹配 e2e/**/*.smoke.ts（正常 vitest.config.ts 的 include 模式不含它们，
// webpack 也不编译 e2e/），驱动真实 musicSdk 适配器与线上端点
// （docs/platform-similar-recommendation-p0.md）。
export default defineConfig({
  resolve: {
    alias: {
      '@main': path.join(__dirname, 'src/main'),
      '@renderer': path.join(__dirname, 'src/renderer'),
      '@lyric': path.join(__dirname, 'src/renderer-lyric'),
      '@common': path.join(__dirname, 'src/common'),
    },
  },
  test: {
    include: ['e2e/**/*.smoke.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
})
