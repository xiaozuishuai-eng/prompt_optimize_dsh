// dsh-prompt-optimizer —— AI 提示词优化器（方案 C：复用 DSH ctx.llm 模型路由，零密钥自管）
//
// 入口四通道：
//   1) /optimize [--pure] <原始口语化提示词>  —— 人用命令（/optimize revise <意见> 迭代；--pure 纯输出）
//   2) optimize_prompt                        —— Agent 工具（pure=true 纯输出）
//   3) ctx.provide('promptOptimizer', ...)    —— Host 服务（供其他插件/测试复用核心管线）
//   4) /api/prompt-optimizer/latest           —— client 半轮询：优化结果自动填入页面输入框（config.autoFill）
//
// 规范源：config.specPath（默认为包内 spec/prompt-engineer-spec.md，mtime 热缓存，读取失败回退内置快照并警示）。
// 路由：loader config 同时给出 provider+model 才覆盖；否则跟随 agentDefaultModel（主对话默认路由）。

import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { BUILTIN_SPEC_SNAPSHOT } from './spec-snapshot.js'
import { buildSystem, buildUser, parseProtocol, renderResult, renderPure, validateStructure, judgmentWarnings } from './prompt.js'

export const name = 'prompt-optimizer'
export const inject = ['tools', 'commands', 'llm']

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
// 可移植默认规范：包内自带的提示词工程师规范（用户可在配置里换成自己的规范文件）
const BUNDLED_SPEC_PATH = join(PLUGIN_DIR, '..', 'spec', 'prompt-engineer-spec.md')

// 诊断用模块级状态（diag() 读回）
let __poWebVisible = false
let __poWebErr = ''
let __poAppliedOk = false

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
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config }
  const history = new Map() // sessionId -> [{ raw, optimized, notes }]
  // 自动填入投递队列：最近一次成功的投递（正文/追问/错误），client 半轮询取走（seq 递增即新结果）
  let delivery = { seq: 0, text: '', ts: 0 }
  // 可观测性：臂力历史（最近 8 条）+ 轮询心跳注册表——专治"回执了但没人填"的定位
  let armHistory = []
  const pollers = new Map() // clientId -> { since, ts }
  function arm(kind, text, full) {
    delivery = { seq: delivery.seq + 1, kind, text: String(text || ''), full: String(full || ''), ts: Date.now() }
    armHistory = [...armHistory.slice(-7), { seq: delivery.seq, kind, len: delivery.text.length, at: new Date(delivery.ts).toISOString() }]
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
      specCache = { key: cfg.specPath, mtimeMs: -1, content: BUILTIN_SPEC_SNAPSHOT, warn: `未能读取外部规范 ${cfg.specPath}（${reason}），本次已回退内置规范快照` }
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
    const effectiveRaw = raw || (isRevise ? prev.raw : '')
    if (!effectiveRaw) {
      return { ok: false, text: '用法：/optimize <原始口语化提示词>；迭代：/optimize revise <修改意见>' }
    }
    if (effectiveRaw.length > cfg.maxInputChars) {
      return { ok: false, text: `原始输入过长（${effectiveRaw.length} 字符 > 上限 ${cfg.maxInputChars}），请精简或分段后重试。` }
    }

    const spec = await loadSpec()
    const pure = input.pure === undefined ? cfg.pure === true : !!input.pure
    const system = buildSystem(spec.content, pure)
    const user = buildUser({
      raw: effectiveRaw,
      digest: input.digest,
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

    const extra = parsed.clarify.length === 0 ? [...validateStructure(parsed.optimized), ...judgmentWarnings(parsed.optimized)] : []
    let rendered = pure
      ? renderPure({ optimized: parsed.optimized, clarify: parsed.clarify, specWarn: spec.warn })
      : renderResult({
          optimized: parsed.optimized,
          notes: parsed.notes,
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
    if (!input) return null
    const revise = /^revise\s+([\s\S]+)$/i.exec(input)
    const runArgs = revise ? { feedback: revise[1].trim(), pure } : { raw: input, pure }
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
        '若用户输入指代不明（"这个/它/继续"且你也没有清晰前文），先在对话中澄清再调用；你有前文时把前文要点放进 context_digest。' +
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
    version: '1.0.0',
    optimize: runPipeline,
    route: () => resolveRoute(),
    specStatus: () => ({ path: cfg.specPath, warn: specCache.warn || '' }),
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

  // ── 通道 4：自动填入投递路由（client 半轮询；无 webServer 的环境自动跳过）──
  // try/catch + 错误记录：路由问题不再静默（diag 可观测），也不炸 apply 其余部分
  try {
    const web = ctx.get('webServer')
    __poWebVisible = !!web
    if (web) {
      ctx.effect(() => web.register({
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
      }), 'prompt-optimizer: /api/prompt-optimizer/latest route')

      // 诊断端点：投递臂力历史 + 轮询心跳（"只显示已受理/没填入"一查便知）
      ctx.effect(() => web.register({
        kind: 'exact',
        path: '/api/prompt-optimizer/status',
        handler: async (req, res) => {
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          const now = Date.now()
          res.end(JSON.stringify({
            ok: true,
            version: '1.0.0',
            route: resolveRoute(),
            spec: { path: cfg.specPath, warn: specCache.warn || '' },
            delivery: { seq: delivery.seq, kind: delivery.kind || null, ts: delivery.ts, ageMs: delivery.ts ? now - delivery.ts : null },
            arms: armHistory,
            pollers: [...pollers.entries()].map(([id, p]) => ({ id, since: p.since, ageMs: now - p.ts })),
          }))
        },
      }), 'prompt-optimizer: /api/prompt-optimizer/status route')

      // 自动填入脚本下发（每次请求现读文件：改 client-core.js 后刷新页面即生效）
      const clientFile = join(PLUGIN_DIR, 'client-core.js')
      ctx.effect(() => web.register({
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
      }), 'prompt-optimizer: /api/prompt-optimizer/client.js route')

      // 草稿/首页态的提交入口（client 拦截 /optimize 回车后 POST 到这里）：
      // 不创建会话、不走 harness 命令链路，结果同样经投递通道填回输入框；
      // key 为该标签页的草稿历史键（支持 hero 态 revise 迭代）。
      ctx.effect(() => web.register({
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
      }), 'prompt-optimizer: /api/prompt-optimizer/submit route')

      // tapIndex：把脚本挂进页面（免重启即自动填入；client 模块通道重启后叠加同守卫不重复执行）
      if (typeof web.tapIndex === 'function') {
        ctx.effect(() => web.tapIndex((html) => {
          if (!html || html.includes('/api/prompt-optimizer/client.js')) return html
          const tag = '<script id="dsh-po-client-script" src="/api/prompt-optimizer/client.js" defer></script>'
          return html.includes('</body>') ? html.replace('</body>', tag + '</body>') : html + tag
        }), 'prompt-optimizer: tapIndex autofill script')
      }
    }
    __poAppliedOk = true
  } catch (error) {
    __poWebErr = String((error && error.stack) || error).slice(0, 500)
  }
}
