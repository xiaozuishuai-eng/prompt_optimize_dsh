// dsh-prompt-optimizer —— AI 提示词优化器（方案 C：复用 DSH ctx.llm 模型路由，零密钥自管）
//
// 入口四通道：
//   1) /optimize [--pure] <原始口语化提示词>  —— 人用命令（/optimize revise <意见> 迭代；--pure 纯输出）
//   2) optimize_prompt                        —— Agent 工具（pure=true 纯输出）
//   3) ctx.provide('promptOptimizer', ...)    —— Host 服务（供其他插件/测试复用核心管线）
//   4) /api/prompt-optimizer/latest           —— client 半轮询：优化结果自动填入页面输入框（config.autoFill）
//
// 规范源：config.specPath（默认包内 spec/prompt-engineer-spec.md，mtime 热缓存，读取失败回退内置快照并警示）。
// 路由：loader config 同时给出 provider+model 才覆盖；否则跟随 agentDefaultModel（主对话默认路由）。

import { readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { getBuiltinSpec } from './spec-snapshot.js'
import { buildSystem, buildUser, parseProtocol, renderResult, renderPure, validateStructure, judgmentWarnings, placeholderHints } from './prompt.js'

export const name = 'prompt-optimizer'
export const inject = ['tools', 'commands', 'llm']

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
// 可移植默认规范：包内自带的提示词工程师规范（用户可在配置里换成自己的规范文件）
const BUNDLED_SPEC_PATH = join(PLUGIN_DIR, '..', 'spec', 'prompt-engineer-spec.md')

// 诊断用模块级状态（diag()/watchdog() 读回）
let __poWebVisible = false
let __poWebErr = ''
let __poAppliedOk = false
let __poSweeps = 0
let __poWebOwned = null
let __poEnsure = null
const routeProbePaths = [
  '/api/prompt-optimizer/latest',
  '/api/prompt-optimizer/status',
  '/api/prompt-optimizer/client.js',
  '/api/prompt-optimizer/submit',
]

const DEFAULTS = {
  specPath: BUNDLED_SPEC_PATH,
  provider: undefined,
  model: undefined,
  timeoutMs: 90000,
  maxInputChars: 6000,
  maxOutputTokens: 8192,
  historySize: 5,
  pure: false,      // true 时默认纯输出；/optimize --pure 或 pure:true 单次开启
  autoFill: true,   // true 时优化结果自动填入页面输入框（client 半轮询消费；false = client 只收不发）
  contextAware: 'auto', // 上下文感知：'auto'=仅指代不明/输入过短时自动读本会话最近消息；true=总是附加；false=从不（零增量）
  contextMaxChars: 1800, // 自动读取的会话上下文长度上限（字符，约对应 ≤1.3k tokens）
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config }
  const history = new Map() // sessionId -> [{ raw, optimized, notes }]
  const pendingClarify = new Map() // historyKey -> { raw, ts }：追问后的下一次原始输入自动与原始需求合并（10 分钟窗口）
  const CONTEXT_HINT = /(这个|这些|那个|那篇|那份|它|上面|刚才|刚刚|继续|这条|这篇|之前|前面|咱们|我们)/
  function wantsContext(text) {
    return text.length < 40 || CONTEXT_HINT.test(text)
  }
  // 上下文感知核心：读会话最近若干条 user/assistant 文本消息（只取叶子字段，不整份拷贝），组锚定摘要
  function extractSessionDigest(agent, maxChars) {
    const events = agent && agent.session && Array.isArray(agent.session.events) ? agent.session.events : null
    if (!events || events.length === 0) return ''
    const picks = []
    const floor = Math.max(0, events.length - 3000)
    for (let i = events.length - 1; i >= floor && picks.length < 8; i--) {
      const e = events[i]
      const type = String((e && e.type) || '')
      if (type !== 'user/message' && type !== 'assistant/message') continue
      const msg = e.data && e.data.message ? e.data.message : e.data
      const blocks = msg && Array.isArray(msg.content) ? msg.content : null
      if (!blocks) continue
      let text = ''
      for (const b of blocks) {
        if (b && b.type === 'text' && typeof b.text === 'string') text += (text ? '\n' : '') + b.text
      }
      text = text.replace(/\s+/g, ' ').trim().slice(0, 220)
      if (!text) continue
      picks.push((type === 'user/message' ? '用户：' : '助手：') + text)
    }
    return picks.reverse().join('\n').slice(-Math.max(200, Number(maxChars) || 1800))
  }
  // 自动填入投递队列：最近一次成功的投递（正文/追问/错误），client 半轮询取走（seq 递增即新结果）
  let delivery = { seq: 0, text: '', ts: 0 }
  // 可观测性：臂力历史（最近 8 条）+ 轮询心跳注册表——专治"回执了但没人填"的定位
  let armHistory = []
  const pollers = new Map() // clientId -> { since, ts }
  // 投递持久化：跨重启/重载不丢结果（client 用水位判断是否补填，5 分钟内的新结果才回灌）
  // dshHomePath 是函数 dshHomePath(...segments)，非字符串路径
  let deliveryFile = null
  try {
    const hp = ctx.get('dshHomePath')
    if (typeof hp === 'function') deliveryFile = hp('prompt-optimizer', 'delivery.json')
    else if (typeof hp === 'string' && hp) deliveryFile = join(hp, 'prompt-optimizer', 'delivery.json')
  } catch { deliveryFile = null }
  if (deliveryFile) {
    void readFile(deliveryFile, 'utf8')
      .then((t) => {
        const j = JSON.parse(t)
        if (j && typeof j.seq === 'number' && j.seq > 0 && j.seq > delivery.seq) {
          delivery = { seq: j.seq, kind: j.kind || 'fill', text: String(j.text || ''), full: String(j.full || ''), ts: Number(j.ts) || 0 }
          armHistory = [{ seq: delivery.seq, kind: delivery.kind, len: delivery.text.length, at: new Date(delivery.ts || Date.now()).toISOString() + ' (restored)' }]
        }
      })
      .catch(() => { /* 首次运行无文件属正常 */ })
  }
  function arm(kind, text, full) {
    delivery = { seq: delivery.seq + 1, kind, text: String(text || ''), full: String(full || ''), ts: Date.now() }
    armHistory = [...armHistory.slice(-7), { seq: delivery.seq, kind, len: delivery.text.length, at: new Date(delivery.ts).toISOString() }]
    if (deliveryFile) {
      void (async () => {
        try {
          await mkdir(dirname(deliveryFile), { recursive: true })
          await writeFile(deliveryFile, JSON.stringify(delivery), 'utf8')
        } catch { /* 持久化失败不影响主流程 */ }
      })()
    }
    return delivery
  }

  // ── 规范加载：mtime 缓存 + 失败回退内置快照（警示不静默）───────────────
  let specCache = { key: '', mtimeMs: -1, content: '', warn: '（尚未加载）' }
  async function loadSpec() {
    try {
      const st = await stat(cfg.specPath)
      if (specCache.key === cfg.specPath && specCache.mtimeMs === st.mtimeMs && !specCache.warn) return specCache
      const text = await readFile(cfg.specPath, 'utf8')
      if (text.trim().length < 200) throw new Error('规范文件内容过空/过短(<200字)，疑似损坏')
      specCache = { key: cfg.specPath, mtimeMs: st.mtimeMs, content: text, warn: '' }
    } catch (error) {
      const reason = error && error.message ? error.message : String(error)
      specCache = { key: cfg.specPath, mtimeMs: -1, content: getBuiltinSpec(), warn: `未能读取外部规范 ${cfg.specPath}（${reason}），本次已回退内置规范` }
      ctx.get('logger')?.warn?.(`[prompt-optimizer] ${specCache.warn}`)
    }
    return specCache
  }

  // ── 路由解析：显式覆盖 > 跟随主对话默认选择 ────────────────────────────
  function resolveRoute() {
    if (cfg.provider && cfg.model) return { provider: cfg.provider, model: cfg.model }
    const sel = ctx.get('agentDefaultModel')?.currentSelection?.()
    if (sel && sel.provider && sel.model) return { provider: sel.provider, model: sel.model }
    return null // 交由 llm 服务自身的默认解析
  }

  // ── 单次 LLM 补全（非流式聚合；参照 dsh-session-title-llm 的调用形态）──
  async function callLlm(route, messages, system, signal, sessionId) {
    const options = { messages, system, maxTokens: cfg.maxOutputTokens, signal }
    if (route) {
      options.provider = route.provider
      options.model = route.model
    }
    if (sessionId) options.sessionId = sessionId
    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream(options)) {
      signal.throwIfAborted()
      assembler.push(chunk)
    }
    const finish = assembler.finish
    if (finish && finish.kind !== 'stop') {
      const error = new Error(finish.failure && finish.failure.message ? finish.failure.message : `模型返回终止状态 "${finish.kind}"`)
      if (finish.failure && finish.failure.code) error.code = finish.failure.code
      throw error
    }
    return assembler
      .blocks()
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
  }

  // ── 核心管线：接收 → 加载规范 → 组请求 → 调用 → 解析 → 渲染 ────────────
  async function runPipeline(agent, input = {}) {
    const raw = String(input.raw ?? '').trim()
    const feedback = String(input.feedback ?? '').trim()
    const sessionId = agent && agent.session ? agent.session.id : undefined
    const historyKey = input.historyKey || sessionId // 草稿态（无会话）用客户端草稿 key 记账
    const stack = historyKey ? history.get(historyKey) ?? [] : []
    const prev = stack.length ? stack[stack.length - 1] : null

    const isRevise = feedback.length > 0
    if (isRevise && !prev) {
      return { ok: false, text: '迭代模式没有可修订的上一版结果，请先执行 /optimize <原始提示词>。' }
    }
    let effectiveRaw = raw || (isRevise ? prev.raw : '')
    // 追问回答自动合并：上次追问后 10 分钟内的新原始输入视为对追问的回答，与原始需求合并（--fresh 强制换话题）
    if (historyKey && !isRevise && !input.fresh && raw) {
      const pending = pendingClarify.get(historyKey)
      if (pending && pending.raw && Date.now() - pending.ts < 600000) {
        effectiveRaw = pending.raw + '\n\n【用户对追问的补充回答】\n' + raw
      }
    }
    if (!effectiveRaw) {
      return { ok: false, text: '用法：/optimize <原始口语化提示词>；迭代：/optimize revise <修改意见>' }
    }
    if (effectiveRaw.length > cfg.maxInputChars) {
      return { ok: false, text: `原始输入过长（${effectiveRaw.length} 字符 > 上限 ${cfg.maxInputChars}），请精简或分段后重试。` }
    }

    const spec = await loadSpec()
    const pure = input.pure === undefined ? cfg.pure === true : !!input.pure
    const system = buildSystem(spec.content, pure)
    let digestText = String(input.digest ?? '').trim()
    const ca = cfg.contextAware
    const contextOn = ca === true || (ca === 'auto' && wantsContext(effectiveRaw))
    if (contextOn) {
      const auto = extractSessionDigest(agent, Number(cfg.contextMaxChars) || 1800)
      if (auto) digestText = (digestText ? digestText + '\n\n' : '') + '【插件自动读取的本会话最近消息（按时间顺序，最后一条最新）】\n' + auto
    }
    const user = buildUser({
      raw: effectiveRaw,
      digest: digestText,
      prev: isRevise ? prev.optimized : null,
      feedback: isRevise ? feedback : null,
    })
    const messages = [
      createUserMessage({
        content: [{ type: 'text', text: user }],
        source: { kind: 'plugin', plugin: 'dsh-prompt-optimizer' },
      }),
    ]
    const signal = AbortSignal.timeout(cfg.timeoutMs)

    let text
    try {
      text = await callLlm(resolveRoute(), messages, system, signal, sessionId)
    } catch (error) {
      const failText = signal.aborted
        ? `优化调用失败：超时（${cfg.timeoutMs}ms），请稍后用 /optimize 重试。`
        : `优化调用失败：${error && error.message ? error.message : String(error)}。若持续失败请检查模型路由可用性（本插件跟随主对话路由）。`
      return { ok: false, text: failText }
    }

    const parsed = parseProtocol(text)
    if (!parsed.optimized.trim() && parsed.clarify.length === 0) {
      return { ok: false, text: '优化失败：模型未产出有效内容，请重试。', parsed }
    }

    let version
    if (parsed.clarify.length === 0 && historyKey) {
      stack.push({ raw: effectiveRaw, optimized: parsed.optimized, notes: parsed.notes })
      while (stack.length > cfg.historySize) stack.shift()
      history.set(historyKey, stack)
    }
    version = historyKey ? Math.max(1, (history.get(historyKey) ?? stack).length) : 1

    const extra = parsed.clarify.length === 0 ? [...validateStructure(parsed.optimized), ...placeholderHints(parsed.optimized), ...judgmentWarnings(parsed.optimized)] : []
    let rendered = pure
      ? renderPure({ optimized: parsed.optimized, clarify: parsed.clarify, specWarn: spec.warn })
      : renderResult({
          optimized: parsed.optimized,
          notes: parsed.notes,
          assumptions: parsed.assumptions,
          clarify: parsed.clarify,
          malformed: parsed.malformed,
          specWarn: spec.warn,
          extra,
          version,
        })
    // ── 投递给 client：追问/错误始终投递（保证可见）；正文投递受 autoFill 门控 ──
    if (parsed.clarify.length > 0) {
      arm('clarify', parsed.clarify.join('；'), rendered)
    } else if (cfg.autoFill === true) {
      arm('fill', parsed.optimized, rendered)
    }
    // 追问态登记：本轮追问 → 存原始需求等待合并；本轮成功 → 清除
    if (historyKey) {
      if (parsed.clarify.length > 0) {
        const nowTs = Date.now()
        for (const [k, v] of pendingClarify) {
          if (nowTs - v.ts > 30 * 60 * 1000) pendingClarify.delete(k)
        }
        pendingClarify.set(historyKey, { raw: effectiveRaw, ts: nowTs })
      } else {
        pendingClarify.delete(historyKey)
      }
    }

    // 交互模式在聊天流里明确告知自动填入去向（纯输出模式保持零噪音，靠输入框脉冲反馈）
    if (!pure && parsed.clarify.length === 0 && cfg.autoFill === true) {
      rendered += '\n\n> ⚡ 提示词已自动填入下方会话输入框（输入框闪蓝即成功），直接发送或先编辑均可；若框里已有草稿会弹「覆盖填入」按钮供你选择。'
    }
    return { ok: true, text: rendered, parsed, specWarn: spec.warn, version, pure }
  }

  // ── 通道 1：/optimize 命令（仅在已打开的会话里有意义；首页草稿由 client 拦截走 /submit）──
  // ⚠️ 处理器必须秒回：慢 handler（15~40s LLM）会阻塞新会话首条消息的提交链路，
  // 实测导致 UI 卡死且草稿会话被吞。受理即返回，结果经投递通道自动填入输入框。
  function parseOptimizeInput(rawLine) {
    let input = String(rawLine ?? '').trim()
    let pure = false
    if (/(?:^|\s)--?pure(?:\s|$)/i.test(input)) {
      pure = true
      input = input.replace(/\s*--?pure\s*/gi, ' ').trim()
    }
    let fresh = false
    if (/(?:^|\s)--?fresh(?:\s|$)/i.test(input)) {
      fresh = true
      input = input.replace(/\s*--?fresh\s*/gi, ' ').trim()
    }
    if (!input) return null
    const revise = /^revise\s+([\s\S]+)$/i.exec(input)
    const runArgs = revise ? { feedback: revise[1].trim(), pure, fresh } : { raw: input, pure, fresh }
    return { pure, runArgs }
  }
  function backgroundRun(agent, runArgs) {
    void Promise.resolve()
      .then(() => runPipeline(agent, runArgs))
      .then((r) => {
        if (r && r.ok !== true) arm('error', String((r && r.text) || '优化失败').slice(0, 400), '')
      })
      .catch((error) => {
        arm('error', '优化失败：' + String((error && error.message) || error).slice(0, 300), '')
      })
  }
  ctx.commands.register({
    name: 'optimize',
    description: '将口语化需求优化为结构化提示词（结果输出到聊天并自动填入输入框；revise 迭代；--pure 纯输出）',
    input: { hint: '[--pure] <原始提示词> | [--pure] revise <修改意见>' },
    // ⚠️ 一律同步返回完整结果（实测：草稿态客户端的卡顿源于 harness 命令链路自身，
    // 与 handler 快慢无关——改异步反而让"已受理"成为唯一输出、结果丢进无人消费的队列。
    // 新会话草稿的正确路径是 client 拦截回车→POST /submit，根本不进这里）。
    async handler(invocation) {
      const parsedArgs = parseOptimizeInput(invocation && invocation.rawInput)
      if (!parsedArgs) {
        return { kind: 'error', text: '用法：/optimize <原始口语化提示词>；迭代：/optimize revise <修改意见>；加 --pure 只输出提示词本体' }
      }
      const result = await runPipeline(invocation.agent, parsedArgs.runArgs)
      return { kind: result.ok ? 'success' : 'error', text: result.text }
    },
  })

  // ── 通道 2：optimize_prompt Agent 工具 ─────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'optimize_prompt',
      description:
        '把用户口语化、非结构化的需求改写成结构化的高质量提示词（依据《提示词工程师规范》：八大板块 + 步骤0上下文锚定 + 性能激发）。' +
        '当用户表达"帮我把这段需求写成/优化成提示词""把这个 prompt 结构化"等意图时调用。' +
        '当输入存在指代（"这个/它/继续"）时，插件默认会自动读取本会话最近几条消息辅助锚定（contextAware=auto，仅指代不明/输入过短时触发，普通自包含需求不附加、不增加 token），你一般无需手工传 context_digest（有特别相关的历史片段时仍可传）；仅当自动上下文也不足以锚定时，先在对话中澄清再调用。' +
        '返回：优化后的完整提示词（代码块）+ 修改说明；或锚定追问清单。用户要求"只要结果/免解释/直接用"时置 pure=true（只回提示词本体）。产出后如用户想保存，可用 prompt_add 存入提示词库。',
      parameters: {
        raw_prompt: { type: 'string', required: true, description: '用户原始的口语化提示词/需求，完整粘贴、不要先行改写' },
        context_digest: { type: 'string', description: '可选：与本请求相关的对话上文摘要（帮助规范步骤0的锚定判定）' },
        feedback: { type: 'string', description: '可选：用户对上一版优化结果的修改意见（迭代模式；此时 raw_prompt 仍传最初的原始需求）' },
        pure: { type: 'boolean', description: '可选：true=只输出优化后的提示词本体（无修改说明，仅关键前提缺失时输出一行追问）' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        const initiator = ctx.get('agents')?.currentInitiator?.()
        const result = await runPipeline(initiator, {
          raw: args.raw_prompt,
          digest: args.context_digest,
          feedback: args.feedback,
          pure: args.pure,
        })
        return result.text
      },
      presentCall(args) {
        return { card: 'generic', title: '优化提示词', kind: 'read', rawInput: String((args && args.raw_prompt) || '').slice(0, 40) }
      },
    }),
  )

  // ── 通道 3：Host 服务（其他插件/测试可复用同一管线；fiber 停止自动回收）──
  ctx.provide('promptOptimizer', {
    version: '1.2.0',
    optimize: runPipeline,
    route: () => resolveRoute(),
    peekDigest: (agentRef, n) => extractSessionDigest(agentRef, Number(n) || 800),
    pendingCount: () => pendingClarify.size,
    specStatus: () => ({ path: cfg.specPath, warn: specCache.warn || '' }),
    // 看门狗遥测：sweeps（跑了多少轮）/ err（最近一轮报告）/ owned（本 fiber 持有哪些注册）
    watchdog: () => {
      const w = ctx.get('webServer')
      return {
        sweeps: __poSweeps,
        err: __poWebErr || '(clean)',
        owned: __poWebOwned ? [...__poWebOwned.keys()].map((k) => String(k).split('/').pop()) : null,
        inMap: w && w.exact && typeof w.exact.has === 'function'
          ? routeProbePaths.map((p) => w.exact.has(p))
          : 'no-map',
        exactSize: w && w.exact ? w.exact.size : 'n/a',
      }
    },
    // 手动触发一轮自愈（排障用）
    repair: () => {
      if (typeof __poEnsure !== 'function') return 'ensure 未初始化（channel 4 未执行到）'
      __poEnsure()
      return __poWebErr || 'ok'
    },
    diag: () => {
      const w = ctx.get('webServer')
      const out = { webVisible: !!w, tapFn: w ? typeof w.tapIndex : 'n/a', deliverySeq: delivery.seq, applied: false,
        routeInPluginMap: w && w.exact && typeof w.exact.has === 'function' ? w.exact.has('/api/prompt-optimizer/latest') : 'no-map' }
      if (w && w.__poPluginStamp === undefined) { try { w.__poPluginStamp = 'fiber@' + Date.now() } catch { /* ignore */ } }
      try { out.pluginStamp = w ? w.__poPluginStamp ?? null : null } catch { /* ignore */ }
      try { out.applied = __poAppliedOk } catch { /* ignore */ }
      return out
    },
  })

  // ── 通道 4：自动填入投递路由（client 半轮询）──
  // ⚠️ 两次事故教训：
  //   ①双挂载竞态：register 撞 duplicate 会 throw，落败 fiber 的 disposer 又按 path 无条件删表，
  //     产生"命令活着但 HTTP 全 404"——用自愈看门狗兜底。
  //   ②重启后失效：boot 时若 webServer 服务尚未就绪，旧写法会把整段（含定时器）锁死在 if(web)
  //     里→看门狗根本不启动。故：定时器无条件启动，webServer 引用每轮重新解析，就绪即注册。
  try {
    const clientFile = join(dirname(fileURLToPath(import.meta.url)), 'client-core.js')
    const routeDefs = [
      {
        kind: 'exact',
        path: '/api/prompt-optimizer/latest',
        handler: async (req, res) => {
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          try {
            const url = new URL(req.url ?? '/', 'http://x')
            const since = Number(url.searchParams.get('since')) || 0
            const clientId = String(url.searchParams.get('id') || 'anon').slice(0, 40)
            pollers.set(clientId, { since, ts: Date.now() })
            const fresh = delivery.text !== '' && delivery.seq > since
            res.end(JSON.stringify({
              ok: true,
              autoFill: cfg.autoFill === true,
              seq: delivery.seq,
              kind: delivery.kind || 'fill',
              ts: delivery.ts,
              text: fresh ? delivery.text : '',
              full: fresh && delivery.full ? delivery.full : '',
            }))
          } catch (error) {
            res.statusCode = 500
            res.end(JSON.stringify({ ok: false, error: String((error && error.message) || error).slice(0, 200) }))
          }
        },
      },
      {
        kind: 'exact',
        path: '/api/prompt-optimizer/status',
        handler: async (req, res) => {
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          const now = Date.now()
          res.end(JSON.stringify({
            ok: true,
            version: '1.2.0',
            route: resolveRoute(),
            spec: { path: cfg.specPath, warn: specCache.warn || '' },
            delivery: { seq: delivery.seq, kind: delivery.kind || null, ts: delivery.ts, ageMs: delivery.ts ? now - delivery.ts : null },
            arms: armHistory,
            pollers: [...pollers.entries()].map(([id, p]) => ({ id, since: p.since, ageMs: now - p.ts })),
          }))
        },
      },
      {
        kind: 'exact',
        path: '/api/prompt-optimizer/client.js',
        handler: async (req, res) => {
          res.setHeader('Content-Type', 'text/javascript; charset=utf-8')
          res.setHeader('Cache-Control', 'no-store')
          try {
            res.end(await readFile(clientFile, 'utf8'))
          } catch (error) {
            res.statusCode = 500
            res.end('/* prompt-optimizer client-core.js 读取失败: ' + String((error && error.message) || error).replace(/\*\//g, '') + ' */')
          }
        },
      },
      {
        kind: 'exact',
        path: '/api/prompt-optimizer/submit',
        handler: async (req, res) => {
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          try {
            if (String(req.method || 'GET').toUpperCase() !== 'POST') {
              res.statusCode = 405
              res.end(JSON.stringify({ ok: false, error: 'POST only' }))
              return
            }
            let body = ''
            for await (const chunk of req) body += chunk
            if (body.length > 64 * 1024) {
              res.statusCode = 413
              res.end(JSON.stringify({ ok: false, error: 'body too large' }))
              return
            }
            const payload = JSON.parse(body || '{}')
            const parsedArgs = parseOptimizeInput(payload.line)
            if (!parsedArgs) {
              res.end(JSON.stringify({ ok: false, error: 'usage' }))
              return
            }
            const key = String(payload.key || 'anon').slice(0, 64)
            backgroundRun(null, { ...parsedArgs.runArgs, historyKey: 'draft:' + key })
            res.end(JSON.stringify({ ok: true, seq: delivery.seq }))
          } catch (error) {
            res.statusCode = 400
            res.end(JSON.stringify({ ok: false, error: String((error && error.message) || error).slice(0, 200) }))
          }
        },
      },
    ]
    const tapFn = (html) => {
      if (!html || html.includes('/api/prompt-optimizer/client.js')) return html
      const tag = '<script id="dsh-po-client-script" src="/api/prompt-optimizer/client.js" defer></script>'
      return html.includes('</body>') ? html.replace('</body>', tag + '</body>') : html + tag
    }
    const owned = new Map() // path|'__tap' -> disposer（本 fiber 当前实际持有的注册）
    __poWebOwned = owned
    const ensureWeb = () => {
      __poSweeps += 1
      const web = ctx.get('webServer') // 每轮重新解析：boot 竞态下 webServer 可能稍后就绪
      if (!web) {
        __poWebErr = 'sweep#' + __poSweeps + ' webServer 未就绪（等待下一轮）'
        return
      }
      __poWebVisible = true
      const report = []
      try {
        for (const def of routeDefs) {
          const short = def.path.split('/').pop()
          const hasMap = !!(web.exact && typeof web.exact.has === 'function')
          if (hasMap ? web.exact.has(def.path) : owned.has(def.path)) continue
          try {
            owned.set(def.path, web.register(def))
            report.push('+' + short)
          } catch (error) {
            report.push('!' + short + ':' + String((error && error.message) || error).slice(0, 80))
          }
        }
        if (typeof web.tapIndex === 'function' && Array.isArray(web.indexTaps) && !web.indexTaps.includes(tapFn)) {
          try {
            owned.set('__tap', web.tapIndex(tapFn))
            report.push('+tap')
          } catch (error) {
            report.push('!tap:' + String((error && error.message) || error).slice(0, 80))
          }
        }
      } catch (error) {
        report.push('sweep-fail:' + String((error && error.message) || error).slice(0, 120))
      }
      if (report.length) __poWebErr = 'sweep#' + __poSweeps + ' ' + report.join(' ')
    }
    __poEnsure = ensureWeb
    const timerSvc = ctx.get('timer')
    ctx.effect(() => {
      ensureWeb()
      let stop = null
      if (timerSvc && typeof timerSvc.interval === 'function') {
        stop = timerSvc.interval(() => ensureWeb(), 10000)
      } else if (typeof setInterval === 'function') {
        const id = setInterval(() => ensureWeb(), 10000)
        stop = () => clearInterval(id)
      } else {
        __poWebErr = 'watchdog: timer 服务与 setInterval 均不可用，仅启动时尝试一次'
      }
      return () => {
        try { if (typeof stop === 'function') stop() } catch { /* ignore */ }
        for (const dispose of owned.values()) {
          try { dispose() } catch { /* 已被外界移除 */ }
        }
        owned.clear()
      }
    })
    __poAppliedOk = true
  } catch (error) {
    __poWebErr = String((error && error.stack) || error).slice(0, 500)
  }
}
