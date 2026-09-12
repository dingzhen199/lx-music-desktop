import path from 'node:path'
import { defineConfig } from 'vitest/config'

// 与 build-config/*/webpack.config.base.js 的 resolve.alias 对齐，
// 使含 @common/@main/@renderer 运行时导入的模块可在 vitest 中直接单测。
export default defineConfig({
  resolve: {
    alias: {
      '@main': path.join(__dirname, 'src/main'),
      '@renderer': path.join(__dirname, 'src/renderer'),
      '@lyric': path.join(__dirname, 'src/renderer-lyric'),
      '@common': path.join(__dirname, 'src/common'),
    },
  },
})
