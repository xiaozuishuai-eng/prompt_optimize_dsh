/**
 * dsh-prompt-optimizer —— client 半（薄 rider，官方 client 通道）
 * 职责：会话挂载后确保自动填入脚本 <script src="/api/prompt-optimizer/client.js"> 存在
 * （逻辑本体在 lib/client-core.js，由 host 路由现读现发；tapIndex 通道负责免重启注入，
 * 两通道经 window.__dshPoAutoFill / 脚本 id 双守卫幂等去重）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-prompt-optimizer',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    let React = require('react')

    // 自愈式注入：boot 竞态下 /api/prompt-optimizer/client.js 可能短暂 404（插件路由未就绪），
    // 一次性 <script> 失败就永远不会再执行——故 onerror/超时宽限后重试，直至脚本守卫标记出现。
    let retryTimer = null
    let attempts = 0
    let foreignGrace = 0
    function scheduleRetry() {
      if (retryTimer || attempts > 60) return // ≈4 分钟宽限窗，之后靠会话挂载再驱动
      retryTimer = setTimeout(function () {
        retryTimer = null
        if (window.__dshPoAutoFill !== true) ensureClientScript()
      }, 4000)
    }
    function ensureClientScript() {
      if (typeof window === 'undefined' || window.__dshPoAutoFill === true) return
      attempts += 1
      const existing = document.getElementById('dsh-po-client-script')
      if (existing) {
        if (existing.dataset.poLive === '1') { scheduleRetry(); return } // 我们自己挂的还在加载：等
        if (foreignGrace === 0) { foreignGrace = 1; scheduleRetry(); return } // tapIndex 的标签：先给一轮宽限
        existing.remove() // 两轮仍未执行 = 死标签（404/卡死），换带重试钩子的
      }
      const s = document.createElement('script')
      s.id = 'dsh-po-client-script'
      s.dataset.poLive = '1'
      s.src = '/api/prompt-optimizer/client.js?try=' + attempts
      s.onerror = function () { s.remove(); scheduleRetry() }
      document.head.appendChild(s)
      scheduleRetry()
    }

    function AutoFillRider() {
      React.useEffect(() => {
        ensureClientScript()
      }, [])
      return null
    }

    exports.name = 'prompt-optimizer'
    exports.inject = ['slots']
    exports.apply = function (ctx) {
      // 模块一装载就立即注入脚本（boot 时 document 已存在；hero 无会话界面不依赖组件挂载）
      try { ensureClientScript() } catch { /* tapIndex 通道兜底 */ }
      ctx.effect(() => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'prompt-optimizer-autofill', order: 90, label: '提示词自动填入' },
        () => React.createElement(AutoFillRider, null),
      )), 'prompt-optimizer: autofill rider')
    }

    return module.exports
  },
})
