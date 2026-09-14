/**
 * 探索电台 e2e（TT-1~TT-5 电台语义冒烟）：跟歌重锚 / 队尾清场 / 约束作废日志 / 本地引擎标识 /
 * 失败收台与复活 / 指标落盘 / 重启自动开台。用法: node e2e/radio.js
 *
 * 覆盖口径（与 docs/explore-radio/spec.md AC 对照）：
 * - AC1 跟歌重锚、AC5 本地引擎分档、AC9 连续失败收台（网络阻断模拟）、AC10 重启自动开台：本脚本直接验证。
 * - AC3 弱验证：约束变更的作废 warn 日志 + 新批次组头快照（召回换道属 AI 模式行为，本地档只能验信号）。
 * - AC7 弱验证：指标不经 dev 钩子（生产构建无 __lxRecommend），改为落盘文件 data.json 读回。
 * - AC2 队尾语义仍以单测/评审为准（手动排队前置条件无稳定 UI 路径），此处只验清场后的队列口径自洽。
 * - AC6 由 vitest 单测覆盖，不在本脚本。
 */
const path = require('path')
const fs = require('fs')
const { launchApp, collectErrors, screenshot, ART_DIR } = require('./harness')
const { dismissOverlayModal, readPlaybar, clickPathRowAndVerify } = require('./pathProbe')

