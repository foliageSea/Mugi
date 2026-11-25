<p align="center">
  <img src="web/public/mugi.svg" alt="Mugi 应用图标" width="112" height="112">
</p>
<h1 align="center">Mugi</h1>
<p align="center">
  <a href="https://github.com/foliageSea/Mugi/releases/latest"><img src="https://img.shields.io/github/v/release/foliageSea/Mugi?style=plastic&amp;color=orange" alt="最新发布版本"></a>
  <a href="https://github.com/foliageSea/Mugi/actions/workflows/release.yml"><img src="https://img.shields.io/github/actions/workflow/status/foliageSea/Mugi/release.yml?style=plastic&amp;logo=github&amp;label=build" alt="发布构建状态"></a>
  <a href="#桌面版"><img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux%20(Web)-9f9f9f?style=plastic" alt="平台：Windows 和 macOS 桌面版，Linux Web 服务"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue?style=plastic" alt="Apache License 2.0"></a>
</p>
<p align="center">开源 Android 工作台 · 屏幕镜像、多窗口投屏、文件与设备管理</p>
<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#桌面版">桌面版</a> ·
  <a href="#docker-部署">Docker 部署</a> ·
  <a href="#开发与测试">开发与测试</a> ·
  <a href="#发版">发版</a>
</p>

Mugi 让你在浏览器或桌面应用中操作 Android 设备。两种连接方式都在手机上运行 scrcpy-server，由工作台使用 WebCodecs 解码画面。

## 快速开始

先在手机的「开发者选项」中开启 **USB 调试**；通过 Wi-Fi 连接时则开启「无线调试」。使用 USB 连接时，请用支持数据传输的线缆，并在手机上允许调试授权。

