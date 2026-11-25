//go:build !windows

package adb

import (
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"
)

type shellTerminal struct {
	*os.File
	cmd  *exec.Cmd
	once sync.Once
}

func (c *Client) OpenTerminal(serial string, rows, cols uint16) (Terminal, error) {
	// A local PTY lets adb forward window changes and control keys to Android.
	cmd := exec.Command(c.Bin, "-s", serial, "shell", "-tt")
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")
	f, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: rows, Cols: cols})
	if err != nil {
		return nil, err
	}
	// Re-wrap a nonblocking descriptor so older Go runtimes register the PTY
	// with their poller. Merely toggling the original file can yield EAGAIN.
	fd, err := syscall.Dup(int(f.Fd()))
	if err == nil {
		syscall.CloseOnExec(fd)
		err = syscall.SetNonblock(fd, true)
	}
	if err != nil {
		if fd >= 0 {
			_ = syscall.Close(fd)
		}
		_ = f.Close()
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return nil, err
	}
	_ = f.Close()
	return &shellTerminal{File: os.NewFile(uintptr(fd), "android-terminal"), cmd: cmd}, nil
}

func (t *shellTerminal) Resize(rows, cols uint16) error {
	// File.Fd would switch back to blocking mode on Go 1.19.
	conn, err := t.File.SyscallConn()
	if err != nil {
		return err
	}
	var resizeErr error
	err = conn.Control(func(fd uintptr) {
		resizeErr = unix.IoctlSetWinsize(int(fd), unix.TIOCSWINSZ, &unix.Winsize{Row: rows, Col: cols})
	})
	if err != nil {
		return err
	}
	return resizeErr
}

func (t *shellTerminal) Write(data []byte) (int, error) {
	if err := t.File.SetWriteDeadline(time.Now().Add(10 * time.Second)); err != nil {
		return 0, err
	}
	return t.File.Write(data)
}

func (t *shellTerminal) Close() error {
	t.once.Do(func() {
		_ = t.File.Close()
		_ = t.cmd.Process.Kill()
		_ = t.cmd.Wait()
	})
	return nil
}
