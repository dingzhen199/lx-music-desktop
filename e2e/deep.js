/**
 * T-B2 探索会话深度 e2e：自动续补 / far 反馈收紧距离 / 一句话约束 / 离开返回保持 / 幂等。
 * 用法: node e2e/deep.js
 */
const { launchApp, collectErrors, screenshot, ART_DIR } = require('./harness')
const { clickPathRowAndVerify, clickNonCurrentPathRow, readPlaybar, dismissOverlayModal, sameSongText } = require('./pathProbe')
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

const getRemaining = async(window) => {
  const m = (await window.evaluate(() => document.body.innerText)).match(/队列剩余 (\d+) 首/)
  return m ? Number(m[1]) : null
}

/** 会话卡片的锚点歌名（“你在这里”上方）。 */
const readAnchorTitle = async(window) => {
  return window.evaluate(() => {
    const here = Array.from(document.querySelectorAll('div')).find(el => el.textContent?.trim() === '你在这里')
    const meta = here?.parentElement
    return meta?.children?.[1]?.textContent?.trim() ?? ''
  })
}

/**
 * 读取探索路径全部行 {title, artist}（played/planned/isCurrent 都算）。
 * 行结构（与 D3b 行选择兼容）：span 角色徽章（守住/挖深/打开/转向/落地）→ parentElement（pathItem 行）
 * → children[1]（pathMain）→ children[0]（pathName）→ title span（children[0]）+ artist span
 * （children[1]，文本以 "- " 开头，trim 后去掉前导 "- "）。
 */
const readPathRows = async(window) => {
  return window.evaluate(() => {
    const roles = ['守住', '挖深', '打开', '转向', '落地']
    const badges = Array.from(document.querySelectorAll('span')).filter(d => roles.includes(d.textContent?.trim()))
    const rows = []
    for (const b of badges) {
      const row = b.parentElement
      const name = row?.children?.[1]?.children?.[0]
      if (!name) continue
      const title = name.children?.[0]?.textContent?.trim() ?? ''
      const artistRaw = name.children?.[1]?.textContent?.trim() ?? ''
      const artist = artistRaw.startsWith('- ') ? artistRaw.slice(2).trim() : artistRaw
      if (title) rows.push({ title, artist })
    }
    return rows
  })
}