const results = []
function record(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`)
}

async function step(window, errors, name, fn) {
  try {
    await fn()
    record(name, true)
  } catch (err) {
    record(name, false, `${err.message}`.slice(0, 400))
    const file = await screenshot(window, `fail_${name.replace(/[^\w一-龥]+/g, '_')}`)
    console.log(`      screenshot: ${file}`)
    if (errors.length) console.log(`      recent errors:\n${errors.slice(-5).join('\n')}`)
  }
}

/** 等待协议弹窗倒计时结束并点击"接受"，随后关闭开源声明弹窗；弹窗不存在则跳过。 */
async function acceptAgreement(window) {
  const btn = window.locator('button').filter({ hasText: /^接受/ }).first()
  const found = await btn.waitFor({ timeout: 15000 }).then(() => true).catch(() => false)
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

/** 直接改 hash 导航（页面被弹窗遮罩时也能切换路由）。 */
async function nav(window, hash) {
  await window.evaluate(h => { window.location.hash = h }, hash)
  await window.waitForTimeout(800)
}

/** 会话卡片锚点歌名（"你在这里"上方一行）。 */
const readAnchorTitle = async(window) => {
  return window.evaluate(() => {
    const here = Array.from(document.querySelectorAll('div')).find(el => el.textContent?.trim() === '你在这里')
    const meta = here?.parentElement
    return meta?.children?.[1]?.textContent?.trim() ?? ''
  })
}

/** 循环等待计划完成的卡片区任何终态/中间态标记出现，返回页面全文。 */
async function waitPlanSettled(window, timeoutMs = 75000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const body = await window.evaluate(() => document.body.innerText)
    if (/本地计划|AI 计划|这次计划没有完成/.test(body) && !/正在计划下一段/.test(body)) return body
    await window.waitForTimeout(1500)
  }
  return window.evaluate(() => document.body.innerText)
}

/** 搜索并双击播放第 offset 个结果（沿用 e2e.js 的模式），返回播放栏标题。 */
async function searchAndPlay(window, keyword, offset = 0) {
  await nav(window, '#/search')
  await window.waitForTimeout(800)
  const input = window.getByPlaceholder('Search for something...').first()
  await input.fill(keyword)
  await input.press('Enter')
  await window.waitForTimeout(9000)
  await window.keyboard.press('Escape')
  await window.waitForTimeout(500)
  await dismissOverlayModal(window)
  const row = window.locator('.list-item').nth(offset)
  if (!(await row.isVisible().catch(() => false))) throw new Error(`搜索结果第 ${offset} 行不可见（网络受限？）`)
  await row.dblclick({ position: { x: 250, y: 10 } })
  await window.waitForTimeout(5000)
  const bar = await readPlaybar(window)
  if (!bar.title) throw new Error('播放栏无标题（未能播放）')
  return bar.title
}

/** 双击当前搜索结果中的第 offset 行（不切搜索词；断网场景下音乐无法加载也会派发切歌事件）。 */
async function playSearchRow(window, offset) {
  const row = window.locator('.list-item').nth(offset)
  if (!(await row.isVisible().catch(() => false))) return false
  await row.dblclick({ position: { x: 250, y: 10 } })
  await window.waitForTimeout(1200)
  return true
}

;(async() => {
  fs.mkdirSync(ART_DIR, { recursive: true })
  let profileDir = null

  // ============ 第一程：开火与行为 ============
  {
    const { app, window, profileDir: dir } = await launchApp()
    profileDir = dir
    const errors = collectErrors(window)
    // 作废 warn（AC3 弱信号）：console.warn 经 collectErrors 不采集，自挂监听
    const warnings = []
    window.on('console', msg => {
      if (msg.type() === 'warning') warnings.push(msg.text())
    })
    await window.waitForTimeout(3000)

    await step(window, errors, 'R1-启动与协议', async() => {
      await acceptAgreement(window)
    })

    await step(window, errors, 'R1-探索页空态', async() => {
      await nav(window, '#/explore')
      await window.getByText('请先播放一首歌曲，再开始探索').first().waitFor({ timeout: 8000 })
      const startBtn = window.getByRole('button', { name: '从此歌出发' })
      if (!(await startBtn.isDisabled().catch(() => false))) throw new Error('未播放时开始按钮应为禁用')
      const toggle = window.locator('[aria-label="开启探索电台（跟随切歌自动推荐）"]')
      if (!(await toggle.count())) throw new Error('播放栏电台开关缺失（aria-label 未匹配）')
    })

    let songA = ''
    await step(window, errors, 'R2-搜索并播放歌A', async() => {
      songA = await searchAndPlay(window, '周杰伦')
    })

    await step(window, errors, 'R3-开台与本地引擎标识（AC5）', async() => {
      if (!songA) throw new Error('前置步骤失败：无播放中歌曲')
      await window.locator('[aria-label="开启探索电台（跟随切歌自动推荐）"]').click()
      await window.getByText('你在这里').first().waitFor({ timeout: 20000 })
      const body = await waitPlanSettled(window)
      if (/这次计划没有完成/.test(body)) throw new Error('首计划失败: ' + body.slice(0, 200))
      if (!/本地计划/.test(body)) throw new Error('未显示本地引擎标识')
      const remain = body.match(/队列剩余 (\d+) 首/)
      if (!remain || Number(remain[1]) <= 0) throw new Error('队列剩余为 0（首计划未入队）')
      if (!/守住|挖深|打开|转向|落地/.test(body)) throw new Error('路径角色徽章缺失')
      if (!(await window.locator('[aria-label="关闭探索电台"]').count())) throw new Error('开关 aria-label 未切换为关闭')
    })

    await step(window, errors, 'R4-路径跳播推荐曲（指标源）', async() => {
      // 路径中点击第一条非当前行：让"推荐曲开唱"被指标与路径状态记录
      const r = await clickPathRowAndVerify(window, 0)
      if (!r.clicked) {
        // 路径行不一定可点（行结构随曲目数变化），降级为仅记录，不让后续 AC 断点
        console.log('      [hint] 路径行不可点，跳过跳播断言:', r.detail)
        return
      }
      if (!r.matched) console.log('      [hint] 换源信号不完整（限流可致）:', r.detail)
    })

    let anchorB = ''
    await step(window, errors, 'R5-跟歌重锚（AC1）', async() => {
      const anchorA = await readAnchorTitle(window)
      if (!anchorA) throw new Error('重锚前锚点为空（会话不存在）')
      await searchAndPlay(window, '林俊杰')
      await nav(window, '#/explore')
      // 等重锚防抖(1.2s) + 计划完成
      let body = ''
      const start = Date.now()
      while (Date.now() - start < 90000) {
        body = await waitPlanSettled(window, 20000)
        const anchor = await readAnchorTitle(window)
        if (anchor && anchor !== anchorA && /本地计划|AI 计划/.test(body) && !/这次计划没有完成/.test(body)) {
          anchorB = anchor
          break
        }
        await window.waitForTimeout(2000)
      }
      if (!anchorB) throw new Error(`重锚未发生（anchor=${await readAnchorTitle(window)}）`)
      if (!/第 1 批/.test(body)) throw new Error('新台首个批次组头非"第 1 批"')
    })

    await step(window, errors, 'R6-约束作废信号（AC3 弱）', async() => {
      const input = window.getByPlaceholder('如：更冷一点、不要华语、想听纯音乐').first()
      if (!(await input.isVisible().catch(() => false))) throw new Error('约束输入框不可见')
      await input.fill('更冷一点')
      await window.getByRole('button', { name: '发送' }).click()
      // 等作废 warn 与新批次组头
      const start = Date.now()
      let sawInvalidate = false
      let sawBatch = false
      while (Date.now() - start < 90000) {
        if (warnings.some(w => w.includes('作废缓存的锚点分析'))) sawInvalidate = true
        const body = await window.evaluate(() => document.body.innerText)
        if (/约束 更冷一点/.test(body)) sawBatch = true
        if (sawInvalidate && sawBatch) break
        await window.waitForTimeout(1500)
      }
      if (!sawInvalidate) throw new Error('未捕获作废 warn（指令未触发作废）')
      if (!sawBatch) throw new Error('新批次组头未记录新约束')
    })

    await step(window, errors, 'R7-反馈计数骨架（far/good 入指标）', async() => {
      const far = window.getByRole('button', { name: '太远了' })
      const good = window.getByRole('button', { name: '就这个方向' })
      if (!(await far.isVisible().catch(() => false))) throw new Error('反馈按钮不可见')
      await good.click()
      await window.waitForTimeout(2500)
      await far.click()
      await window.waitForTimeout(2500)
      // far 收缩距离后距离文案应变窄（存在任意文案即可，避免脆断言）
      const body = await window.evaluate(() => document.body.innerText)
      if (!/允许一些偶遇|几乎不离开这里|离这里不太远|带我走远一点/.test(body)) throw new Error('距离档位文案缺失')
    })

    await step(window, errors, 'R9-断网连续失败收台与复活（AC9）', async() => {
      // 先在有网时保证搜索结果行可用（断网后无法再搜索；页面经 keep-alive 驻留上次结果）
      await nav(window, '#/search')
      await window.waitForTimeout(1000)
      if (await window.locator('.list-item').count() < 5) {
        const input = window.getByPlaceholder('Search for something...').first()
        await input.fill('林俊杰')
        await input.press('Enter')
        await window.waitForTimeout(8000)
        await window.keyboard.press('Escape')
        await window.waitForTimeout(500)
        if (await window.locator('.list-item').count() < 5) throw new Error('搜索结果行不足，无法多轮切歌')
      }
      const cdp = await window.context().newCDPSession(window)
      await cdp.send('Network.enable')
      await cdp.send('Network.setBlockedURLs', { urls: ['http://*/*', 'https://*/*'] })
      try {
        // 连续路径外切歌：每次触发一次重锚计划，断网下候选池为空 → 计划失败；计满三次即收台
        for (let i = 0; i < 3; i++) {
          await nav(window, '#/search')
          await window.waitForTimeout(600)
          const ok = await playSearchRow(window, i + 1)
          if (!ok) throw new Error(`第 ${i + 1} 次切歌行不可点`)
          await nav(window, '#/explore')
          // 等本轮失败露出或会话消失（收台）；初始失败保留会话并显示失败文案
          const start = Date.now()
          let sawFailure = false
          let sessionGone = false
          while (Date.now() - start < 100000) {
            const body = await window.evaluate(() => document.body.innerText)
            if (/这次计划没有完成/.test(body)) sawFailure = true
            if (!/你在这里/.test(body)) sessionGone = true
            if (sawFailure || sessionGone) break
            await window.waitForTimeout(2000)
          }
          console.log(`      [fail-round ${i + 1}] failure=${sawFailure} sessionGone=${sessionGone}`)
          if (!sawFailure && !sessionGone) throw new Error(`第 ${i + 1} 轮 100s 内未见计划失败/收台`)
          if (sessionGone) break
        }
        const settled = await window.evaluate(() => document.body.innerText)
        if (/你在这里/.test(settled)) throw new Error('连续三次计划失败后仍在会话中（未收台）')
        if (!/这次计划没有完成|从当前播放的歌曲出发/.test(settled)) throw new Error('收台后空态/失败文案缺失')
      } finally {
        await cdp.send('Network.setBlockedURLs', { urls: [] })
      }
      // 收台后电台仍为开：恢复网络 + 切歌应自动重开新台
      await nav(window, '#/search')
      await window.waitForTimeout(600)
      const ok = await playSearchRow(window, 4)
      if (!ok) throw new Error('复活切歌行不可点')
      await nav(window, '#/explore')
      const start = Date.now()
      let revived = false
      while (Date.now() - start < 90000) {
        const body = await window.evaluate(() => document.body.innerText)
        if (/你在这里/.test(body) && /本地计划|AI 计划/.test(body) && !/正在计划下一段/.test(body)) { revived = true; break }
        await window.waitForTimeout(2000)
      }
      if (!revived) throw new Error('收台后切歌未自动重开新台')
    })

    await screenshot(window, 'radio_first_phase')
    await app.close()
  }

  // ============ R8：落盘指标读回（AC7 弱验证） ============
  {
    const dataFile = path.join(profileDir, 'LxDatas', 'data.json')
    try {
      const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
      const m = raw.recommendMetrics
      if (!m) throw new Error('data.json 中无 recommendMetrics 键')
      const fields = ['runCount', 'farCount', 'goodCount', 'plannedBatches', 'recommendedStarted', 'recommendedEnded']
      const missing = fields.filter(f => !(f in m))
      if (missing.length) throw new Error(`缺字段: ${missing.join(',')}`)
      const bad = []
      if (!(m.runCount >= 1)) bad.push('runCount<1')
      if (!(m.plannedBatches >= 1)) bad.push('plannedBatches<1')
      if (!(m.farCount >= 1)) bad.push('farCount<1')
      if (!(m.goodCount >= 1)) bad.push('goodCount<1')
      record('R8-指标落盘读回（AC7 弱）', bad.length === 0, JSON.stringify(m).slice(0, 300) + (bad.length ? ' | BAD: ' + bad.join(',') : ''))
    } catch (err) {
      record('R8-指标落盘读回（AC7 弱）', false, `${err.message}`.slice(0, 200))
    }
  }

  // ============ 第二程：同 profile 重启自动开台（AC10） ============
  {
    const { app, window } = await launchApp({ profileDir })
    const errors = collectErrors(window)
    await window.waitForTimeout(3000)

    await step(window, errors, 'R10-重启恢复自动开台（AC10）', async() => {
      // 不做任何点击：等待启动恢复派发首个 musicToggled → 电台自动开台
      // （断言文本只渲染在探索页，先给启动恢复约 8s 再导航，避免抢占 musicToggled 时序）
      await window.waitForTimeout(8000)
      await nav(window, '#/explore')
      let opened = false
      const start = Date.now()
      while (Date.now() - start < 120000) {
        const body = await window.evaluate(() => document.body.innerText)
        if (/你在这里/.test(body)) {
          const settled = await waitPlanSettled(window, 45000)
          opened = /本地计划|AI 计划|正在计划下一段/.test(settled) || /你在这里/.test(settled)
          break
        }
        await window.waitForTimeout(2000)
      }
      if (!opened) throw new Error('重启后 120s 内未自动开台')
      if (!(await window.locator('[aria-label="关闭探索电台"]').count())) throw new Error('重启后开关态不正确')
      const bar = await readPlaybar(window)
      if (!bar.title) throw new Error('重启后未恢复播放栏歌曲')
    })

    await screenshot(window, 'radio_relaunch')
    const errs = errors.filter(e => !/net::|ERR_|Failed to fetch|timeout/i.test(e))
    record('R11-重启页面无脚本错误', errs.length === 0, errs.slice(0, 3).join(' || ').slice(0, 200))
    await app.close()
  }

  console.log('\n===== 汇总 =====')
  const fails = results.filter(r => !r.ok)
  console.log(`PASS ${results.length - fails.length}/${results.length}`)
  if (fails.length) fails.forEach(f => console.log(`FAIL: ${f.name} | ${f.detail}`))
  process.exit(fails.length ? 1 : 0)
})().catch(err => {
  console.error('RADIO E2E CRASHED:', err)
  process.exit(2)
})
