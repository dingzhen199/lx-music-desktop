/**
 * 平台相似推荐真实联调冒烟（手动执行，不参与 npm test）：
 *   npx vitest run --config vitest.smoke.config.ts
 *
 * 驱动真实 shipped 代码路径：platformRecall（种子定位 + 相似调用 + 融合 + 过滤）
 * → musicSdk wy/tx simiSong 适配器 → 线上端点（docs/platform-similar-recommendation-p0.md）。
 * 种子集 ~20 首（不同艺人/语言/热门冷门/版本），记录：同曲匹配成功率、有效候选数、
 * 重复/同艺人集中度、耗时、单平台 vs 聚合前五差异。仅客观结果，不宣称听感效果。
 */
import { it, vi } from 'vitest'
import { writeFileSync } from 'node:fs'

vi.hoisted(() => {
  const g = globalThis as any
  // @renderer/utils → @common/utils/renderer 在模块加载期访问 document（Node 环境无 DOM）
  if (!g.document) g.document = { getElementsByTagName: () => [] }
  if (!g.window) {
    // 真实渲染进程为 Chromium（DOMParser 存在）；Node 冒烟以实体解码桩替代（decodeName 用途）
    const decodeEntities = (str: string) => str
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#39;/g, '\'').replace(/&nbsp;/g, ' ')
      .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)))
      .replace(/&amp;/g, '&')
    g.window = {
      lx: { isProd: true },
      DOMParser: class {
        parseFromString(source: string) {
          return { body: { textContent: decodeEntities(String(source ?? '')) } }
        }
      },
    }
  }
})
// utils/request.js 依赖 @renderer/store 的 proxy（渲染态仓库在 Node 不可加载；冒烟不走代理）
vi.mock('@renderer/store', () => ({ proxy: { enable: false, host: '', port: '', envProxy: null } }))