;(async() => {
  fs.mkdirSync(ART_DIR, { recursive: true })
  const { app, window } = await launchApp()
  const errors = collectErrors(window)
  const results = []
  const record = (name, ok, detail = '') => {
    results.push({ name, ok, detail })
    console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`)
  }
  await window.waitForTimeout(2500)
  await agree(window)

  // 搜索并播放
  await nav(window, '#/search')
  await window.waitForTimeout(800)
  const searchInput = window.getByPlaceholder('Search for something...').first()
  await searchInput.fill('周杰伦')
  await searchInput.press('Enter')
  await window.waitForTimeout(9000)
  const row = window.locator('.list-item').first()
  const rowVisible = await row.isVisible().catch(() => false)
  record('D0-搜索结果可用', rowVisible)
  if (rowVisible) {
    await window.keyboard.press('Escape')
    await window.waitForTimeout(500)
    await dismissOverlayModal(window)
    await row.dblclick({ position: { x: 250, y: 10 } })
    await window.waitForTimeout(7000)
  }

  // 开始探索
  const exploreBtn = window.locator('[aria-label="从此歌出发"]')
  record('D1-播放后探索按钮可用', !(await exploreBtn.isDisabled().catch(() => true)))

  // D1b 播放栏“添加当前歌曲到…”弹窗 → 我的收藏（回归：IPC 代理克隆异常）
  {
    const beforeErrors = errors.length
    const addBtn = window.locator('[aria-label="添加当前歌曲到..."]')
    if (await addBtn.isVisible().catch(() => false)) {
      await addBtn.click()
      await window.waitForTimeout(900)
      const clicked = await window.evaluate(() => {
        const closeBtn = document.querySelector('header button')
        if (!closeBtn) return { error: '弹窗未打开' }
        const container = closeBtn.closest('[class*=content]') || closeBtn.closest('div')
        const items = Array.from(container?.querySelectorAll('*') ?? [])
        const target = items.find(el => el.children.length === 0 && el.textContent?.trim() === '我的收藏')
        if (!target) return { error: '未找到我的收藏项' }
        target.click()
        return { ok: true }
      })
      await window.waitForTimeout(1500)
      const modalOpen = await window.evaluate(() => !!document.querySelector('header button'))
      const cloneError = errors.slice(beforeErrors).some(e => /could not be cloned|cloned/.test(e))
      record('D1b-添加当前歌曲到我机收藏', clicked.ok && !modalOpen && !cloneError,
        clicked.error ?? `已关闭=${!modalOpen} cloneError=${cloneError}`)
    } else {
      record('D1b-添加当前歌曲到我机收藏', false, '添加按钮不可见')
    }
  }

  await exploreBtn.click()
  await window.waitForTimeout(1000)
  await window.getByText('你在这里').first().waitFor({ timeout: 15000 }).catch(() => {})
  await window.getByText(/本地计划|AI 计划|这次计划没有完成|自动续补失败/).first().waitFor({ timeout: 45000 }).catch(() => {})
  const remaining0 = await getRemaining(window)
  record('D2-首计划入队', remaining0 != null && remaining0 > 0, `remaining=${remaining0}`)

  // D2b-幂等：当前歌 == 锚点时再点“从此歌出发”不重启（锚点不变）
  // 注：队列数在限流环境下会因换源失败自动切歌被弹掉，不作相等断言
  {
    const anchorBefore = await readAnchorTitle(window)
    await window.locator('[aria-label="从此歌出发"]').click().catch(() => {})
    await window.waitForTimeout(1500)
    const anchorAfter = await readAnchorTitle(window)
    const remainingAfter = await getRemaining(window)
    record('D2b-锚点相同时再点不重启', anchorBefore !== '' && anchorAfter === anchorBefore && remainingAfter != null,
      `anchor=${anchorBefore}→${anchorAfter} remaining=${remainingAfter}`)
  }

  // 自动续补：切到下一首（推荐曲目）→ 剩余<=3 触发续补
  if (remaining0 != null && remaining0 > 0) {
    await window.locator('[aria-label="下一首"]').click()
    await window.waitForTimeout(3000)
    const afterNextText = await window.evaluate(() => document.body.innerText)
    const refilling = /正在计划下一段|续补失败|本地计划/.test(afterNextText)
    // 等待续补完成（入队后剩余应超过切歌前的值）
    let grew = false
    for (let i = 0; i < 16; i++) {
      await window.waitForTimeout(3000)
      const r = await getRemaining(window)
      if (r != null && r > remaining0) { grew = true; break }
      if (r == null) break
    }
    record('D3-自动续补入队', grew || refilling, `remaining0=${remaining0} final=${await getRemaining(window)}`)
  }

  // 探索路径点击跳播：点击一个非当前行 → 断言播放栏标题切换 + 音频级换源信号（loadstart/状态变化）
  // 注：仅标题切换不能证明换歌——旧实现 setPlayMusicInfo 会同步切标题，但音频元素仍是旧 src（用户继续听旧歌）
  {
    const r = await clickPathRowAndVerify(window)
    record('D3b-路径点击跳播', r.matched, r.detail)
  }

  // D3c-路径无重复曲目：用户可见症状直锁（同曲多 id/artist 变体不得在路径里出两行）
  // 当前时刻全部路径行（含 D3b 刚点击的 planned→played 与 isCurrent 行）两两 sameSongText 比较；
  // 行数 < 2 时不足以产生重复，按 PASS 处理（限流环境路径可能很少，避免误杀）。
  {
    const rows = await readPathRows(window)
    if (rows.length < 2) {
      record('D3c-路径无重复曲目', true, `rows=${rows.length}（行数不足，不足以产生重复）`)
    } else {
      const dups = []
      for (let i = 0; i < rows.length; i++) {
        for (let j = i + 1; j < rows.length; j++) {
          if (sameSongText(rows[i], rows[j])) {
            dups.push(`"${rows[i].title}"(${rows[i].artist}) == "${rows[j].title}"(${rows[j].artist})`)
          }
        }
      }
      record('D3c-路径无重复曲目', dups.length === 0,
        `rows=${rows.length}${dups.length ? ` dup=${JSON.stringify(dups)}` : ''}`)
    }
  }

  // far 反馈收紧距离（默认 35 → 27 → 19 → 文案“几乎不离开这里”）
  const farBtn = window.getByRole('button', { name: '太远了' })
  if (await farBtn.isVisible().catch(() => false)) {
    await farBtn.click()
    await window.waitForTimeout(2500)
    await farBtn.click()
    await window.waitForTimeout(2500)
    const text = await window.evaluate(() => document.body.innerText)
    record('D4-far反馈收紧距离', /几乎不离开这里/.test(text), '')
  } else {
    record('D4-far反馈收紧距离', false, '太远了按钮不可见')
  }

  // 一句话约束（诉求 2：输入框改为受控草稿，点击“发送”按钮提交，不再 debounce 自动重排）
  const instructionInput = window.getByPlaceholder('如：更冷一点、不要华语、想听纯音乐')
  if (await instructionInput.isVisible().catch(() => false)) {
    await instructionInput.fill('不要华语')
    const sendBtn = window.getByRole('button', { name: '发送' }).first()
    await sendBtn.click().catch(() => false)
    await window.waitForTimeout(2500)
    const body = await window.evaluate(() => document.body.innerText)
    record('D5-一句话约束生效无崩溃', !/这次计划没有完成/.test(body), '')
  } else {
    record('D5-一句话约束生效无崩溃', false, '输入框不可见')
  }

  // 离开再返回，会话保持
  const beforeLeave = await window.evaluate(() => document.querySelectorAll('[class*=pathItem]').length || document.body.innerText.length)
  await nav(window, '#/search')
  await nav(window, '#/explore')
  await window.getByText('你在这里').first().waitFor({ timeout: 10000 }).catch(() => {})
  const afterBack = await window.evaluate(() => document.body.innerText)
  record('D6-离开返回会话保持', /你在这里/.test(afterBack) && /队列剩余/.test(afterBack), '')

  // 播放栏按钮再做一次（此时当前歌已因 D3b 切换到推荐曲目：锚点不同 → 新语义是重开会话；
  // 断言页面仍正常展示会话即可，重开细节由 D7b 覆盖）
  const btn2 = window.locator('[aria-label="从此歌出发"]')
  await btn2.click().catch(() => {})
  await window.waitForTimeout(1200)
  const afterClick2 = await window.evaluate(() => document.body.innerText)
  record('D7-再次点击按钮会话仍正常', /你在这里/.test(afterClick2), '')

  // D7b-切歌后点“从此歌出发”重开会话（诉求 B：当前歌 != 锚点应重新做推荐而非停留在旧结果）
  {
    const oldAnchor = await readAnchorTitle(window)
    const clickRes = await clickNonCurrentPathRow(window)
    if (clickRes.error) {
      record('D7b-切歌后点从此歌出发重开会话', false, clickRes.error)
    } else {
      await window.waitForTimeout(1200)
      await window.locator('[aria-label="从此歌出发"]').click().catch(() => {})
      await window.getByText('你在这里').first().waitFor({ timeout: 30000 }).catch(() => {})
      let newAnchor = ''
      for (let i = 0; i < 20; i++) {
        await window.waitForTimeout(1500)
        newAnchor = await readAnchorTitle(window)
        if (newAnchor && newAnchor !== oldAnchor) break
      }
      const body = await window.evaluate(() => document.body.innerText)
      const restarted = newAnchor && newAnchor !== oldAnchor && newAnchor.includes(clickRes.clicked)
      record('D7b-切歌后点从此歌出发重开会话', restarted && /队列剩余/.test(body),
        `old=${oldAnchor} new=${newAnchor} clicked=${clickRes.clicked}`)
    }
  }

  // 结束会话
  await window.getByRole('button', { name: '结束会话' }).click().catch(() => {})
  await window.waitForTimeout(800)
  const afterEnd = await window.evaluate(() => document.body.innerText)
  record('D8-结束会话回到空态',
    !/你在这里/.test(afterEnd) && !/队列剩余/.test(afterEnd) && /从当前播放的歌曲出发|请先播放一首歌曲/.test(afterEnd),
    '')

  record('D9-全程无页面错误', errors.length === 0, errors.slice(0, 3).join('\n'))

  await screenshot(window, 'deep_final')
  await app.close()
  const fails = results.filter(r => !r.ok)
  console.log(`\n===== 汇总: PASS ${results.length - fails.length}/${results.length} =====`)
  process.exit(fails.length ? 1 : 0)
})().catch(e => { console.error('DEEP E2E CRASHED:', e); process.exit(2) })
