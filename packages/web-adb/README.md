# @mugi/web-adb

无需后端服务的浏览器 Android 设备管理 SDK，基于 WebUSB 和 `@yume-chan/adb`。
与 Vue、mugi HTTP API 和桌面运行时无关。

## 安装与环境

```sh
npm install @mugi/web-adb
```

运行环境需要 HTTPS 或 localhost，以及支持 WebUSB 的 Chrome / Edge。
手机必须开启 USB 调试；设备选择必须由用户点击触发。系统 ADB 或其他投屏工具可能占用 USB 接口。
投屏另外需要 WebCodecs；音频播放受浏览器用户手势策略约束。
这是浏览器 SDK，不提供 Node.js USB 传输或 SSR 设备操作。

## 连接与设备管理

```ts
import {
  connectWebUsb, createCredentialStore, operate, screenshot,
  openTerminal, openLogcat, readMetrics,
} from '@mugi/web-adb'

const credentials = createCredentialStore({
  storageKey: 'my-app.adb-key',
  name: 'my-app',
})

connectButton.addEventListener('click', async () => {
  const connection = await connectWebUsb(undefined, console.log, {
    credentialStore: credentials,
  })
  if (!connection) return // 用户取消设备选择

  console.log(connection.model, connection.serial)
  console.log(await connection.shell('getprop ro.build.version.release'))
  console.log(await connection.files('/sdcard/Download'))
  console.log(await connection.apps())
  await operate(connection, 'home')

  const controller = new AbortController()
  const png = await screenshot(connection, controller.signal)
  const snapshot = await readMetrics(connection, controller.signal)
  const logcat = await openLogcat(connection, controller.signal, console.log, console.log)
  const terminal = await openTerminal(
    connection, 24, 80, controller.signal,
    async (bytes) => { console.log(new TextDecoder().decode(bytes)) },
    console.log,
  )
  await terminal.write('pwd\n')
  terminal.close()
  logcat.close()
  await connection.close()
})
```

- `WebUsbConnection.available()` 检查浏览器环境；`disconnected` 在连接结束时完成。
- 文件能力：`files`、`upload`、`pull`、`createDirectory`、`transferFiles`、`renameFile`、`deleteFile(s)`。
  普通文件操作限制在 `/sdcard/` 下，`upload` 遇到 APK 会安装。
- 应用能力：`apps`、`install`，以及 `installAPKSet(connection, files, options, progress)`、
  `exportAPK(connection, packageName, index, signal)`。
  注入 `appIconSource`（返回包含 `dev.mugi.icons.Main` 入口的原始 DEX）后，
  `connection.appIcon(packageName, signal)` 可返回 PNG `Blob`；SDK 不内置该 DEX。
  `connection.appIconVersions(signal)` 返回可供宿主缓存使用的设备标识和软件包修订版本。
- 设备能力：`operate`、`screenshot`、`readMetrics`；对应解析函数也从主入口导出。
- `LogcatParser` 支持流式 UTF-8 解码，`filterLogcat`、`packagePids` 提供日志筛选。
- 所有设备级函数都显式接收连接实例；包不维护全局当前设备，不会访问 mugi 的后端接口。
- `close()` 可重复调用，会关闭投屏、终端和 Logcat。

默认凭据存储键为 `mugi.webusb.adb-key.v1`。
可以注入自己的 `CredentialStore`；`createCredentialStore({ storage: null })` 仅使用内存。
localStorage 不可用时自动退回内存，持久化私钥应遵循宿主应用的安全策略。

## scrcpy 投屏

```ts
import { WebUsbSession } from '@mugi/web-adb/scrcpy'

const session = new WebUsbSession(connection, {
  id: crypto.randomUUID(),
  opts: { mode: 'mirror', maxSize: 1600, audio: true },
}, canvas, {
  onError: console.error,
  onClipboard: (text) => console.log(text),
})
session.start()
// 结束时：await session.close()
```

`mode: 'display'` 可创建虚拟显示器，支持 width、height、dpi、startApp 等选项。
scrcpy 子入口还提供 `ControlEncoder`、`StreamParser`、`VideoPlayer`、`AudioPlayer` 和输入处理，
可供其他传输方式复用。仅导入主入口不会加载这些播放和输入模块。

包内含 scrcpy-server **4.1**，使用标准 `new URL(..., import.meta.url)` 加载静态资源。
支持该资源模式的打包器（如 Vite）会处理资源 URL。宿主必须部署生成的资源文件。
若打包器不支持此模式，或需要自定义资源位置，可在连接时注入：

```ts
const connection = await connectWebUsb(undefined, console.log, {
  serverSource: async () => {
    const response = await fetch('/assets/scrcpy-server-4.1.bin')
    if (!response.ok) throw new Error('Cannot load scrcpy-server')
    return new Uint8Array(await response.arrayBuffer())
  },
})
```

自定义二进制必须与包的 scrcpy 协议版本匹配。也可通过包导出的
`@mugi/web-adb/scrcpy-server.bin` 获取资源。许可证与来源见 `LICENSE`、`NOTICE`。

## 仓库内开发与打包

```sh
npm ci
npm run build --workspace @mugi/web-adb
npm run test --workspace @mugi/web-adb
npm pack --workspace @mugi/web-adb --dry-run
npm run test:package
```

也可将此目录单独复制出来，安装开发依赖后运行 `npm run build` / `npm test`。
构建只读取包内 `assets/`，不依赖仓库的 `web/` 或 `internal/`。
发布产物包含 ESM、类型声明、命令资源和 server，不需要 Vite 专属的 `?raw` / `?url` 导入。

包源码修改后需要重新执行包构建；应用的 `npm run dev` 会在启动前构建包。
`assets/` 中的命令和 server 与 Go 后端共用协议，升级时应同步更新 `internal/`；
仓库内测试会检查两者一致性及 server SHA-256。
