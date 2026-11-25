package adb

import (
	"context"
	"fmt"
	"io"
	"strings"
	"sync"

	"mugi/internal/hostexec"
)

// Keep these fixed commands in sync with packages/web-adb/src/logcat.ts.
const LogcatCommand = "logcat -b main -b system -b crash -v threadtime -T 500 '*:V'"
const ClearLogcatCommand = "logcat -b main -b system -b crash -c"
const LogcatProcessesCommand = "ps -A -o PID,NAME"

type logcatStream struct {
	*io.PipeReader
	cancel context.CancelFunc
	done   chan struct{}
	once   sync.Once
}

func (s *logcatStream) Close() error {
	s.once.Do(func() {
		s.cancel()
		_ = s.PipeReader.Close()
		<-s.done
	})
	return nil
}

// cappedOutput drains stderr without letting a noisy device grow host memory.
type cappedOutput struct{ text []byte }

func (b *cappedOutput) Write(p []byte) (int, error) {
	n := len(p)
	remaining := 8192 - len(b.text)
	if remaining > 0 {
		if len(p) > remaining {
			p = p[:remaining]
		}
		b.text = append(b.text, p...)
	}
	return n, nil
}

func (c *Client) OpenLogcat(ctx context.Context, serial string) (io.ReadCloser, error) {
	ctx, cancel := context.WithCancel(ctx)
	reader, writer := io.Pipe()
	cmd := hostexec.CommandContext(ctx, c.Bin, "-s", serial, "shell", LogcatCommand)
	stderr := &cappedOutput{}
	cmd.Stdout, cmd.Stderr = writer, stderr
	if err := cmd.Start(); err != nil {
		cancel()
		_ = reader.Close()
		_ = writer.Close()
		return nil, fmt.Errorf("启动 Logcat 失败: %w", err)
	}
	s := &logcatStream{PipeReader: reader, cancel: cancel, done: make(chan struct{})}
	go func() {
		defer close(s.done)
		err := cmd.Wait()
		if err != nil {
			err = fmt.Errorf("Logcat 已退出: %w: %s", err, strings.TrimSpace(string(stderr.text)))
		}
		_ = writer.CloseWithError(err)
	}()
	return s, nil
}

func (c *Client) logcatQuery(ctx context.Context, serial, command string) (string, error) {
	cmd := hostexec.CommandContext(ctx, c.Bin, "-s", serial, "shell", command)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("Logcat 操作失败: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

func (c *Client) ClearLogcat(ctx context.Context, serial string) error {
	_, err := c.logcatQuery(ctx, serial, ClearLogcatCommand)
	return err
}

func (c *Client) LogcatProcesses(ctx context.Context, serial string) (string, error) {
	return c.logcatQuery(ctx, serial, LogcatProcessesCommand)
}
