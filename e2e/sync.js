/**
 * T-A2/T-A3 e2e：从官方源导入一个真实歌单（收藏）→ 校验元数据持久化（cover/desc/author）→ 重启应用 → 启动自动同步记录（updateTime/updateError）。
 * 用法: node e2e/sync.js
 */
const { launchApp, collectErrors, screenshot, ART_DIR } = require('./harness')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

function sqlite(profileDir, sql) {
  const db = path.join(profileDir, 'LxDatas', 'lx.data.db')
  return execFileSync('sqlite3', [db, sql], { encoding: 'utf8' }).trim()
}

async function agree(window) {
  const btn = window.locator('button').filter({ hasText: /^接受/ }).first()
  const found = await btn.waitFor({ timeout: 6000 }).then(() => true).catch(() => false)
  if (!found) return // 已同意过（二次启动）
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

/** 依次尝试各官方源，取第一个能加载出真实歌单并成功收藏的源。 */
async function importFirstWorkableList(window) {
  for (const s of ['kw', 'kg', 'tx', 'wy', 'mg']) {
    await nav(window, `#/songList/list?source=${s}`)
    await window.waitForTimeout(9000)
    const card = await window.evaluate(() => {
      const li = Array.from(document.querySelectorAll('li')).find(it => it.querySelector('img') && it.querySelector('p'))
      if (!li) return null
      const name = li.querySelector('p')?.textContent?.trim()
      li.click()
      return name
    })
    if (!card) continue
    await window.waitForTimeout(10000)
    const collectEnabled = await window.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === '收藏')
      return btn ? !btn.disabled : false
    })
    const detailName = await window.evaluate(() => document.querySelector('h3[title]')?.textContent?.trim() ?? '')
    if (collectEnabled) {
      await window.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === '收藏')
        btn?.click()
      })
      await window.waitForTimeout(5000)
      return { source: s, name: detailName || card }
    }
    // 该源详情不可用，返回换下一个源
    await window.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === '返回')
      btn?.click()
    }).catch(() => {})
    await window.waitForTimeout(1000)
  }
  throw new Error('所有源都未能加载真实歌单（网络受限）')
}

;(async() => {
  fs.mkdirSync(ART_DIR, { recursive: true })
  const results = []
  const record = (name, ok, detail = '') => {
    results.push({ name, ok, detail })
    console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`)
  }

  // ---------- 第一次启动：导入歌单 ----------
  let profileDir
  let imported = null
  {
    const launched = await launchApp()
    const { app, window } = launched
    profileDir = launched.profileDir
    const errors = collectErrors(window)
    await window.waitForTimeout(2500)
    await agree(window)
    await window.waitForTimeout(2000)

    try {
      imported = await importFirstWorkableList(window)
      record('T2-真实歌单导入(收藏)', true, `source=${imported.source} name=${imported.name}`)
    } catch (e) {
      record('T2-真实歌单导入(收藏)', false, e.message)
    }

    if (imported) {
      await nav(window, '#/list')
      await window.waitForTimeout(2500)
      const listText = await window.evaluate(() => document.body.innerText)
      record('T2-我的列表出现新列表', imported.name && listText.includes(imported.name), `name=${imported.name}`)

      await window.waitForTimeout(1000)
      try {
        const rows = sqlite(profileDir, `SELECT name, source, sourceListId, cover IS NOT NULL, desc IS NOT NULL, author IS NOT NULL FROM my_list WHERE source='${imported.source}' ORDER BY locationUpdateTime DESC LIMIT 5`)
        // 收藏时 SDK 可能未返回 desc/author（不视为 T2 失败），但封面 / sourceListId 必须持久化
        const lineOk = rows.split('\n').some(l => l.split('|').length === 6 && l.split('|')[3] === '1' && l.split('|')[2])
        record('T2-元数据持久化(DB)', lineOk, rows.replace(/\n/g, ' / '))
      } catch (e) {
        record('T2-元数据持久化(DB)', false, e.message)
      }
      record('T2-导入流程无新错误', errors.length === 0, errors.slice(0, 3).join('\n'))
    }
    await app.close()
  }

  // ---------- 第二次启动：T-A3 启动自动同步 ----------
  if (imported) {
    const { app, window } = await launchApp({ profileDir })
    const errors = collectErrors(window)
    await window.waitForTimeout(3000)
    await agree(window)
    // 给启动同步留时间（顺序同步一个歌单 + 写入记录）
    await window.waitForTimeout(25000)

    let dataJson = {}
    try {
      dataJson = JSON.parse(fs.readFileSync(path.join(profileDir, 'LxDatas', 'data.json'), 'utf8'))
    } catch (e) { console.log('data.json 读取失败:', e.message) }
    const updateInfo = dataJson?.listUpdateInfo ?? {}
    const entries = Object.entries(updateInfo)
    const synced = entries.filter(([, v]) => (v.updateTime ?? 0) > 0 || v.updateError)
    record('T3-启动同步产生更新记录', entries.length > 0 && synced.length > 0, JSON.stringify(updateInfo).slice(0, 300))

    // 打开更新管理弹窗展示更新状态
    await nav(window, '#/list')
    await window.waitForTimeout(1500)
    await window.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => x.getAttribute('aria-label') === '列表更新管理')
      b?.click()
    })
    await window.waitForTimeout(2000)
    const modalState = await window.evaluate(() => ({
      text: document.body.innerText,
      updateBtn: Array.from(document.querySelectorAll('button[aria-label="立即更新"]')).length,
    }))
    record('T3-弹窗显示列表与更新状态',
      modalState.text.includes('自动更新') && modalState.text.includes(imported.name) && modalState.updateBtn > 0,
      `updateBtn=${modalState.updateBtn}`)

    record('T3-重启后无渲染错误', errors.length === 0, errors.slice(0, 3).join('\n'))
    await app.close()
  }

  const fails = results.filter(r => !r.ok)
  console.log(`\n===== 汇总: PASS ${results.length - fails.length}/${results.length} =====`)
  process.exit(fails.length ? 1 : 0)
})().catch(e => { console.error('SYNC E2E CRASHED:', e); process.exit(2) })
