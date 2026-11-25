//go:build !windows

package adb

import (
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestTerminalPTYAndBlockedReadCleanup(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "adb")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\nstty raw -echo\nprintf ready\nexec cat\n"), 0700); err != nil {
		t.Fatal(err)
	}
	terminal, err := (&Client{Bin: bin}).OpenTerminal("device", 24, 80)
	if err != nil {
		t.Fatal(err)
	}
	defer terminal.Close()
	done := make(chan error, 1)
	go func() {
		buffer := make([]byte, 5)
		_, err := io.ReadFull(terminal, buffer)
		if err == nil && string(buffer) != "ready" {
			t.Errorf("unexpected output %q", buffer)
		}
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("PTY never ready")
	}
	if err := terminal.Resize(40, 120); err != nil {
		t.Fatal(err)
	}
	go func() { _, err := terminal.Read(make([]byte, 16)); done <- err }()
	_ = terminal.Close()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("blocked PTY read leaked after close")
	}
}
