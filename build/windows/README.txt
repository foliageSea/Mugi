mugi Windows 桌面版

解压完整目录后双击 mugi.exe。支持 Windows 10/11，需要 Microsoft Edge WebView2 Evergreen Runtime。
Windows 11 与多数 Windows 10 已预装；如缺失，请从微软官网安装：
https://developer.microsoft.com/microsoft-edge/webview2/

本机需安装 Android Platform Tools 并将 adb 加入 PATH，或将完整的 Windows platform-tools
目录放在 mugi.exe 旁。也可通过环境变量 ADB 指定 adb.exe 的绝对路径。
Platform Tools 官方下载：https://developer.android.com/tools/releases/platform-tools
附带 Platform Tools 的发行包还须遵守其随附许可，不属于 mugi 的 Apache 2.0 许可。

开启手机 USB 调试并允许电脑授权，或在应用内使用无线调试配对。
标题栏空白区域可拖动、双击最大化/还原；右上角按钮控制整个桌面应用。
关闭应用会停止投屏和日志会话，不会停止其他程序共享的 ADB server。

日志与 WebView2 数据：%APPDATA%\mugi
Windows 系统 ADB 交互式终端使用 ConPTY，需要 Windows 10 1809 或更新版本；WebUSB 在 WebView2 中的可用性取决于运行时，
建议使用系统 ADB。需要 WebUSB 时请使用 Chrome/Edge 的 Web 版本。

此桌面版使用 Wails 3 beta；Windows 原生窗口、USB 和音视频需在目标机器验证。
