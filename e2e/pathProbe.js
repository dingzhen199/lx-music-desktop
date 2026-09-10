/**
 * 探索路径点击跳播探针：
 * 仅断言播放栏标题切换不足以证明“真的换歌”——setPlayMusicInfo 会同步切换标题，
 * 但若播放器没有真正加载新音频（旧 bug：只 setPlayMusicInfo + play()，音频元素仍是旧 src），
 * 用户会看着新标题继续听旧歌。本探针叠加两个音频级信号：
 * - playerLoadstart 事件：主音频元素加载了新资源（setResource 触发）；
 * - 播放栏状态文本变化：URL 拉取/换源失败也会改变状态（限流环境下 loadstart 可能不出现）。
 */

// 同曲规则独立副本在本模块再导出（deep.js 依赖 pathProbe 的导出名；drift 防护见 e2e/sameSongRules.test.js）
const { normalizeTitleText, artistTokens, sameSongText } = require('./sameSongRules')

/** 在页面注册音频事件探针（必须在点击前调用）。 */
async function setupSwitchProbe(window) {
  await window.evaluate(() => {
    const probe = { loadstart: 0 }
    window.__switchProbe = probe
    window.app_event.off('playerLoadstart', window.__onProbeLoadstart)
    window.__onProbeLoadstart = () => { probe.loadstart++ }
    window.app_event.on('playerLoadstart', window.__onProbeLoadstart)
  })
}

/** 读取探针计数。 */
async function readSwitchProbe(window) {
  return window.evaluate(() => (window.__switchProbe ? { ...window.__switchProbe } : null))
}

/** 读取播放栏当前标题与状态文本（标题元素带 aria-label，状态为其父容器最后一个子元素）。 */
async function readPlaybar(window) {
  return window.evaluate(() => {
    const titleEl = document.querySelector('[aria-label*="点击复制"]')
    if (!titleEl) return { title: '', status: '' }
    const info = titleEl.parentElement
    const status = info?.children?.[info.children.length - 1]?.textContent?.trim() ?? ''
    return { title: titleEl.getAttribute('aria-label') ?? '', status }
  })
}

/** 点击路径中第一个非当前行的角色徽章，返回被点击行的标题（不校验结果）。 */
async function clickNonCurrentPathRow(window, rowIndex = 0) {
  return window.evaluate((idx) => {
    const roles = ['守住', '挖深', '打开', '转向', '落地']
    const currentLabel = document.querySelector('[aria-label*="点击复制"]')?.getAttribute('aria-label') ?? ''
    const badges = Array.from(document.querySelectorAll('span')).filter(d => roles.includes(d.textContent?.trim()))
    const rows = badges.map(b => {
      const row = b.parentElement
      const title = row?.children?.[1]?.children?.[0]?.children?.[0]?.textContent?.trim() ?? ''
      return { title, badge: b }
    }).filter(r => r.title && !currentLabel.includes(r.title))
    const target = rows[idx]
    if (!target) return { error: `没有可点击的非当前行: ${rows.map(r => r.title).join('/')}` }
    target.badge.click()
    return { clicked: target.title }
  }, rowIndex)
}

/**
 * 点击并等待“切换到目标标题”+“音频级换源信号”。
 * 音频级信号三选一（任一即为“点击真实生效”）：
 * - playerLoadstart：主音频元素加载了新资源（URL 成功路径）；
 * - 状态文本变化：URL 拉取/换源失败也会改变状态（限流环境）；
 * - 标题后来被顶走成别的歌：换源失败后自动切歌弹出队首（限流环境的证据）。
 * 注意：若点击前播放列表资源已加载成功，旧实现（只 setPlayMusicInfo + play()）
 * 会在标题切换后继续播放旧音频——此时 loadstart=0、状态不变、标题也不再变化，
 * 探针会正确判失败；而限流环境下（音频 src 已被清空）新旧实现行为一致，只能靠
 * 状态变化/顶走信号判别“机制正确、外部限流导致资源没加载”。
 * @returns {{ clicked: string|null, matched: boolean, detail: string }}
 */
async function clickPathRowAndVerify(window, rowIndex = 0) {
  const before = await readPlaybar(window)
  await setupSwitchProbe(window)
  const clickInfo = await clickNonCurrentPathRow(window, rowIndex)
  if (clickInfo.error) return { clicked: null, matched: false, detail: clickInfo.error }

  let everTitleMatched = false
  let displaced = false
  let statusChanged = false
  let loadstart = 0
  let last = before
  for (let i = 0; i < 24; i++) {
    await window.waitForTimeout(500)
    last = await readPlaybar(window)
    const probe = await readSwitchProbe(window)
    loadstart = probe?.loadstart ?? loadstart
    statusChanged ||= last.status !== before.status
    if (last.title.includes(clickInfo.clicked)) everTitleMatched = true
    else if (everTitleMatched) displaced = true
  }
  const matched = everTitleMatched && (loadstart > 0 || statusChanged || displaced)
  return {
    clicked: clickInfo.clicked,
    matched,
    detail: [
      `click=${clickInfo.clicked}`,
      `title=${last.title}`,
      `status=${JSON.stringify(before.status)}→${JSON.stringify(last.status)}`,
      `loadstart=${loadstart}`,
      `displaced=${displaced}`,
    ].join(' '),
  }
}

/**
 * 若存在 material-modal 遮罩（首次启动的更新日志等弹窗会延迟弹出、拦截后续点击），
 * 点击弹窗内第一个按钮（模板顺序顶部为关闭 ✕）关闭；返回是否已无遮罩。
 */
async function dismissOverlayModal(window) {
  for (let i = 0; i < 5; i++) {
    const info = await window.evaluate(() => {
      for (const el of document.querySelectorAll('div')) {
        // eslint-disable-next-line no-undef -- 回调体在浏览器上下文执行（window.evaluate 序列化注入），getComputedStyle 由页面提供
        const cs = getComputedStyle(el)
        if (cs.backdropFilter && cs.backdropFilter !== 'none') {
          const btn = el.querySelector('button')
          if (btn) btn.click()
          return { text: (el.textContent ?? '').slice(0, 200), onClicked: Boolean(btn) }
        }
      }
      return null
    })
    if (!info) return true
    console.log(`      [dismiss] 关闭遮挡弹窗: ${JSON.stringify((info.text ?? '').split('\n')[0])} closeBtn=${info.onClicked}`)
    if (!info.onClicked) await window.keyboard.press('Escape').catch(() => {})
    await window.waitForTimeout(600)
  }
  return false
}

module.exports = { setupSwitchProbe, readSwitchProbe, readPlaybar, clickPathRowAndVerify, clickNonCurrentPathRow, dismissOverlayModal, normalizeTitleText, artistTokens, sameSongText }
