package main

import (
	"path/filepath"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
	"golang.org/x/sys/windows"
)

func configureApplication(options *application.Options, configDir string) {
	options.Windows = application.WindowsOptions{
		WebviewUserDataPath: filepath.Join(configDir, "WebView2"),
	}
}

func configureWindow(options *application.WebviewWindowOptions) {
	options.Windows = application.WindowsWindow{
		Theme: application.Dark,
		// Keep native resize edges, shadows and Windows 11 rounded corners.
		DisableFramelessWindowDecorations: false,
	}
}

func reportStartupError(err error) {
	title, _ := windows.UTF16PtrFromString("mugi 启动失败")
	message, _ := windows.UTF16PtrFromString(err.Error())
	_, _, _ = windows.NewLazySystemDLL("user32.dll").NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(message)), uintptr(unsafe.Pointer(title)), 0x10)
}
