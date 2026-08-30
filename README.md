# DSH AI 提示词优化器（Prompt Optimizer）

> 一个 [DeepSeek Harness](https://github.com/deepseek-ai)（`dsh web` / DSH Desktop）插件：把你**口语化、含糊、缺结构**的需求，一键转化成**结构清晰、逻辑严谨、可直接执行**的高质量提示词，并**自动填入会话输入框**——你不用手动复制粘贴。

---

## ✨ 它能做什么

- **一键优化**：在任意会话里输入 `/optimize 你的原始需求`，产出一份符合"八大板块"结构的专业提示词（角色定位 / 任务目标 / 输入材料 / 输出格式 / 内容要求 / 风格语气 / 约束排除 / 成功标准）。
- **自动填入输入框**：优化结果直接出现在下方的会话输入框里（输入框闪一下蓝光即代表成功），你可**直接发送或先编辑**，全程零手动复制。
- **上下文锚定**：当你的需求指代不明（"这个""它""继续"）时，它会先反问你 ≤3 个关键问题，而不是瞎猜。
- **迭代改写**：`/optimize revise 你的修改意见` 在上一版基础上增量修改，不用重来。
- **纯输出模式**：`/optimize --pure ...` 只回提示词本体，不带任何解释说明。
- **零密钥**：复用 DSH 自身已配置的模型路由（`ctx.llm`），插件**不碰任何 API Key**，不额外产生独立计费账号。

---

## 📈 预计收益（实用性说明）

> 以下为基于插件设计目标与日常使用经验的**预期性效果**，非对照基准测试；绝对幅度会随所用模型、任务类型和你原始描述的完整度而变化。

### 对模型输出：从"大概能用"到"精确可用"

| 机制 | 预期提升 |
|---|---|
| **八大板块结构化**（角色/目标/输入/格式/约束/成功标准…） | 把模型"猜意图"的自由度收敛到显式约束：显著减少答非所问、格式跑偏、漏要求；"成功标准"内置在提示词里，产物可对照验收，**首轮可用率上升** |
| **性能激发注入**（思维链引导 / 多角度拓展 / 边界加压） | 推理与创作类任务不易停在表面答案，一次产出更接近"人类返工一稿"后的质量，减少追改轮次 |
| **上下文锚定追问**（指代不明先问不猜） | 把"一次跑偏 = 事后 2~5 轮返工"变成"一个追问先对齐方向"，**避免整轮废稿的 token 与时间双浪费** |
| **迭代改写**（revise 增量修改） | 改一处不必重发整段，版本间差异可控，长提示词的维护成本大幅下降 |

### 对人力效率：从"学写提示词"到"说人话"

| 事项 | 手写高质量提示词 | 使用本插件 |
|---|---|---|
| 首次产出一份八板块提示词 | 10~30 分钟（熟悉套路者；新手需先学提示词工程，常以小时计） | **15~40 秒**（一行 `/optimize`） |
| 二次修改 | 整段回头找、手动改 | 一句 `/optimize revise 意见` |
| 交给下一步使用 | 选中 → 复制 → 切换窗口 → 粘贴 | **自动填入输入框**，直接发送 |
| 沉淀复用 | 散落在笔记/聊天记录 | 一句话存进提示词库，随时检索 |

**综合预计**：对"每天要和 AI 打交道的重度用户"（写方案、出大纲、提需求、编排 agent 任务），单次提示词准备的耗时从**分钟级压到秒级**；因方向跑偏产生的无效对话轮次明显减少——这两项在高频场景下是可以累积成每日节省数十分钟到小时级的复利。

### 成本几乎可忽略

一次优化的输入 = 规范全文（约 1.5k tokens）+ 你的需求原文，输出约 1~2k tokens。按主流按量计费的对话模型价格，**单次成本在几厘~一分钱量级**（以你 DSH 实际所配路由的计费为准；跟随主对话路由时无需任何额外配置与密钥）。

---

## 🧩 它是怎么接进 DSH 的（技术选型）

DSH 是"一切皆插件"的微内核 + Cordis 运行时。本插件作为 **Host + Client 双半插件**挂载：

| 通道 | 形态 | 作用 |
|---|---|---|
| `/optimize` 命令 | Host `commands.register` | 人在会话里用斜杠命令触发 |
| `optimize_prompt` 工具 | Host `tools.register` | Agent 判断"用户在求优化"时自动调用 |
| `promptOptimizer` 服务 | Host `ctx.provide` | 供其他插件 / 测试复用核心管线 |
| `/api/prompt-optimizer/*` 路由 + Client 半 | Host `webServer` + Client rider | 优化结果自动填入浏览器输入框（轮询 + 原生 setter） |

模型接入采用 **复用 DSH 内置 `ctx.llm` 路由**（而非网页版 DeepSeek 逆向 / 独立 API Key）——最稳定、零密钥管理、成本与主对话一致。设计缘由见文末「为何不接网页版 DeepSeek」。

---

## 📦 安装

前提：你有一个可运行的 DSH（`dsh web` 或 DSH Desktop），且环境里有 Node.js ≥ 18。

### 方式 A：本地插件目录 + 运行时注入（推荐，需 dsh-super-injector）

如果你装了 `dsh-super-injector`（很多 DSH 桌面版自带），这是最快的：

```bash
git clone https://github.com/xiaozuishuai-eng/prompt_optimize_dsh.git
cd prompt_optimize_dsh
# 把插件 import 的 @deepseek-ai/* 链接到你的 DSH 部署（脚本会自动探测常见路径；失败就手动传参）
node scripts/link-deps.cjs
#   手动指定：node scripts/link-deps.cjs "<你的DSH安装>/resources/dsh/node_modules"
```

然后在 DSH 里用注入器把本目录注入即可（`dev_inject_plugin` → 本插件绝对路径）。注入后**刷新一次页面**让 client 半的自动填入脚本生效。

### 方式 B：作为 bundle 装进 profile

把本仓库放进你 DSH profile 的 `node_modules`（或用 npm pack 安装），再在 profile 的 `cordis.patch.yml` 里追加：

```yaml
- insert:
    - id: prompt-optimizer
      name: 'dsh-prompt-optimizer'
      config: {}
```

重启 DSH（桌面版建议**彻底退出再打开**，以确保前端脚本重新加载）。

---

## ⚙️ 配置（可选，写进 patch 的 `config:`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `specPath` | 包内 `spec/prompt-engineer-spec.md` | 优化所依据的规范文档；**改成你自己的 .md 即可定制优化风格**，保存即热生效（mtime 缓存） |
| `provider` + `model` | 不设（跟随主对话路由） | 成对填写才覆盖，如 `provider: deepseek` + `model: deepseek-chat`；只填一个会被忽略 |
| `pure` | `false` | 设 `true` 后所有调用默认只输出提示词本体 |
| `autoFill` | `true` | 设 `false` 关闭"结果自动填入输入框"（仍会输出到聊天 / 工具返回） |
| `timeoutMs` | `90000` | 单次优化调用超时 |
| `maxInputChars` | `6000` | 原始输入长度上限（防超长/控成本） |

示例：

```yaml
- insert:
    - id: prompt-optimizer
      name: 'dsh-prompt-optimizer'
      config:
        specPath: 'D:/my-docs/my-prompt-spec.md'
        provider: 'deepseek'
        model: 'deepseek-reasoner'
```

---

## 🚀 使用（分享后可直接照做）

**入口 1 · 命令（最快）** —— 在 DSH 会话输入框里：
```
/optimize 帮我弄个提示词，让 AI 每周给我出一份行业新闻简报
```
约 15~40 秒后（视模型），提示词会**自动填入输入框** + 右下角弹提示；完整优化说明也可在聊天流里看到。

迭代修改：
```
/optimize revise 受众改成金融从业者，篇幅压到 300 字
```

只想要提示词本体：
```
/optimize --pure 帮我把这段需求写成提示词……
```

**入口 2 · 自然语言** —— 直接对会话说：
> 把下面这段话优化成一个高质量提示词：让 AI 帮我把简历润色一遍，我投产品经理岗

Agent 会自动调用 `optimize_prompt` 工具完成优化并填入输入框。

**入口 3 · 存入提示词库** —— 若你另装了 `dsh-prompt-library`，优化后说一句"存进提示词库"，即可用 `prompt_add` 归档，日后 `prompt_search` 找回。

> 💡 **草稿态（全新会话）注意**：在还没建会话的首页输入框里发 `/optimize`，插件会走自己的通道，直接把结果填进首页输入框，避免 harness 原生命令在草稿态卡死。若你的页面未加载到本插件脚本，请硬刷新（`Ctrl+Shift+R`）或重启 DSH。

---

## 🩺 排障 / 自检

- **只回"已受理"却不出结果**：多半是页面未加载自动填入脚本。在浏览器打开 `http://<你的DSH地址>/api/prompt-optimizer/status`，看 `pollers` 是否非空、`ageMs` 是否在几秒内；空则硬刷新页面。
- **结果没填进输入框**：确认 `autoFill` 未被关闭；确认输入框里**没有草稿**（有草稿时会弹"覆盖填入"按钮，不自动覆盖，防止吞掉你的内容）。
- **中文界面依赖**：自动填入靠识别输入框占位符（默认中文 UI："给智能体发消息" / "描述你想要构建的内容"），并有兜底策略（选取页面最靠下的可见 textarea）。若你用了非中文 UI 导致识别不准，可在 `lib/client-core.js` 的 `findComposer()` 里补充你的占位符。
- **优化风格不对**：改 `specPath` 指向你自己的规范文档即可，无需改代码。

---

## 🔒 隐私与安全

- 插件**不存储、不上传任何密钥**；模型调用全部走 DSH 已有的 `ctx.llm` 路由，密钥由 DSH 的 `credentials` 服务统一管理。
- 自动填入的脚本仅通过**同源** `/api/prompt-optimizer/*` 通信，不外发任何数据。
- 规范文档、会话内容均留在本地，不出你的 DSH 部署。

---

## 🗂️ 目录结构

```
prompt_optimize_dsh/
├─ lib/
│  ├─ index.js         # Host 半：命令 / 工具 / 服务 / HTTP 路由
│  ├─ prompt.js        # 纯函数层：请求组装、锚点协议解析、渲染、轻量质检
│  ├─ client.js        # Client 半：薄 rider，注入自动填入脚本
│  ├─ client-core.js   # 浏览器逻辑：草稿态拦截 + 轮询填入输入框 + toast/浮层
│  └─ spec-snapshot.js # 内置规范快照（外部规范不可读时兜底）
├─ spec/
│  └─ prompt-engineer-spec.md   # 默认优化规范（可自行替换）
├─ scripts/link-deps.cjs        # 运行时依赖链接（方式 A 用）
├─ cordis.patch.yml             # 自带 patch（bundle 安装用）
├─ package.json
└─ LICENSE
```

---

## 🧠 为何不接"网页版 DeepSeek"

最初评估过用 `chat.deepseek.com` 网页版做"免费"接入，但可行方案要么是浏览器自动化（登录态易失效、DOM 频繁变动、验证码/风控、违反服务条款），要么是第三方逆向封装 SDK（如 `deepseek-driver` / `deepseek-free-api`，属绕过网页端机制的非官方逆向，稳定性与合规风险都高）。因此本插件选择**复用 DSH 内置的官方 API 路由**这一最稳、零密钥、与主对话同成本的方案。

---

## 📄 License

MIT © xiaozuishuai-eng