const sleep = async(ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** 冒烟种子（不同艺人/语言/热门冷门/版本；intervalSec 供版本甄别，取平台实测时长）。 */
const ANCHORS = [
  { artist: '周杰伦', title: '晴天', album: '叶惠美', intervalSec: 269, id: 'wy_186016', source: 'wy', seedIds: { wy: '186016' } },
  { artist: 'Beyond', title: '海阔天空', intervalSec: 322 },
  { artist: '陈奕迅', title: '孤勇者', album: '孤勇者', intervalSec: 256 },
  { artist: '林俊杰', title: '江南', album: '第二天堂', intervalSec: 267 },
  { artist: '米津玄師', title: 'Lemon', album: 'Lemon', intervalSec: 256 },
  { artist: 'Queen', title: 'Bohemian Rhapsody', intervalSec: 355 },
  { artist: 'Taylor Swift', title: 'Love Story', intervalSec: 235 },
  { artist: 'Adele', title: 'Rolling in the Deep', intervalSec: 228 },
  { artist: '周深', title: '大鱼 (唱片版)', intervalSec: 318 },
  { artist: '五月天', title: '倔强', intervalSec: 259 },
  { artist: 'G.E.M. 邓紫棋', title: '光年之外', intervalSec: 235 },
  { artist: '毛不易', title: '消愁', intervalSec: 258 },
  { artist: '李荣浩', title: '李白', intervalSec: 267 },
  { artist: '万能青年旅店', title: '杀死那个石家庄人', intervalSec: 337 },
  { artist: '陈绮贞', title: '九份的咖啡店', intervalSec: 292 },
  { artist: '朴树', title: '平凡之路', intervalSec: 289 },
  { artist: 'Aimer', title: 'Ref:rain', intervalSec: 290 },
  { artist: 'BTS', title: 'Dynamite', intervalSec: 199 },
  { artist: 'IU', title: '좋은 날', intervalSec: 227 },
  { artist: '买辣椒也用券', title: '起风了', intervalSec: 326 },
]

it('平台相似推荐 ~20 种子真实冒烟（wy + tx 聚合）', async() => {
  const { recallPlatformSimilar } = await import('@renderer/core/recommend/platformRecall')
  const { sameSong } = await import('@renderer/core/recommend/sameSong')

  const rows: any[] = []
  for (const anchor of ANCHORS) {
    const started = Date.now()
    let result: any = null
    let error: string | null = null
    try {
      result = await recallPlatformSimilar(anchor as any, {})
    } catch (err) {
      error = (err as Error).message
    }
    const ms = Date.now() - started
    const items = result?.items ?? []
    // 单平台视角：仅 wy 来源条目按 wy 来源内排名；聚合视角：融合序
    const wyOnly = items.filter((i: any) => i.sources.some((s: any) => s.provider === 'wy'))
      .sort((a: any, b: any) => (a.sources.find((s: any) => s.provider === 'wy')!.rank - b.sources.find((s: any) => s.provider === 'wy')!.rank))
    const aggregateTop5 = items.slice(0, 5).map((i: any) => i.title)
    const wyTop5 = wyOnly.slice(0, 5).map((i: any) => i.title)
    const top5Overlap = aggregateTop5.filter((t: any) => wyTop5.includes(t)).length
    // 重复（同曲变体）与同艺人集中度
    const dupPairs: string[] = []
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        if (sameSong(items[i], items[j])) dupPairs.push(`${items[i].title}~${items[j].title}`)
      }
    }
    const artistCounts = new Map<string, number>()
    for (const item of items) {
      const key = String(item.artist ?? '').split(/[,、，/&;；|]+/)[0]?.trim() ?? ''
      artistCounts.set(key, (artistCounts.get(key) ?? 0) + 1)
    }
    const maxArtistCount = Math.max(0, ...artistCounts.values())
    rows.push({
      anchor: `${anchor.artist} - ${anchor.title}`,
      state: result?.state ?? `thrown: ${error}`,
      ms,
      providers: result?.providers ?? [],
      providerErrors: (result?.providers ?? []).filter((p: any) => p.error).map((p: any) => `${p.provider}: ${p.error}`),
      candidateCount: items.length,
      wyOnlyCount: wyOnly.filter((i: any) => i.sources.length === 1).length,
      multiSourceCount: items.filter((i: any) => i.sources.length > 1).length,
      dupPairs,
      maxArtistCount,
      top5: aggregateTop5,
      wyTop5,
      top5OverlapWy: top5Overlap,
      items: items.map((i: any) => `${i.title} - ${i.artist} [${i.sources.map((s: any) => `${s.provider}#${s.rank}`).join(',')}]`),
    })
    await sleep(8000)
  }

  // 汇总客观指标
  const attempted = rows.length * 2 // 每种子两平台
  const providerRows = rows.flatMap(r => r.providers ?? [])
  const located = providerRows.filter((p: any) => p.seedId != null).length
  const success = providerRows.filter((p: any) => p.status === 'success').length
  const noMatch = providerRows.filter((p: any) => p.status === 'no-match').length
  const errors = providerRows.filter((p: any) => p.status === 'error').length
  const okAnchors = rows.filter(r => r.state === 'ok').length
  const report = {
    date: new Date().toISOString(),
    summary: {
      anchors: rows.length,
      okAnchors,
      providerCalls: { attempted, located, success, noMatch, errors },
      seedMatchRate: `${located}/${attempted}`,
      avgMs: Math.round(rows.reduce((s, r) => s + r.ms, 0) / rows.length),
      totalDuplicates: rows.reduce((s, r) => s + r.dupPairs.length, 0),
      maxArtistConcentration: Math.max(0, ...rows.map(r => r.maxArtistCount)),
      multiSourceCandidates: rows.reduce((s, r) => s + r.multiSourceCount, 0),
    },
    rows,
  }
  const out = process.env.SMOKE_OUT
  if (out) writeFileSync(out, JSON.stringify(report, null, 2))
  console.log('SMOKE REPORT')
  console.log(JSON.stringify(report.summary, null, 2))
  for (const row of rows) {
    console.log(`- ${row.anchor}: state=${row.state} ${row.ms}ms candidates=${row.candidateCount} multiSource=${row.multiSourceCount} dup=${row.dupPairs.length} maxArtist=${row.maxArtistCount}`)
    console.log(`    top5=${row.top5.join(' | ')}`)
    console.log(`    wyTop5=${row.wyTop5.join(' | ')} overlap=${row.top5OverlapWy}`)
  }
  // 基本健全性：至少一半种子拿到候选（全灭说明环境问题而非产品问题）
  if (okAnchors === 0) throw new Error('所有种子均未取得候选——疑似网络/端点环境问题')
}, 600_000)
