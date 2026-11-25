#!/usr/bin/env node
// Builds a portable Windows desktop package on Windows, Linux or macOS.
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
let arch = 'amd64'
let platformTools
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--') continue
  if (args[i] === '--arch' && args[i + 1]) arch = args[++i]
  else if (args[i] === '--platform-tools' && args[i + 1]) platformTools = resolve(args[++i])
  else throw new Error(`未知参数：${args[i]}。可用：--arch amd64|arm64 --platform-tools <目录>`)
}
if (!['amd64', 'arm64'].includes(arch)) throw new Error('Windows 架构必须是 amd64 或 arm64')
if (platformTools) {
  for (const name of ['adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll']) {
    if (!existsSync(join(platformTools, name))) throw new Error(`Platform Tools 缺少 ${name}`)
  }
}

function run(command, commandArgs, env = process.env) {
  const result = spawnSync(command, commandArgs, { cwd: root, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} 执行失败（${result.status}）`)
}

// npm_execpath may point to a standalone pnpm ELF/EXE, not a JS file. Run
// installed frontend CLIs directly, without package-manager or shell assumptions.
const require = createRequire(import.meta.url)
function localCLI(packageName, binName) {
  const manifest = require.resolve(`${packageName}/package.json`)
  const { bin } = JSON.parse(readFileSync(manifest, 'utf8'))
  return resolve(dirname(manifest), typeof bin === 'string' ? bin : bin[binName])
}
run(process.execPath, [localCLI('typescript', 'tsc'), '-p', 'packages/web-adb/tsconfig.json'])
run(process.execPath, ['packages/web-adb/scripts/build.mjs'])
run(process.execPath, [localCLI('vue-tsc', 'vue-tsc'), '--noEmit', '-p', 'web/tsconfig.json'])
run(process.execPath, [localCLI('vite', 'vite'), 'build', '--config', 'web/vite.config.ts'])

const output = join(root, 'bin', `mugi-windows-${arch}`)
mkdirSync(output, { recursive: true })
const icon = join(root, 'build', 'windows', 'mugi.ico')
const syso = join(root, 'cmd', 'mugi-desktop', `rsrc_windows_${arch}.syso`)
if (existsSync(syso)) throw new Error(`资源文件已存在，不覆盖：${syso}`)

// Match the CLI to the pinned Go dependency instead of using an arbitrary global CLI.
const version = readFileSync(join(root, 'go.mod'), 'utf8').match(
  /github\.com\/wailsapp\/wails\/v3\s+(v\S+)/,
)?.[1]
if (!version) throw new Error('go.mod 未找到 Wails 3 版本')
try {
  run(
    'go',
    [
      'run',
      '-tags',
      'server',
      `github.com/wailsapp/wails/v3/cmd/wails3@${version}`,
      'generate',
      'syso',
      '-arch',
      arch,
      '-icon',
      icon,
      '-manifest',
      'build/windows/app.manifest',
      '-out',
      syso,
    ],
    // Resource generation does not need a GUI or Linux GTK/WebKit libraries.
    { ...process.env, CGO_ENABLED: '0' },
  )
  run(
    'go',
    [
      'build',
      '-tags',
      'production',
      '-trimpath',
      '-ldflags=-s -w -H windowsgui',
      '-o',
      join(output, 'mugi.exe'),
      './cmd/mugi-desktop',
    ],
    { ...process.env, GOOS: 'windows', GOARCH: arch, CGO_ENABLED: '0' },
  )
} finally {
  // Only remove the generated file; never touch other resource files/user work.
  if (existsSync(syso)) rmSync(syso)
}

for (const name of ['LICENSE', 'NOTICE']) cpSync(join(root, name), join(output, name))
cpSync(join(root, 'build/windows/README.txt'), join(output, 'README.txt'))
if (platformTools) {
  const destination = join(output, 'platform-tools')
  if (existsSync(destination)) throw new Error(`Platform Tools 目录已存在，不覆盖：${destination}`)
  cpSync(platformTools, destination, { recursive: true })
}
const archive = `${output}.zip`
run('go', ['run', './scripts/windows-assets.go', '-zip', archive, '-dir', output])
console.log(`Windows 桌面包：${archive}`)
