package main

import (
	"log"

	"github.com/wailsapp/wails/v3/pkg/application"
)

func configureApplication(options *application.Options, _ string) {
	options.Mac = application.MacOptions{
		ApplicationShouldTerminateAfterLastWindowClosed: true,
	}
}

func configureWindow(options *application.WebviewWindowOptions) {
	options.MinimiseButtonState = application.ButtonHidden
	options.MaximiseButtonState = application.ButtonHidden
	options.FullscreenButtonState = application.ButtonHidden
	options.CloseButtonState = application.ButtonHidden
	options.Mac = application.MacWindow{
		CornerType:   application.MacWindowCornerTypeRounded,
		CornerRadius: 10,
		TitleBar:     application.MacTitleBarHidden,
	}
}

func reportStartupError(err error) {
	log.Printf("mugi 启动失败: %v", err)
}
