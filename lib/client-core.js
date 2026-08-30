// dsh-prompt-optimizer 自动填入核心（经典浏览器脚本，经 /api/prompt-optimizer/client.js 下发）
// ① 草稿/首页态拦截：hero 输入框 /optimize 前缀 + Enter → POST /api/prompt-optimizer/submit
//    （绕开 harness 命令链路在草稿态卡死吞会话的缺陷），失败自动把原文放回输入框。
// ② 轮询 /api/prompt-optimizer/latest，按 kind 分发：
//   fill    → 提示词本体填入输入框（空框直填+蓝脉冲；有草稿不覆盖，钉住通知给「覆盖填入」）；
//   clarify → 钉住通知展示锚定追问（规范步骤0 要求先补充再改写）；
//   error   → 钉住通知展示失败原因。
// 通知都可点「查看」打开完整结果浮层（修改说明等）。autoFill=false 时不填入但消费水位。
// 幂等守卫：tapIndex 与 client rider 双通道重复加载时第二次直接跳过。
;(function () {
  if (typeof window === 'undefined' || window.__dshPoAutoFill === true) return
  window.__dshPoAutoFill = true

  let lastSeq = -1 // 首轮只对齐水位，不把历史结果灌进刚打开的页面

  const findComposer = () => {
    const byPlaceholder = document.querySelector('textarea[placeholder="给智能体发消息"]')
    if (byPlaceholder && byPlaceholder.offsetParent !== null) return byPlaceholder
    const candidates = Array.prototype.slice.call(document.querySelectorAll('textarea')).filter(function (t) {
      return t.offsetParent !== null && !(t.closest && t.closest('#dshPromptLibPanel, #dshPromptLibModal, #dshPoOverlay'))
    })
    if (candidates.length === 0) return null
    return candidates.sort(function (a, b) { return b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom })[0]
  }

  const setComposerText = (ta, text) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, text)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  }

  const pulse = (el, shadow) => {
    try {
      el.style.transition = 'box-shadow .35s ease'
      el.style.boxShadow = shadow
      setTimeout(function () { el.style.boxShadow = '' }, 2600)
    } catch { /* 样式尽力而为 */ }
  }
  const fillComposer = (ta, text) => {
    setComposerText(ta, text)
    if (!document.hidden) ta.focus()
    pulse(ta, '0 0 0 2px rgba(77,107,254,.6)')
  }

  // ── 轻量 toast：可带多个动作按钮；sticky = 钉住（需决策的通知不自动消失）──
  let toastEl = null
  let toastTimer = null
  const hideToast = function () {
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null }
    if (toastEl) { toastEl.remove(); toastEl = null }
  }
  const toast = (msg, actions, sticky) => {
    hideToast()
    toastEl = document.createElement('div')
    toastEl.style.cssText = [
      'position:fixed', 'right:20px', 'bottom:76px', 'z-index:100002',
      'display:flex', 'align-items:center', 'gap:10px',
      'padding:10px 14px', 'border-radius:10px',
      'border:1px solid var(--dsw-alias-border-l2,#333)',
      'background:var(--dsw-alias-bg-overlay,#1b1b1f)',
      'color:var(--dsw-alias-label-primary,#eee)',
      'font:12px/1.5 system-ui', 'box-shadow:0 6px 24px rgba(0,0,0,.45)',
      'max-width:min(460px, calc(100vw - 40px))', 'pointer-events:auto',
    ].join(';')
    const span = document.createElement('span')
    span.textContent = msg
    toastEl.appendChild(span)
    for (const act of actions || []) {
      const btn = document.createElement('button')
      btn.textContent = act.label
      btn.style.cssText =
        'flex:none;border:1px solid var(--dsw-alias-brand-primary,#4d6bfe);color:var(--dsw-alias-brand-primary,#4d6bfe);background:transparent;border-radius:6px;padding:3px 8px;font:12px/1 system-ui;cursor:pointer'
      btn.addEventListener('click', function () {
        hideToast()
        try { act.onClick && act.onClick() } catch { /* 尽力而为 */ }
      })
      toastEl.appendChild(btn)
    }
    if (sticky) {
      const x = document.createElement('button')
      x.textContent = '✕'
      x.style.cssText = 'flex:none;border:none;background:transparent;color:var(--dsw-alias-label-tertiary,#888);font:12px/1 system-ui;cursor:pointer;padding:2px 4px'
      x.addEventListener('click', hideToast)
      toastEl.appendChild(x)
    } else {
      const schedule = function () { toastTimer = setTimeout(hideToast, 10000) }
      toastEl.addEventListener('mouseenter', function () { if (toastTimer) clearTimeout(toastTimer) })
      toastEl.addEventListener('mouseleave', schedule)
      schedule()
    }
    document.body.appendChild(toastEl)
  }

  // ── 完整结果浮层（修改说明/追问全文，可复制）──
  let overlayEl = null
  const hideOverlay = function () { if (overlayEl) { overlayEl.remove(); overlayEl = null } }
  const showFull = function (content) {
    if (overlayEl) hideOverlay()
    if (!content) return
    overlayEl = document.createElement('div')
    overlayEl.id = 'dshPoOverlay'
    overlayEl.style.cssText = [
      'position:fixed', 'right:20px', 'bottom:76px', 'z-index:100003',
      'display:flex', 'flex-direction:column',
      'width:min(560px, calc(100vw - 40px))', 'max-height:70vh',
      'border:1px solid var(--dsw-alias-border-l2,#333)', 'border-radius:12px',
      'background:var(--dsw-alias-bg-overlay,#1b1b1f)',
      'box-shadow:0 10px 36px rgba(0,0,0,.5)', 'overflow:hidden', 'pointer-events:auto',
    ].join(';')
    const head = document.createElement('div')
    head.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l2,#333);color:var(--dsw-alias-label-primary,#eee);font:600 13px/1 system-ui'
    const title = document.createElement('span')
    title.textContent = '优化结果全文'
    title.style.marginRight = 'auto'
    head.appendChild(title)
    const copy = document.createElement('button')
    copy.textContent = '复制全文'
    copy.style.cssText = 'border:1px solid var(--dsw-alias-brand-primary,#4d6bfe);color:var(--dsw-alias-brand-primary,#4d6bfe);background:transparent;border-radius:6px;padding:3px 8px;font:12px/1 system-ui;cursor:pointer'
    copy.addEventListener('click', function () { if (navigator.clipboard) navigator.clipboard.writeText(String(content)) })
    head.appendChild(copy)
    const x = document.createElement('button')
    x.textContent = '✕'
    x.style.cssText = 'border:none;background:transparent;color:var(--dsw-alias-label-tertiary,#888);font:13px/1 system-ui;cursor:pointer;padding:2px 6px'
    x.addEventListener('click', hideOverlay)
    head.appendChild(x)
    overlayEl.appendChild(head)
    const body = document.createElement('pre')
    body.textContent = String(content)
    body.style.cssText = 'margin:0;padding:12px;overflow:auto;color:var(--dsw-alias-label-primary,#ddd);font:12px/1.6 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-word'
    overlayEl.appendChild(body)
    document.body.appendChild(overlayEl)
  }

  let lastMissSeq = -1 // 未找到输入框时不吞投递：水位不推进，切到会话页自动补填
  let pollClientId = 'c-anon'
  try {
    pollClientId = sessionStorage.getItem('dshPoClientId') || ''
    if (!pollClientId) {
      pollClientId = 'c-' + Math.random().toString(36).slice(2, 10)
      sessionStorage.setItem('dshPoClientId', pollClientId)
    }
  } catch { /* 隐私模式退化 anon */ }

  // ── 草稿/首页态拦截：hero 输入框里以 /optimize 开头按 Enter → 不走 harness 命令链路
  //（实测：草稿态命令会让客户端卡死并吞掉会话），直接 POST /submit，结果走投递通道填回本框。
  let draftKey = 'anon'
  try {
    draftKey = sessionStorage.getItem('dshPoDraftKey') || ''
    if (!draftKey) {
      draftKey = 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
      sessionStorage.setItem('dshPoDraftKey', draftKey)
    }
  } catch { /* 隐私模式退化 anon */ }

  let submitting = false // pointerdown/mousedown/click 三连发只执行一次
  const heroSubmit = (target, line) => {
    if (submitting) return
    submitting = true
    setTimeout(function () { submitting = false }, 1500)
    const restore = function () {
      if (target.offsetParent !== null && target.value.trim() === '') setComposerText(target, line)
    }
    const attempt = function (n) {
      fetch('/api/prompt-optimizer/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ line: line, key: draftKey }),
        cache: 'no-store',
      }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        return r.json()
      }).then(function (d) {
        if (d && d.ok) {
          setComposerText(target, '')
          toast('⏳ 已受理：后台优化中（约 15~40 秒），完成后自动填入本输入框', null, false)
        } else {
          throw new Error(String((d && d.error) || 'rejected'))
        }
      }).catch(function (err) {
        if (n < 3) { setTimeout(function () { attempt(n + 1) }, 800); return }
        restore()
        toast('⚠️ /optimize 提交失败（' + String((err && err.message) || err) + '）——原文已放回输入框；若反复失败请刷新本页面（Ctrl+R）', null, true)
      })
    }
    attempt(0)
  }

  document.addEventListener('keydown', function (e) {
    try {
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return
      const target = e.target
      if (!target || target.tagName !== 'TEXTAREA' || target.offsetParent === null) return
      if (target.placeholder !== '描述你想要构建的内容') return // 会话视图：交给原生 /optimize 命令（聊天内联输出+填入双保险）
      const line = String(target.value || '').trim()
      if (!/^\/optimize(\s|$)/i.test(line)) return
      e.preventDefault()
      e.stopPropagation()
      heroSubmit(target, line)
    } catch { /* 拦截层异常绝不破坏页面 */ }
  }, true)

  // 同上的按钮路径防御：hero 态点「发送消息」且内容以 /optimize 开头 → 拦截改走提交通道。
  // ⚠️ 必须同时挂 pointerdown/mousedown 捕获（实测 app 在指针阶段就提交，click 捕获太晚）。
  const maybeInterceptSendClick = function (e) {
    try {
      const btn = e.target && e.target.closest ? e.target.closest('button') : null
      if (!btn) return
      const label = String(btn.getAttribute('aria-label') || btn.title || '')
      if (!label.includes('发送')) return
      const ta = findComposer()
      if (!ta || ta.placeholder !== '描述你想要构建的内容') return
      const line = String(ta.value || '').trim()
      if (!/^\/optimize(\s|$)/i.test(line)) return
      e.preventDefault()
      e.stopPropagation()
      heroSubmit(ta, line)
    } catch { /* 尽力而为 */ }
  }
  document.addEventListener('pointerdown', maybeInterceptSendClick, true)
  document.addEventListener('mousedown', maybeInterceptSendClick, true)
  document.addEventListener('click', maybeInterceptSendClick, true)

  const poll = async () => {
    let data
    try {
      const res = await fetch('/api/prompt-optimizer/latest?since=' + (lastSeq < 0 ? 0 : lastSeq) + '&id=' + pollClientId, { cache: 'no-store' })
      data = await res.json()
    } catch {
      return // 服务瞬断静默等下轮
    }
    if (!data || data.ok !== true) return
    if (lastSeq < 0) { lastSeq = data.seq; return }
    if (!(data.seq > lastSeq)) return

    const kind = data.kind || 'fill'
    const text = String(data.text || '')
    const full = String(data.full || '')

    if (kind === 'error') {
      lastSeq = data.seq
      toast('⚠️ ' + (text || '优化失败'), full ? [{ label: '查看', onClick: function () { showFull(full) } }] : null, true)
      return
    }
    if (kind === 'clarify') {
      lastSeq = data.seq
      const brief = text.length > 60 ? text.slice(0, 60) + '…' : text
      toast('❓ 需要补充前提（回答后重新 /optimize）：' + brief, [{ label: '查看', onClick: function () { showFull(full || text) } }], true)
      return
    }
    // fill
    if (data.autoFill !== true) { lastSeq = data.seq; return } // 开关关闭：消费但不填入
    if (!text) return
    const ta = findComposer()
    if (!ta) {
      if (data.seq !== lastMissSeq) {
        lastMissSeq = data.seq
        toast('⚠️ 当前页面没有会话输入框——切到会话页会自动填入', null, false)
      }
      return
    }
    lastSeq = data.seq
    if (ta.value.trim() === '') {
      fillComposer(ta, text)
      toast('✅ 已填入输入框（可直接发送，或先编辑）', [
        { label: '复制', onClick: function () { if (navigator.clipboard) navigator.clipboard.writeText(text) } },
        { label: '查看', onClick: function () { showFull(full || text) } },
      ], false)
    } else {
      pulse(ta, '0 0 0 2px rgba(212,160,23,.8)')
      toast('📥 结果已就绪——输入框有草稿，未覆盖', [
        { label: '覆盖填入', onClick: function () { const cur = findComposer() || ta; fillComposer(cur, text) } },
        { label: '查看', onClick: function () { showFull(full || text) } },
      ], true)
    }
  }

  setInterval(poll, 1500)
  poll()
})()
