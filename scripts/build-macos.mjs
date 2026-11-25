#!/usr/bin/env node
// Builds a macOS Wails application bundle on macOS.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') {
  throw new Error('macOS 桌面包必须在 macOS 上构建')
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Apple bundle versions require numeric components, even for prereleases.
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const bundleVersion = version?.split('-', 1)[0]
if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(bundleVersion)) {
  throw new Error('package.json 需要有效的项目版本号')
}
const args = process.argv.slice(2)
const defaultArch = process.arch === 'arm64' ? 'arm64' : 'amd64'
let arch = defaultArch
let platformTools
let createDmg = false
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--') continue
  if (args[i] === '--arch' && args[i + 1]) arch = args[++i]
  else if (args[i] === '--platform-tools' && args[i + 1]) platformTools = resolve(args[++i])
  else if (args[i] === '--dmg') createDmg = true
  else
    throw new Error(`未知参数：${args[i]}。可用：--arch arm64|amd64 --platform-tools <目录> --dmg`)
}
if (!['amd64', 'arm64'].includes(arch)) throw new Error('macOS 架构必须是 amd64 或 arm64')
if (platformTools && !existsSync(join(platformTools, 'adb'))) {
  throw new Error(`Platform Tools 缺少 adb：${platformTools}`)
}

function run(command, commandArgs, env = process.env) {
  const result = spawnSync(command, commandArgs, { cwd: root, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} 执行失败（${result.status}）`)
}

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

const output = join(root, 'bin', `mugi-macos-${arch}`)
const app = join(output, 'mugi.app')
const contents = join(app, 'Contents')
const resources = join(contents, 'Resources')
const executable = join(contents, 'MacOS', 'mugi')
if (existsSync(output)) rmSync(output, { recursive: true, force: true })
mkdirSync(join(contents, 'MacOS'), { recursive: true })
mkdirSync(resources, { recursive: true })
cpSync(join(root, 'build', 'macos', 'mugi.icns'), join(resources, 'mugi.icns'))

const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>mugi</string>
  <key>CFBundleExecutable</key>
  <string>mugi</string>
  <key>CFBundleIdentifier</key>
  <string>com.mugi.desktop</string>
  <key>CFBundleName</key>
  <string>mugi</string>
  <key>CFBundleIconFile</key>
  <string>mugi.icns</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${bundleVersion}</string>
  <key>CFBundleVersion</key>
  <string>${bundleVersion}</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`
writeFileSync(join(contents, 'Info.plist'), infoPlist)

run(
  'go',
  [
    'build',
    '-tags',
    'production',
    '-trimpath',
    '-ldflags=-s -w',
    '-o',
    executable,
    './cmd/mugi-desktop',
  ],
  { ...process.env, GOOS: 'darwin', GOARCH: arch, CGO_ENABLED: '1' },
)
if (platformTools) cpSync(platformTools, join(resources, 'platform-tools'), { recursive: true })
for (const name of ['LICENSE', 'NOTICE']) cpSync(join(root, name), join(output, name))
writeFileSync(
  join(output, 'README.txt'),
  'mugi macOS 桌面版\n\n首次运行请在“系统设置 → 隐私与安全性”中允许应用打开。\n',
)

const archive = `${output}.zip`
run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive])
if (createDmg) {
  run('hdiutil', [
    'create',
    '-volname',
    'mugi',
    '-srcfolder',
    app,
    '-ov',
    '-format',
    'UDZO',
    `${output}.dmg`,
  ])
}
console.log(`macOS 桌面包：${archive}${createDmg ? `、${output}.dmg` : ''}`)
