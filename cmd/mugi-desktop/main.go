// mugi's native desktop entry. The browser/server entry remains
// independent of native GUI dependencies and continues to build separately.
package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"

	"github.com/gin-gonic/gin"
	"github.com/wailsapp/wails/v3/pkg/application"
	"mugi/internal/adb"
	"mugi/internal/desktop"
	"mugi/internal/scrcpy"
	"mugi/internal/server"
	"mugi/web"
)

func main() {
	if err := run(); err != nil {
		reportStartupError(err)
		os.Exit(1)
	}
}

func run() (result error) {
	flag.Parse()
	gin.SetMode(gin.ReleaseMode)

	configDir, err := os.UserConfigDir()
	if err != nil {
		return err
	}
	configDir = filepath.Join(configDir, "mugi")
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		return err
	}
	if file, err := os.OpenFile(filepath.Join(configDir, "desktop.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600); err == nil {
		defer func() {
			if result != nil {
				log.Print(result)
			}
			_ = file.Close()
		}()
		log.SetOutput(file)
		gin.DefaultWriter = file
		gin.DefaultErrorWriter = file
	}
	adbSettings, err := desktop.NewADBSettings(configDir)
	if err != nil {
		return err
	}
	// An explicit desktop setting takes precedence over inherited environment
	// variables and portable distributions, including when launched from Finder.
	if path := adbSettings.Path(); path != "" {
		if err := os.Setenv("ADB", path); err != nil {
			return err
		}
	}
	// Support a portable distribution without changing the machine's PATH.
	if os.Getenv("ADB") == "" {
		executable, err := os.Executable()
		if err != nil {
			return err
		}
		adbName := "adb"
		if runtime.GOOS == "windows" {
			adbName = "adb.exe"
		}
		for _, relative := range []string{
			filepath.Join("platform-tools", adbName),
			adbName,
			filepath.Join("..", "Resources", "platform-tools", adbName),
		} {
			path := filepath.Join(filepath.Dir(executable), relative)
			if info, err := os.Stat(path); err == nil && !info.IsDir() {
				_ = os.Setenv("ADB", path)
				break
			}
		}
	}

	manager := scrcpy.NewManager()
	var backend server.DeviceBackend
	client, err := adb.New()
	if err == nil {
		adbSettings.SetStartupResult(client.Bin, nil)
		backend = scrcpy.NewAdbBackend(client, manager)
	} else {
		startupErr := fmt.Errorf("初始化设备后端失败：%w\n请在设置中指定 ADB 可执行文件路径并重启应用，或安装 Android Platform Tools 并加入 PATH。", err)
		adbSettings.SetStartupResult("", startupErr)
		log.Print(startupErr)
		backend = server.NewUnavailableBackend(startupErr)
	}
	handler := adbSettings.Handler(server.NewWithAccessMode(backend, manager, server.AccessLocal).Router(http.FS(web.Assets)))
	bridge, err := desktop.NewBridge(handler)
	if err != nil {
		return err
	}
	defer bridge.Close()
	assets, err := bridge.AssetHandler(web.Assets, handler)
	if err != nil {
		return err
	}
	options := application.Options{
		Name:        "mugi",
		Description: "Android 桌面工作台",
		Assets:      application.AssetOptions{Handler: assets},
		OnShutdown: func() {
			bridge.Close()
			sessions := manager.List()
			for _, session := range sessions {
				manager.Remove(session.ID)
			}
			for _, session := range sessions {
				session.Close()
			}
		},
	}
	configureApplication(&options, configDir)
	app := application.New(options)
	windowOptions := application.WebviewWindowOptions{
		Name:             "main",
		Title:            "mugi",
		Width:            1440,
		Height:           900,
		MinWidth:         960,
		MinHeight:        640,
		Frameless:        true,
		BackgroundColour: application.NewRGB(24, 24, 27),
	}
	configureWindow(&windowOptions)
	app.Window.NewWithOptions(windowOptions)
	return app.Run()
}
