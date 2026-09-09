/**
 * e2e 冒烟：启动应用，等待主窗口稳定，输出页面文本与错误采集结果。
 * 用法: node e2e/smoke.js
 */
const { launchApp, collectErrors, screenshot } = require('./harness')

;(async() => {
  const { app, window } = await launchApp()
  const errors = collectErrors(window)
  await window.waitForTimeout(8000)
  const text = await window.evaluate(() => document.body.innerText.slice(0, 3000))
  const url = window.url()
  console.log('=== URL:', url)
  console.log('=== BODY TEXT ===')
  console.log(text)
  console.log('=== ERRORS (' + errors.length + ') ===')
  errors.slice(0, 30).forEach(e => console.log(e))
  await screenshot(window, 'smoke')
  await app.close()
  process.exit(0)
})().catch(err => {
  console.error('SMOKE FAILED:', err)
  process.exit(1)
})
