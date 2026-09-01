// 内置规范兜底（单一事实源）：规范内容只维护 spec/prompt-engineer-spec.md 一份，
// 本模块在运行时读取它；外部 specPath 不可读时优先落到包内规范，再兜底最小骨架。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const SPEC_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'spec', 'prompt-engineer-spec.md')

// 最小骨架兜底（仅在包内规范文件也缺失时启用，保证核心流程与红线不丢）
const MINIMAL_SPEC = [
  '# 角色设定',
  '你是专业提示词工程师，把用户模糊、口语化的需求转化为结构清晰、可精确执行的 AI 指令。',
  '',
  '# 核心规则',
  '- 补全判据：通用维度（格式/结构/长度等）可用合理默认但必须标注；用户专有上下文（指代对象/主题/受众等）禁止杜撰，阻断性歧义先追问（合计≤2轮），无法澄清则带假设降级。',
  '- 不得擅自删减用户显性要求；风险表述保持中性，不做道德评判。',
  '',
  '# 交付结构',
  '九板块提示词（角色定位/任务目标/输入材料/输出格式/内容要求/风格语气/约束排除/成功标准/性能激发指令），板块间以 --- 分隔；',
  '随附简短修改说明与「假设与待确认清单」（含未填写的 {{占位符}} 提示，交用户纠正）。',
].join('\n')

export function getBuiltinSpec() {
  try {
    const t = readFileSync(SPEC_FILE, 'utf8')
    if (t.trim().length >= 200) return t
  } catch { /* 包内规范缺失时回退最小骨架 */ }
  return MINIMAL_SPEC
}
