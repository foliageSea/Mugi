//go:build !windows

package adb

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestOpenLogcatStreamsOutputAndExit(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "fake-adb")
	script := `#!/bin/sh
printf '%s\n' '03-14 12:34:56.789  123  456 I mugi: hello'
`
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}

	stream, err := (&Client{Bin: bin}).OpenLogcat(context.Background(), "serial")
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	data, err := io.ReadAll(stream)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(string(data)); got != "03-14 12:34:56.789  123  456 I mugi: hello" {
		t.Fatalf("unexpected logcat output %q", got)
	}
}

func TestOpenLogcatReportsCommandFailure(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "fake-adb")
	script := `#!/bin/sh
printf '%s\n' 'device offline' >&2
exit 1
`
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}

	stream, err := (&Client{Bin: bin}).OpenLogcat(context.Background(), "serial")
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	_, err = io.ReadAll(stream)
	if err == nil || !strings.Contains(err.Error(), "device offline") {
		t.Fatalf("expected command diagnostic, got %v", err)
	}
}

func TestLogcatCloseUnblocksSilentAndBusyStreams(t *testing.T) {
	for _, script := range []string{"#!/bin/sh\nexec sleep 60\n", "#!/bin/sh\nexec yes log\n"} {
		bin := filepath.Join(t.TempDir(), "fake-adb")
		if err := os.WriteFile(bin, []byte(script), 0700); err != nil {
			t.Fatal(err)
		}
		stream, err := (&Client{Bin: bin}).OpenLogcat(context.Background(), "serial")
		if err != nil {
			t.Fatal(err)
		}
		done := make(chan struct{})
		go func() { _ = stream.Close(); _ = stream.Close(); close(done) }()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Fatal("Logcat process leaked on close")
		}
	}
}
