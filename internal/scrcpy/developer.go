package scrcpy

import (
	"context"
	"io"

	"mugi/internal/adb"
)

func (b *AdbBackend) Metrics(ctx context.Context, serial string) (string, error) {
	return b.Adb.Metrics(ctx, serial)
}

func (b *AdbBackend) OpenTerminal(serial string, rows, cols uint16) (adb.Terminal, error) {
	return b.Adb.OpenTerminal(serial, rows, cols)
}

func (b *AdbBackend) OpenLogcat(ctx context.Context, serial string) (io.ReadCloser, error) {
	return b.Adb.OpenLogcat(ctx, serial)
}

func (b *AdbBackend) ClearLogcat(ctx context.Context, serial string) error {
	return b.Adb.ClearLogcat(ctx, serial)
}

func (b *AdbBackend) LogcatProcesses(ctx context.Context, serial string) (string, error) {
	return b.Adb.LogcatProcesses(ctx, serial)
}
