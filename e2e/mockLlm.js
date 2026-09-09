/**
 * Mock LLM 服务器：模拟 OpenAI-compatible /chat/completions。
 * - ANALYSIS_SYSTEM 请求 → 返回分析 JSON（snake_case 兼容 normalizeAnalysis）。
 * - RANK_SYSTEM 请求 → 返回 ranking JSON 数组。
 * 所有请求体写入 ART_DIR/llm-requests.json 便于失败排查。
 */
const http = require('http')
const fs = require('fs')
const path = require('path')
const os = require('os')

function startMockLlm(opts = {}) {
  const { failRankTimes = 0, emptyContentTimes = 0 } = opts
  const requests = []
  const rankingRequests = []
  const rows = () => Array.from({ length: 60 }, (_, i) => ({
    candidate_id: String(i),
    score: i === 0 ? 0.95 : Math.max(0.2, 0.95 - i * 0.01),
    reason: `mock-reason-${i}`,
    confidence: 'high',
    distance_from_anchor: i < 6 ? 'near' : i < 20 ? 'medium' : 'far',
    perceptual_distance: Math.min(88, 18 + i),
    continuity: { vocal: 0.9, timbre: 0.85, instrumentation_texture: 0.88, rhythm_motion: 0.8 },
    world_breaks: [],
    journey_role: i % 3 === 0 ? 'deepen' : i % 3 === 1 ? 'hold' : 'open',
    next_song_worthiness: 0.8,
  }))
  const port = 18411
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      let body = null
      try { body = JSON.parse(raw) } catch {}
      requests.push({
        url: req.url,
        system: body?.messages?.find(m => m.role === 'system')?.content?.slice(0, 120) ?? '',
        userLen: body?.messages?.at(-1)?.content?.length ?? 0,
      })
      try {
        fs.appendFileSync(path.join(os.tmpdir(), 'lx-e2e-artifacts', 'llm-requests.json'), JSON.stringify({ url: req.url, body }, null, 2) + '\n')
      } catch {}
      const system = body?.messages?.find(m => m.role === 'system')?.content ?? ''
      let content
      if (system.includes('Listening Judgment')) {
        // 模拟真实模型偶发失败：前 failRankTimes 次返回“非 JSON 垃圾文本”（验证 engine 重试），
        // 之后 emptyContentTimes 次返回空 content（验证 llm.ts 的空内容明确报错 + engine 重试兜底）
        rankingRequests.push(requests.length - 1)
        if (rankingRequests.length <= failRankTimes) {
          content = '抱歉，我暂时无法完成这个任务，请稍后再试。'
        } else if (rankingRequests.length <= failRankTimes + emptyContentTimes) {
          content = ''
        } else {
          content = '```json\n' + JSON.stringify({ ranking: JSON.stringify(rows()) }) + '\n```'
        }
      } else {
        // analysis
        content = JSON.stringify({
          summary: 'mock 分析：保留原曲氛围，延续同名艺人方向',
          fingerprint: { vocal_identity: [], emotional_core: [], must_preserve: ['保持原曲主要演唱/器乐形态'], can_drift: [] },
          recall_directions: [{ name: '同艺人', reason: 'mock', search_artists: ['周杰伦'], search_keywords: [], target_language: 'unknown' }],
        })
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content } }] }))
    })
  })
  return new Promise(resolve => {
    server.listen(port, '127.0.0.1', () => {
      resolve({ baseUrl: `http://127.0.0.1:${port}/v1`, requests, close: () => new Promise(r => server.close(r)) })
    })
  })
}

module.exports = { startMockLlm }
