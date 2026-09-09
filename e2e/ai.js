/**
 * T-B1 AI 通道 e2e：mock LLM 服务器 + 设置 AI（baseUrl/key/model/开关）→ 播放歌曲 → 探索会话。
 * 期望：会话状态显示“AI 计划”，且 mock 服务收到 analysis + ranking 各至少一次。
 * 用法: node e2e/ai.js
 */
const { launchApp, collectErrors, screenshot, ART_DIR } = require('./harness')
const { startMockLlm } = require('./mockLlm')
const { clickPathRowAndVerify, dismissOverlayModal } = require('./pathProbe')
const fs = require('fs')

async function agree(window) {
  const btn = window.locator('button').filter({ hasText: /^接受/ }).first()
  const found = await btn.waitFor({ timeout: 6000 }).then(() => true).catch(() => false)
  if (!found) return
  for (let i = 0; i < 25; i++) {
    const text = await btn.textContent()
    if (!/\d/.test(text)) break
    await window.waitForTimeout(1000)
  }
  await btn.click()
  await window.waitForTimeout(2000)
  const okBtn = window.locator('button').filter({ hasText: '好的 (OK)' }).first()
  if (await okBtn.isVisible().catch(() => false)) {
    await okBtn.click()
    await window.waitForTimeout(1000)
  }
}

async function nav(window, hash) {
  await window.evaluate(h => { window.location.hash = h }, hash)
  await window.waitForTimeout(800)
}

;(async() => {
  fs.mkdirSync(ART_DIR, { recursive: true })
  const mock = await startMockLlm({
    failRankTimes: Number(process.env.E2E_MOCK_FAIL_RANK_TIMES || 0),
    emptyContentTimes: Number(process.env.E2E_MOCK_EMPTY_CONTENT_TIMES || 0),
  })
  const results = []
  const record = (name, ok, detail = '') => {
    results.push({ name, ok, detail })
    console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`)
  }

  const { app, window } = await launchApp()
  const errors = collectErrors(window)
  const warns = []
  window.on('console', m => {
    if (m.type() === 'warning' || m.type() === 'error') warns.push(`[${m.type()}] ${m.text()}`)
  })
  await window.waitForTimeout(2500)
  await agree(window)

  // ---------- 设置 AI ----------
  {
    await nav(window, '#/setting')
    await window.waitForTimeout(1000)
    await window.getByText('AI 推荐').first().click()
    await window.waitForTimeout(800)
    await window.getByPlaceholder('如 https://api.openai.com/v1 或 https://api.anthropic.com/v1').fill(mock.baseUrl)
    await window.getByPlaceholder('仅保存在本机，请勿分享').fill('test-key')
    await window.getByPlaceholder('如 gpt-4o-mini、claude-3-5-haiku-latest').fill('mock-model')
    await window.waitForTimeout(1200)
    // 打开“启用 AI 分析与排序”
    await window.locator('label[for="setting_ai_enable"]').click()
    await window.waitForTimeout(800)
    record('AI-设置已填写并开启', true, `baseUrl=${mock.baseUrl}`)

    // 测试连接按钮
    const probeCountBefore = mock.requests.length
    await window.getByRole('button', { name: '测试连接' }).click()
    await window.waitForTimeout(4000)
    const testText = await window.evaluate(() => document.body.innerText)
    record('AI-测试连接按钮-成功提示', /连接成功/.test(testText))
    const probeDone = mock.requests.length > probeCountBefore
    record('AI-测试连接请求已发出', probeDone)
  }

  // ---------- 搜索并播放 ----------
  await nav(window, '#/search')
  await window.waitForTimeout(800)
  const input = window.getByPlaceholder('Search for something...').first()
  await input.fill('周杰伦')
  await input.press('Enter')
  await window.waitForTimeout(9000)
  const row = window.locator('.list-item').first()
  const rowVisible = await row.isVisible().catch(() => false)
  record('AI-搜索结果可用', rowVisible)
  if (rowVisible) {
    await window.keyboard.press('Escape')
    await window.waitForTimeout(500)
    await dismissOverlayModal(window)
    let played = false
    for (let idx = 0; idx < 3; idx++) {
      const r = window.locator('.list-item').nth(idx)
      if (!(await r.isVisible().catch(() => false))) break
      await r.dblclick({ position: { x: 250, y: 10 } })
      await window.waitForTimeout(6000)
      if (await window.locator('[aria-label="暂停"]').isVisible().catch(() => false)) { played = true; break }
    }
    record('AI-歌曲播放中', played)
  }

  // ---------- 探索会话（AI 通道） ----------
  const exploreBtn = window.locator('[aria-label="从此歌出发"]')
  const enabled = !(await exploreBtn.isDisabled().catch(() => true))
  record('AI-探索按钮可用', enabled)
  if (enabled) {
    await exploreBtn.click()
    await window.waitForTimeout(1000)
    await window.getByText('你在这里').first().waitFor({ timeout: 15000 }).catch(() => {})
    await window.getByText(/AI 计划|本地计划|这次计划没有完成|自动续补失败/).first().waitFor({ timeout: 60000 }).catch(() => {})
    const body = await window.evaluate(() => document.body.innerText)
    console.log('探索页状态片段:', JSON.stringify(body.match(/你在这里|AI 计划|本地计划|队列剩余 \d+ 首|这次计划没有完成|自动续补失败/g)))
    record('AI-会话显示AI计划', /AI 计划/.test(body))
    record('AI-队列已入队', /队列剩余/.test(body))
    record('AI-路径含mock原因', /mock-reason/.test(body))
    await screenshot(window, 'ai_session')

    // AI 开启 + 会话内路径点击跳播（用户反复反馈的重现场景：点击“具体的歌”应切换音频，而非继续播锚点歌）
    {
      const r = await clickPathRowAndVerify(window)
      record('AI-路径点击跳播', r.matched, r.detail)
    }
  }

  // ---------- mock 服务断言 ----------
  const analysis = mock.requests.filter(r => !r.system.includes('Listening Judgment'))
  const ranking = mock.requests.filter(r => r.system.includes('Listening Judgment'))
  record('AI-mock收到分析请求', analysis.length >= 1, `count=${analysis.length}`)
  const expectRankCount = Number(process.env.E2E_MOCK_FAIL_RANK_TIMES || 0) + 1
  record('AI-mock收到排序请求', ranking.length >= expectRankCount, `count=${ranking.length}, expected>=${expectRankCount}`)

  record('AI-无渲染错误', errors.length === 0, errors.slice(0, 3).join('\n'))
  console.log('===== warn/error 日志 =====')
  warns.slice(0, 20).forEach(w => console.log(w))

  await app.close()
  await mock.close()
  const fails = results.filter(r => !r.ok)
  console.log(`\n===== 汇总: PASS ${results.length - fails.length}/${results.length} =====`)
  process.exit(fails.length ? 1 : 0)
})().catch(e => { console.error('AI E2E CRASHED:', e); process.exit(2) })
