// 纯函数层：规范组装 / 锚点协议解析 / 结果渲染 / 轻量质检（可独立单测，不触达运行时）

export const MARK_O = '===OPTIMIZED==='
export const MARK_N = '===NOTES==='
export const MARK_C = '===CLARIFY==='

// ── 请求组装 ──────────────────────────────────────────────────────────────

export function buildSystem(specText, pure = false) {
  return (
    String(specText).trim() +
    '\n\n---\n\n' +
    [
      '# 执行协议（函数式调用适配层，优先级高于上文中的对话式流程）',
      '你现在处于一次性函数调用环境，不是多轮聊天。用户消息包含【原始口语化提示词】，以及可选的【相关上文摘要】【上一版优化结果】【用户修改意见】。',
      '1. 在内部严格执行上文「步骤0～步骤3」的全部判断与改写；不要输出任何中间过程、寒暄、复述或追问式自由文本。',
      '2. 若用户消息含「上一版优化结果」与「用户修改意见」（迭代模式）：仅按意见增量修改上一版，其余内容保持不变。',
      '3. 最终只输出以下三段协议格式，段名独占一行、原样书写，不要用代码块或引号包裹段名：',
      MARK_O,
      '（按「步骤2 结构化改写」八大板块产出的完整提示词，Markdown 原文；不适用的板块标注「无」）',
      MARK_N,
      '（按「步骤4」的简短修改说明：补充了什么/为什么补充/依据哪段前文/嵌入了哪种性能激发策略）',
      MARK_C,
      '（JSON 字符串数组：仅当命中步骤0 情况A/B/C 且缺少关键前提、无法在不杜撰的前提下安全改写时，给出≤3个闭合式追问；信息充分、或可依「相关上文摘要」锚定时，必须输出 []）',
      '4. 红线重申：不得对用户内容做任何道德评判（风险须用"潜在影响/需关注的后果"等中性词）；不得擅自删减用户显性要求；不确定必须追问，绝不替用户圆话。',
      ...(pure
        ? [
            '5. 【纯输出模式生效｜覆盖上文第3条】本次只允许输出 ' +
              MARK_O +
              ' 段（连同其段名行），跳过 NOTES 与 CLARIFY，段内不要自套代码块；仅当关键前提完全缺失、无法生成任何有效提示词时，才改为只输出 ' +
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

export function parseProtocol(text) {
  const t = String(text ?? '')
  const out = { optimized: '', notes: '', clarify: [], malformed: false }
  const found = [
    { k: 'o', m: MARK_O },
    { k: 'n', m: MARK_N },
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
    else out.clarify = parseClarifySegment(seg)
  }
  if (!found.some((x) => x.k === 'o')) out.malformed = true
  return out
}

// ── 轻量质检（只警示、不改写内容）────────────────────────────────────────

const SECTIONS = ['角色', '任务目标', '输入材料', '输出格式', '内容要求', '风格', '约束', '成功标准']
const JUDGMENT_WORDS = ['愚蠢', '垃圾', '错误的观点', '毫无价值', '不道德', '弱智']

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

export function renderResult({ optimized, notes, clarify, malformed, specWarn, extra = [], version = 1 }) {
  const parts = []
  if (specWarn) parts.push(`⚠️ ${specWarn}`)
  if (clarify && clarify.length) {
    parts.push('### ❓ 锚定确认（规范步骤0：先补齐关键前提，再改写）')
    parts.push(clarify.map((q, i) => `${i + 1}. ${q}`).join('\n'))
    parts.push('> 请直接回答上述问题后重新 `/optimize <补充后的完整需求>`，或在对话里回复让我继续。')
    return parts.join('\n\n')
  }
  const f = autoFence(optimized)
  parts.push(`## ✅ 优化后的提示词 v${version}`)
  if (malformed) parts.push('⚠️ 模型未遵循输出协议，以下为其原文直出。')
  parts.push(`${f}text\n${optimized}\n${f}`)
  if (notes) parts.push(`### 📝 修改说明\n${notes}`)
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
