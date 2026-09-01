// 纯函数层：规范组装 / 锚点协议解析 / 结果渲染 / 轻量质检（可独立单测，不触达运行时）

export const MARK_O = '===OPTIMIZED==='
export const MARK_N = '===NOTES==='
export const MARK_A = '===ASSUMPTIONS==='
export const MARK_C = '===CLARIFY==='

// ── 请求组装 ──────────────────────────────────────────────────────────────

export function buildSystem(specText, pure = false) {
  return (
    String(specText).trim() +
    '\n\n---\n\n' +
    [
      '# 执行协议（函数式调用适配层，优先级高于上文中的对话式流程）',
      '你现在处于一次性函数调用环境，不是多轮聊天。用户消息包含【原始口语化提示词】，以及可选的【相关上文摘要】【上一版优化结果】【用户修改意见】。',
      '1. 在内部严格执行上文「步骤0～步骤4.5」的全部判断、改写与自检（本环境只有一轮输出机会：澄清预算直接体现为 CLARIFY 段；非阻断缺口一律"标注式默认"并写入 ASSUMPTIONS 段）；不要输出任何中间过程、寒暄、复述或追问式自由文本。',
      '2. 若用户消息含「上一版优化结果」与「用户修改意见」（迭代模式）：仅按意见增量修改上一版，其余内容保持不变。',
      '3. 最终只输出以下四段协议格式，段名独占一行、原样书写，不要用代码块或引号包裹段名；OPTIMIZED 段内直接给 Markdown 原文，不要自套 ``` 围栏（外层包裹由系统完成）：',
      MARK_O,
      '（按「步骤2」九板块产出的完整提示词，板块间以 --- 分隔，不适用板块标注「无」）',
      MARK_N,
      '（简短修改说明：补充了什么/为什么/依据哪段前文/嵌入了哪种性能激发策略）',
      MARK_A,
      '（JSON 数组：假设与待确认清单，每项形如 {"item":"假设/默认项","value":"本次取值","basis":"依据","ask":"若不对请告知"}；收录所有通用维度默认值与被降级处理的待确认项；{{占位符}}未填项也列于此；无任何假设输出 []）',
      MARK_C,
      '（JSON 字符串数组：仅当命中阻断性歧义、无法在不杜撰前提下安全改写时给出≤3个闭合式追问；信息充分、可依「相关上文摘要」锚定、或可按标注式默认降级时，必须输出 []）',
      '4. 红线重申：不得道德评判（风险用"潜在影响/需关注的后果"等中性词）；不得删减用户显性要求；用户专有上下文禁止杜撰；通用维度默认允许但必须进 ASSUMPTIONS 清单。',
      ...(pure
        ? [
            '5. 【纯输出模式生效｜覆盖上文第3条】本次只允许输出 ' +
              MARK_O +
              ' 段（连同其段名行），跳过 NOTES / ASSUMPTIONS / CLARIFY，段内不要自套代码块；仅当关键前提完全缺失、无法生成任何有效提示词时，才改为只输出 ' +
              MARK_C +
              ' 段，内容为一行简短闭合式追问。',
          ]
        : []),
    ].join('\n')
  )
}

export function buildUser({ raw, digest, prev, feedback }) {
  const blocks = [`## 原始口语化提示词\n${String(raw).trim()}`]
  if (digest) blocks.push(`## 相关上文摘要\n${String(digest).trim()}`)
  if (prev) blocks.push(`## 上一版优化结果\n${prev}`)
  if (feedback) blocks.push(`## 用户修改意见\n${String(feedback).trim()}`)
  return blocks.join('\n\n')
}

// ── 锚点协议解析 ──────────────────────────────────────────────────────────

function parseClarifySegment(seg) {
  if (!seg) return []
  const body = seg
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim()
  if (!body || body === '[]') return []
  try {
    const j = JSON.parse(body)
    if (Array.isArray(j)) return j.filter((s) => typeof s === 'string' && s.trim()).slice(0, 3)
  } catch {
    /* 非严格 JSON：按行降级解析 */
  }
  const lines = body
    .split(/\n+/)
    .map((l) => l.replace(/^\s*(?:\d+\s*[\.、\)]|[-•])\s*/, '').trim())
    .filter((l) => l && l !== '[]' && l !== '[' && l !== ']')
  return lines.slice(0, 3)
}

function parseAssumptions(seg) {
  if (!seg) return []
  const body = seg
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim()
  if (!body || body === '[]') return []
  try {
    const j = JSON.parse(body)
    if (Array.isArray(j)) {
      return j
        .map((it) => {
          if (typeof it === 'string') return { item: it, value: '', basis: '', ask: '' }
          if (it && typeof it === 'object') {
            return { item: String(it.item || ''), value: String(it.value || ''), basis: String(it.basis || ''), ask: String(it.ask || '') }
          }
          return null
        })
        .filter((x) => x && x.item)
        .slice(0, 8)
    }
  } catch {
    /* 非严格 JSON：按行降级 */
  }
  return body
    .split(/\n+/)
    .map((l) => l.replace(/^\s*(?:[-•]|\d+\s*[\.、\)])\s*/, '').trim())
    .filter((l) => l && l !== '[]')
    .slice(0, 8)
    .map((line) => ({ item: line, value: '', basis: '', ask: '' }))
}

