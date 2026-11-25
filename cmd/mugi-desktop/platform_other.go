//go:build !windows && !darwin

package main

import "github.com/wailsapp/wails/v3/pkg/application"

func configureApplication(_ *application.Options, _ string) {}

func configureWindow(_ *application.WebviewWindowOptions) {}

func reportStartupError(err error) { println(err.Error()) }
