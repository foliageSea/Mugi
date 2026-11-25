package scrcpy

import (
	"context"
	"io"

	"mugi/internal/adb"
)

func (b *AdbBackend) Workbench(ctx context.Context, serial, operation, value string) (string, error) {
	return b.Adb.Workbench(ctx, serial, operation, value)
}
func (b *AdbBackend) Screenshot(ctx context.Context, serial string) ([]byte, error) {
	return b.Adb.Screenshot(ctx, serial)
}
func (b *AdbBackend) ExportAPK(ctx context.Context, serial, pkg string, index int, w io.Writer) error {
	return b.Adb.ExportAPK(ctx, serial, pkg, index, w)
}
func (b *AdbBackend) InstallSet(ctx context.Context, serial string, paths []string, opts adb.InstallOptions) (string, error) {
	return b.Adb.InstallSet(ctx, serial, paths, opts)
}
