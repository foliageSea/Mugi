package adb

import (
	"context"
	_ "embed"
	"fmt"
	"io"

	"mugi/internal/hostexec"
)

//go:embed metrics.sh
var MetricsCommand string

// Terminal is an interactive Android shell, never a shell on the relay host.
type Terminal interface {
	io.ReadWriteCloser
	Resize(rows, cols uint16) error
}

func (c *Client) Metrics(ctx context.Context, serial string) (string, error) {
	cmd := hostexec.CommandContext(ctx, c.Bin, "-s", serial, "shell", MetricsCommand)
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("读取设备指标失败: %w", err)
	}
	return string(out), nil
}