| 连接方式 | 适用场景 | 运行依赖 |
| --- | --- | --- |
| [系统 ADB](#系统-adb) | USB 或无线调试；设备连接到运行 Mugi 的主机 | 主机安装 Android Platform Tools；浏览器支持 WebCodecs，推荐新版 Chrome / Edge |
| [WebUSB](#webusb-直连) | 设备通过 USB 连接到浏览器所在电脑；可纯静态部署 | 新版 Chrome / Edge；不需要 Go 服务或系统 ADB |

从源码构建需要 Node.js 22.12+（22.x）或 24+，推荐用 `nvm use` 选择 [`.nvmrc`](.nvmrc) 指定的版本。构建 Go 服务或桌面版还需要 Go 1.25+。音频转发需要 Android 11+，建议使用 Android 14+。

### 系统 ADB

先安装 [Android Platform Tools](https://developer.android.com/tools/releases/platform-tools)，确认 `adb version` 可用，再在仓库根目录执行：

```bash
npm ci
npm run build
go run ./cmd/mugi
```

1. 打开 <http://localhost:8080>，从右上角的「连接设备」入口选择设备。
2. 点击「镜像屏幕」，或打开启动器搜索应用，将应用投到独立窗口。

无线调试可在「连接设备」中完成。**配对端口和连接端口通常不同**：配对使用手机「使用配对码配对设备」页面显示的端口，连接使用无线调试主页面显示的端口。浏览器若记住了其他连接模式，可用 <http://localhost:8080/?transport=adb> 直接进入系统 ADB 模式。

要断开无线 ADB 设备，在「USB / 已连接」列表中点击该设备旁的「断开」，离线条目也可以移除。如果该设备正在投屏，请先关闭它的投屏窗口。断开有线 ADB 设备请拔掉 USB 数据线。

### WebUSB 直连

```bash
npm ci
npm run build
npm run preview -- --host 127.0.0.1 --port 4173
```

1. 用 Chrome / Edge 打开 <http://127.0.0.1:4173/?transport=webusb>。
2. 将手机接到**浏览器所在电脑**，点击右上角设备入口 →「WebUSB 直连」→「选择 USB 设备」。
3. 在浏览器中选中手机，然后在手机上确认调试授权。

`web/dist` 已包含匹配的 scrcpy-server，可整体部署到 HTTPS 静态站点。`?transport=webusb` 会跳过 Go API；浏览器按站点保存 ADB 密钥，清除站点数据后需要重新授权。WebUSB 不支持无线调试，页面关闭后会话结束，断线后需重新选择 USB 设备。

**设备被占用？** 系统 ADB 和 WebUSB 不能同时占用同一个 USB 接口。先关闭其他投屏工具，再在浏览器所在电脑执行 `adb kill-server`。设备面板的「释放系统 ADB」停止的是 **Go 服务所在主机**的 ADB server，会影响该主机的所有 ADB 客户端；有 Mugi 投屏会话时不会执行。Windows 如无法识别设备，请检查 USB 驱动；Linux 请检查 USB/udev 权限。

## 工作台功能

| 功能 | 可执行的操作 |
| --- | --- |
| **屏幕镜像与应用多窗口** | 触摸、鼠标、键盘、剪贴板同步、音频转发和截图。每个应用可在独立虚拟显示中运行，同一应用最多一个窗口。 |
| **应用启动器与管理** | 搜索并启动应用；按需显示真实图标，读取失败时显示占位图标。应用管理还支持查看版本和权限、强制停止、启停、清除数据、卸载及导出 base / split APK。 |
| **文件管理** | 浏览、搜索、排序、上传下载、新建、重命名、删除，以及图片和视频预览。 |
| **APK 安装** | 选择或拖入单个 APK、批量安装多个独立 APK，或将同一应用的 base / split APK 一起安装。 |
| **设备与性能** | 查看 Android 版本、电量、温度、存储空间，以及 CPU、内存和手机网络速率；通过顶栏控制中心调整亮度、音量、屏幕或网络状态。 |
| **终端与日志** | 交互式 Android 终端支持控制键、补全和尺寸同步；Logcat 可按级别、PID、包名和关键词筛选，并复制或导出日志。 |

### 投屏与窗口

- `Cmd/Ctrl + K` 打开启动器，`Cmd/Ctrl + Shift + M` 最小化当前窗口。点击 Dock 中的图标恢复窗口；双击标题栏或点击绿色按钮可放大或还原。
- 镜像分辨率按电脑屏幕尺寸和像素密度调整。手机锁定时需先解锁；默认在投屏首帧后自动息屏，结束后恢复亮屏。可在「设置 → 自动息屏」中更改后续新建窗口的行为。
- 同一设备默认只有一个窗口启用音频。切换音频会短暂重连，窗口的位置和大小会保留。系统 ADB 投屏支持自动重连，Go 服务为断开的会话保留 90 秒；WebUSB 会话不会跨页面关闭恢复。

### 文件、APK 与设备操作

- 文件拖到投屏窗口会上传至 `/sdcard/Download`。系统 ADB 模式在 Chromium 中支持从文件面板拖出下载；WebUSB 请用下载按钮，大文件下载与媒体预览会先将完整文件读入内存。
- 剪贴板同步受浏览器权限和安全上下文限制。可直接向窗口粘贴，也可用投屏工具栏的复制按钮读取手机剪贴板。
- APK 安装默认覆盖更新并保留数据。安装 Split APK 时须选齐分包；APKS/XAPK 需先解包。一次最多选择 128 个 APK，系统 ADB 的单次安装请求上限为 2 GiB；WebUSB 单个 APK 导出上限为 512 MB。
- 应用管理操作仅针对当前 Android 用户；清除数据、卸载和停用前会确认。设备控制与性能指标的可用性取决于 Android 版本和厂商权限。

## 桌面版

[GitHub Releases](https://github.com/foliageSea/Mugi/releases) 提供 Windows x64（`amd64`）和 macOS Apple Silicon（`arm64`）桌面版；Windows ARM64 和 Intel Mac 可从源码自行构建。两者均使用 Wails 3，内嵌前端和 scrcpy-server，无需另开浏览器或启动 Web 服务。桌面版建议使用系统 ADB；需要 WebUSB 时，请使用 Chrome / Edge 打开 Web 版。

### Windows

支持 Windows 10/11，需要 [WebView2 Evergreen Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) 和 Windows 版 Platform Tools。交互式终端需要 Windows 10 1809 或更新版本。

```bash
npm ci
npm run build:windows
# ARM64 Windows
npm run build:windows -- --arch arm64
# 随包附带 Windows 版 Platform Tools
npm run build:windows -- --platform-tools "C:/Android/platform-tools"
```

可在 Windows、Linux 或 macOS 上构建，无需 C 编译器。默认生成 `bin/mugi-windows-amd64/mugi.exe` 和 `bin/mugi-windows-amd64.zip`；解压 ZIP 后运行 `mugi.exe`。随包附带的 Platform Tools 目录需包含 `adb.exe` 和两个 ADB DLL，请保留原许可；脚本不会覆盖旧的随包 `platform-tools` 目录。日志及 WebView2 数据保存在 `%APPDATA%/mugi`。

### macOS

在 macOS 上构建，需要 Xcode Command Line Tools 和 `ditto`；跨架构构建还需要 C 工具链支持目标架构。

```bash
npm ci
npm run build:macos
# 指定架构并额外生成 DMG（arm64 为 Apple Silicon，amd64 为 Intel）
npm run build:macos -- --arch arm64 --dmg
```

默认按当前架构生成 `bin/mugi-macos-<架构>/mugi.app` 和 `bin/mugi-macos-<架构>.zip`。可追加 `--platform-tools <目录>`，把包含 macOS 版 `adb` 的目录放入应用包。Release 提供 Apple Silicon 版 ZIP 和 DMG，未做 Apple 公证；打开自己构建或从 Release 下载的应用时，若被 Gatekeeper 拦截，可在「系统设置 → 隐私与安全性」中允许打开。

### 配置 ADB 路径

在「设置 → ADB 可执行文件路径」中填写 `adb` 或 `adb.exe` 的绝对路径。保存时会运行 `adb version` 校验，完全退出并重开应用后生效。显式设置优先于 `ADB` 环境变量、随包分发的 Platform Tools 和系统 `PATH`。macOS 从 Finder 启动时不一定继承终端的 `PATH`，可在终端运行 `command -v adb` 查找路径。

## Docker 部署

需要 Docker Engine / Docker Desktop 和 Docker Compose v2。镜像包含前端、Go 服务和 `adb`。

### 拉取已发布镜像

从 [GitHub Releases](https://github.com/foliageSea/Mugi/releases) 选一个版本标签，替换以下示例里的 `v0.1.0`。GitHub Packages 上的镜像包含 `linux/amd64` 和 `linux/arm64`，Docker 会自动选择对应架构。

```bash
docker pull ghcr.io/foliagesea/mugi:v0.1.0
```

使用 Compose 部署时，复制 `.env.example` 为 `.env`（已有则保留），并设置 `MUGI_IMAGE=ghcr.io/foliagesea/mugi:v0.1.0`，然后执行：

```bash
docker compose pull
docker compose up -d --no-build
```

公开包可匿名拉取。若提示无权访问，先确认包是否已发布；私有包需要有包读取权限的 GitHub 账号，通过 `docker login ghcr.io` 使用至少带 `read:packages` 权限的 classic PAT 登录。

### 从源码构建镜像

不设置 `MUGI_IMAGE` 时，Compose 使用本地镜像名 `mugi:local`：

```bash
cp .env.example .env
docker compose up -d --build
```

默认访问 <http://localhost:8080>。配置项见 [`.env.example`](.env.example)：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MUGI_BIND` | `127.0.0.1` | 宿主机监听地址；局域网访问可设为 `0.0.0.0` |
| `MUGI_PORT` | `8080` | 宿主机端口 |
| `MUGI_IMAGE` | `mugi:local` | 可设为 GHCR 的版本镜像地址 |
| `MUGI_TLS` | `false` | 设为 `true` 启用 HTTPS；容器内端口仍为 8080 |
| `MUGI_ACCESS_MODE` | `auto` | `auto` 根据客户端 IP 判断；`local` 允许系统 ADB；`external` 仅允许 WebUSB |

### 连接设备

- **无线 ADB**：在工作台输入手机的局域网 IP 与配对或连接端口。容器必须能够访问手机。
- **WebUSB**：打开 <http://localhost:8080/?transport=webusb>，将手机接到浏览器所在电脑，不需要给容器映射 USB。
- **Linux 宿主机 USB ADB**：用附加配置映射 USB 总线并支持热插拔。之后管理该部署也应带上相同的两个 `-f` 参数。Docker Desktop 用户建议选无线 ADB 或 WebUSB。

  ```bash
  docker compose -f compose.yaml -f compose.usb.yaml up -d --build
  ```

  使用已发布镜像时，先拉取镜像，再把上面的 `--build` 换成 `--no-build`。

### 局域网、HTTPS 与数据卷

- 局域网访问可将 `MUGI_BIND` 设为 `0.0.0.0`、`MUGI_PORT` 设为 `8443`、`MUGI_TLS` 设为 `true`，再运行 `docker compose up -d`，使用 HTTPS 访问。直接运行二进制时可用 `./bin/mugi -addr 0.0.0.0:8443 -tls`，默认证书目录为 `~/.mugi`。
- WebCodecs、WebUSB 和剪贴板在非回环地址上需要安全上下文。自签名证书需要浏览器信任；也可将含有 `cert.pem` 和 `key.pem` 的目录挂载到容器的 `/root/.mugi`，或让支持 WebSocket 升级的反向代理终止 HTTPS，此时容器内保持 `MUGI_TLS=false`。
- Mugi **没有账户认证，请勿直接暴露到公网**。`auto` 模式将回环、私有和链路本地地址视为内网；若 frpc 等 TCP 代理隐藏客户端地址，需要显式使用 `MUGI_ACCESS_MODE=external` 限制为 WebUSB。
- Compose 命名卷保存 TLS 证书、ADB 授权密钥和应用图标缓存。`docker compose logs -f` 查看日志，`docker compose down` 停止服务；加 `-v` 会删除这些卷。

### 离线导出镜像

可用 [镜像导出脚本](scripts/docker-build-export.sh) 在 ARM 等主机上通过 Docker Buildx 构建并导出 `linux/amd64` 镜像，再将生成的文件复制到目标机导入：

```bash
./scripts/docker-build-export.sh
# 在目标机器执行
docker load --input ./mugi-amd64.tar
```

## 开发与测试

```bash
npm ci
make dev    # 同时启动 Go 后端和 Vite
make test   # 构建前端，运行 Go 与 JavaScript 测试
make build  # 生成 bin/mugi
```

开发页面为 <http://127.0.0.1:5173>；在 [开发脚本](scripts/dev.sh) 中按 `r` 重启服务，按 `q` 退出。也可在构建前端后分别运行 `go run ./cmd/mugi -addr 127.0.0.1:18080` 和 `npm run dev`，Vite 会代理 `/api` 与 `/ws`。直接运行 `go test ./...` 或 `go build` 前需先生成 `web/dist`。可通过 `MUGI_BUILD_OUTPUT` 自定义二进制输出路径。

```bash
npm run typecheck
npm run format:check
npm run test:package
npx playwright install chromium
npm run test:e2e
```

浏览器回归测试使用模拟 API，无需连接手机。完整的音视频、输入、剪贴板和厂商兼容性仍需在设备上验证。

### 项目结构

| 路径 | 职责 |
| --- | --- |
| [`web/src`](web/src) | Vue 3、TypeScript、Vite 和 Tailwind CSS 4 工作台 |
| [`cmd/mugi`](cmd/mugi) / [`cmd/mugi-desktop`](cmd/mugi-desktop) | Web 服务和 Wails 桌面版入口 |
| [`internal`](internal) | Go ADB、scrcpy 会话、HTTP/WebSocket 服务和桌面桥接 |
| [`@mugi/web-adb`](packages/web-adb/README.md) | 独立 WebUSB ADB SDK，提供 ESM、类型声明和 scrcpy 子入口 |
| [`web/tests`](web/tests) | Playwright 浏览器交互回归测试 |

系统 ADB 模式下，浏览器通过 HTTP 和 WebSocket 与 Go 服务通信，Go 服务再通过 ADB 连接设备。WebUSB 模式由浏览器通过 Tango ADB 直连设备，不经过后端。两者使用 scrcpy 4.1；升级嵌入的服务端时需同步更新客户端协议解析器。SDK 修改后可用 `npm run build:packages` 重建，或用 `npm test --workspace @mugi/web-adb` 单独测试。

[应用图标源文件](web/public/mugi.svg) 同时用于本 README 和浏览器标签页。修改后运行 `npx playwright install chromium` 和 `node scripts/generate-app-icons.mjs` 可同步生成 Windows 与 macOS 图标。启动器显示的则是手机应用的图标：两种连接方式均使用内嵌的 [DEX 提取工具](internal/adb/app-icons/README.md)，无需安装 helper APK。

## 发版

首次发版前，先将发布工作流合入仓库默认分支。维护者在仓库根目录操作，需要 Git、Node.js 和已登录的 GitHub CLI（`gh auth login`）。先用[发版脚本](scripts/release.sh)更新项目版本，检查并提交改动；将当前分支推送到 `origin` 后，再从干净的工作区发布该提交：

```bash
./scripts/release.sh --prepare v0.2.0
git diff
git add package.json package-lock.json build/windows/app.manifest
git commit -m "chore: release v0.2.0"
git push origin HEAD
./scripts/release.sh v0.2.0
```

`--prepare` 同步应用版本以及 npm 锁文件与 Windows 清单中的版本，不提交、不推送；macOS 构建读取应用版本的数字部分。`@mugi/web-adb` SDK 独立维护版本。发版脚本默认生成发行说明，可用 `--notes` 或 `--notes-file` 覆盖；`v0.2.0-rc.1` 形式会发布为预发行版。发版需使用有仓库写权限的 GitHub 凭据；Actions 自动生成的 `GITHUB_TOKEN` 不会触发后续 Release 工作流。

[发布工作流](.github/workflows/release.yml) 在发布 Release 后检出对应标签，将带版本号的 Windows `amd64`、macOS `arm64`、Linux 双架构 Web 服务和 WebUSB 静态站点构建产物及 SHA-256 校验文件上传到同一 Release，并把同名版本标签的多架构镜像推到 `ghcr.io/foliagesea/mugi`。仅推 Git 标签不会触发。仓库需关闭 Release 不可变设置，否则工作流无法向已发布的 Release 追加附件。首次发布后如需匿名拉取，请在 GitHub Packages 的包设置中将镜像设为公开。

## 许可证

Mugi 采用 [Apache License 2.0](LICENSE)。内嵌的 scrcpy-server 来自 [Genymobile/scrcpy](https://github.com/Genymobile/scrcpy)，同样采用 Apache License 2.0。第三方声明见 [NOTICE](NOTICE)。