export function parseProtocol(text) {
  const t = String(text ?? '')
  const out = { optimized: '', notes: '', clarify: [], assumptions: [], malformed: false }
  const found = [
    { k: 'o', m: MARK_O },
    { k: 'n', m: MARK_N },
    { k: 'a', m: MARK_A },
    { k: 'c', m: MARK_C },
  ]
    .map((x) => ({ ...x, i: t.indexOf(x.m) }))
    .filter((x) => x.i >= 0)
    .sort((a, b) => a.i - b.i)
  if (found.length === 0) {
    out.optimized = t.trim()
    out.malformed = true
    return out
  }
  for (let j = 0; j < found.length; j++) {
    const cur = found[j]
    const start = cur.i + cur.m.length
    const end = j + 1 < found.length ? found[j + 1].i : t.length
    const seg = t.slice(start, end).trim()
    if (cur.k === 'o') out.optimized = seg
    else if (cur.k === 'n') out.notes = seg
    else if (cur.k === 'a') out.assumptions = parseAssumptions(seg)
    else out.clarify = parseClarifySegment(seg)
  }
  if (!found.some((x) => x.k === 'o')) out.malformed = true
  return out
}

// ── 轻量质检（只警示、不改写内容）────────────────────────────────────────

const SECTIONS = ['角色', '任务目标', '输入材料', '输出格式', '内容要求', '风格', '约束', '成功标准']
const JUDGMENT_WORDS = ['愚蠢', '垃圾', '错误的观点', '毫无价值', '不道德', '弱智']

export function placeholderHints(text) {
  const m = String(text).match(/{{[^{}\n]{1,24}}}/g) || []
  const uniq = [...new Set(m)]
  if (!uniq.length) return []
  return [`ℹ️ 含 ${uniq.length} 个待填参数（${uniq.slice(0, 5).join('、')}${uniq.length > 5 ? ' 等' : ''}），使用前请替换为实际内容。`]
}

export function validateStructure(optimizedText) {
  const missing = SECTIONS.filter((s) => !String(optimizedText).includes(s))
  if (missing.length >= 3) {
    return [`ℹ️ 结构校验：疑似缺少板块（${missing.join('、')}）。可用 /optimize revise <意见> 补充。`]
  }
  return []
}

export function judgmentWarnings(text) {
  const hit = JUDGMENT_WORDS.filter((w) => String(text).includes(w))
  if (!hit.length) return []
  return [`⚠️ 质检：输出含疑似评判性措辞（${hit.join('、')}），请复核——规范要求风险表述保持中性。`]
}

// ── 结果渲染 ──────────────────────────────────────────────────────────────

function autoFence(text) {
  let max = 0
  const re = /`+/g
  let m
  while ((m = re.exec(text))) max = Math.max(max, m[0].length)
  return '`'.repeat(Math.max(3, max + 1))
}

export function renderResult({ optimized, notes, assumptions, clarify, malformed, specWarn, extra = [], version = 1 }) {
  const parts = []
  if (specWarn) parts.push(`⚠️ ${specWarn}`)
  if (clarify && clarify.length) {
    parts.push('### ❓ 锚定确认（规范步骤0：先补齐关键前提，再改写）')
    parts.push(clarify.map((q, i) => `${i + 1}. ${q}`).join('\n'))
    parts.push('> 直接回答上述问题后再发一次 `/optimize <你的回答>` 即可——插件会自动与你的原始需求合并；切换话题用 `/optimize --fresh <新需求>`。')
    return parts.join('\n\n')
  }
  const f = autoFence(optimized)
  parts.push(`## ✅ 优化后的提示词 v${version}`)
  if (malformed) parts.push('⚠️ 模型未遵循输出协议，以下为其原文直出。')
  parts.push(`${f}text\n${optimized}\n${f}`)
  if (notes) parts.push(`### 📝 修改说明\n${notes}`)
  if (assumptions && assumptions.length) {
    const rows = assumptions.map((a) => `| ${a.item} | ${a.value || '—'} | ${a.basis || '—'} | ${a.ask || '如需修正：/optimize revise 指出该项'} |`)
    parts.push(['### 🧷 假设与待确认清单', '| 假设/默认项 | 本次取值 | 依据 | 若不对请告知 |', '|---|---|---|---|', ...rows].join('\n'))
  }
  for (const e of extra) parts.push(e)
  return parts.join('\n\n')
}

// 纯输出模式：只有提示词本体（外层代码块便于一键复制），无任何标题/修改说明/质检注记；
// 唯一例外：规范文件回退警示（诚实披露义务）与完全缺前提时的一行追问。
export function renderPure({ optimized, clarify, specWarn }) {
  const warn = specWarn ? `⚠️ ${specWarn}\n\n` : ''
  if (clarify && clarify.length) {
    return warn + String(clarify[0]).trim()
  }
  const f = autoFence(optimized)
  return warn + `${f}text\n${optimized}\n${f}`
}
