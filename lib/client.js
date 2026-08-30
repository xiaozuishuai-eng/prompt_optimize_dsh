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

    function ensureClientScript() {
      if (document.getElementById('dsh-po-client-script')) return
      const s = document.createElement('script')
      s.id = 'dsh-po-client-script'
      s.src = '/api/prompt-optimizer/client.js'
      document.head.appendChild(s)
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
