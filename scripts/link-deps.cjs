// 运行时依赖 junction 链接（仅"超级注入器免重启安装"方式需要；正式 bundle 安装无需本脚本）。
// 把插件 import 的 @deepseek-ai/* 包链接到 DSH 部署的 node_modules，使 Node 能解析它们。
//
// 用法：
//   node scripts/link-deps.cjs "<DSH 的 node_modules 绝对路径>"
//   或设环境变量 DSH_MODULES=<路径> 后运行 node scripts/link-deps.cjs
//   不带参数时会尝试自动探测（见下）。
//
// 依赖变更后重跑即可（幂等）。
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const root = path.resolve(__dirname, '..')
const deps = ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-llm']

function looksLikeModulesDir(dir) {
  try {
    return !!dir && fs.existsSync(path.join(dir, '@deepseek-ai', 'dsh-tools'))
  } catch {
    return false
  }
}

// 候选：命令行参数 > 环境变量 > 常见部署位置（桌面版 resources/dsh、home 下 .dsh 等）
const argv = process.argv[2]
const candidates = [
  argv,
  process.env.DSH_MODULES,
  process.env.DSH_CHECKOUT && path.join(process.env.DSH_CHECKOUT, 'node_modules'),
  process.env.DSH_CHECKOUT,
  path.join(os.homedir(), '.dsh', 'node_modules'),
  // 常见 DSH Desktop 安装位置（可按需自行补充）
  ...['C:', 'D:', 'E:'].flatMap((drive) => [
    path.join(drive, os.sep, 'Program Files', 'dsh-desktop', 'resources', 'dsh', 'node_modules'),
    path.join(drive, os.sep, 'dsh-desktop', 'dist', 'win-unpacked', 'resources', 'dsh', 'node_modules'),
  ]),
]
const target = candidates.find(looksLikeModulesDir)
if (!target) {
  console.error('未找到 DSH 的 node_modules。请显式传入路径：node scripts/link-deps.cjs "<DSH部署>/node_modules"')
  process.exit(1)
}
console.log('DSH modules:', target)

for (const rel of deps) {
  const src = path.join(target, rel)
  if (!fs.existsSync(src)) {
    console.error('缺少依赖包:', src)
    process.exit(1)
  }
  const linkPath = path.join(root, 'node_modules', rel)
  fs.mkdirSync(path.dirname(linkPath), { recursive: true })
  fs.rmSync(linkPath, { recursive: true, force: true })
  fs.symlinkSync(src, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  console.log('linked', rel)
}
console.log('deps linked ok')
