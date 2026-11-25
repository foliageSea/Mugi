package adb

import (
	"errors"
	"fmt"
	"io"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// Act as an adb-shaped console process before the test flag parser sees -s.
func init() {
	if os.Getenv("MUGI_TEST_TERMINAL") != "1" || len(os.Args) < 2 || os.Args[1] != "-s" {
		return
	}
	if !reflect.DeepEqual(os.Args[1:], []string{"-s", "device with spaces", "shell", "-tt"}) {
		os.Exit(2)
	}
	input, err := windows.GetStdHandle(windows.STD_INPUT_HANDLE)
	if err != nil {
		os.Exit(3)
	}
	// Like adb, use raw input so control keys reach the device instead of
	// being interpreted by the Windows host console.
	if err := windows.SetConsoleMode(input, windows.ENABLE_VIRTUAL_TERMINAL_INPUT); err != nil {
		os.Exit(4)
	}
	printSize := func(prefix string) {
		var info windows.ConsoleScreenBufferInfo
		if err := windows.GetConsoleScreenBufferInfo(windows.Handle(os.Stdout.Fd()), &info); err != nil {
			os.Exit(5)
		}
		fmt.Fprintf(os.Stdout, "%s=%dx%d\r\n", prefix, info.Size.X, info.Size.Y)
	}
	printSize("MUGI_READY")
	buffer := make([]byte, 5)
	if _, err := io.ReadFull(os.Stdin, buffer); err != nil || string(buffer) != "ping\x03" {
		os.Exit(6)
	}
	fmt.Fprint(os.Stdout, "MUGI_INPUT\r\n")
	if _, err := io.ReadFull(os.Stdin, buffer[:1]); err != nil || buffer[0] != 's' {
		os.Exit(7)
	}
	printSize("MUGI_SIZE")
	if _, err := io.ReadFull(os.Stdin, buffer[:1]); err != nil || buffer[0] != 'q' {
		os.Exit(8)
	}
	fmt.Fprint(os.Stdout, "MUGI_EXIT\r\n")
	os.Exit(0)
}

func openTestWindowsTerminal(t *testing.T) Terminal {
	t.Helper()
	if err := windows.NewLazySystemDLL("kernel32.dll").NewProc("CreatePseudoConsole").Find(); err != nil {
		t.Skip("ConPTY requires Windows 10 1809 or newer")
	}
	bin, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("MUGI_TEST_TERMINAL", "1")
	terminal, err := (&Client{Bin: bin}).OpenTerminal("device with spaces", 24, 80)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = terminal.Close() })
	return terminal
}

func readWindowsTerminal(terminal Terminal) (<-chan string, <-chan error) {
	output := make(chan string, 32)
	done := make(chan error, 1)
	go func() {
		buffer := make([]byte, 4096)
		var all strings.Builder
		for {
			n, err := terminal.Read(buffer)
			if n > 0 {
				all.Write(buffer[:n])
				output <- all.String()
			}
			if err != nil {
				done <- err
				return
			}
		}
	}()
	return output, done
}

func awaitWindowsTerminalOutput(t *testing.T, output <-chan string, done <-chan error, want string) {
	t.Helper()
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	for {
		select {
		case data := <-output:
			if strings.Contains(data, want) {
				return
			}
		case err := <-done:
			// The reader can report EOF before the final buffered output is
			// selected. Check those frames too before treating this as failure.
			for len(output) > 0 {
				if strings.Contains(<-output, want) {
					return
				}
			}
			t.Fatalf("terminal exited before %q: %v", want, err)
		case <-timer.C:
			t.Fatalf("terminal never produced %q", want)
		}
	}
}

func TestWindowsTerminalInputResizeAndExit(t *testing.T) {
	terminal := openTestWindowsTerminal(t)
	output, done := readWindowsTerminal(terminal)
	awaitWindowsTerminalOutput(t, output, done, "MUGI_READY=80x24")
	if _, err := terminal.Write([]byte("ping\x03")); err != nil {
		t.Fatal(err)
	}
	awaitWindowsTerminalOutput(t, output, done, "MUGI_INPUT")
	if err := terminal.Resize(40, 120); err != nil {
		t.Fatal(err)
	}
	if _, err := terminal.Write([]byte("s")); err != nil {
		t.Fatal(err)
	}
	awaitWindowsTerminalOutput(t, output, done, "MUGI_SIZE=120x40")
	if _, err := terminal.Write([]byte("q")); err != nil {
		t.Fatal(err)
	}
	// Natural process exit must close the output stream, while preserving
	// the final frame rather than discarding it during shutdown.
	var final string
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	for {
		select {
		case data := <-output:
			final = data
		case err := <-done:
			for len(output) > 0 {
				final = <-output
			}
			if !errors.Is(err, io.EOF) || !strings.Contains(final, "MUGI_EXIT") {
				t.Fatalf("unexpected exit: %v, output %q", err, final)
			}
			return
		case <-timer.C:
			t.Fatal("terminal did not close its output after process exit")
		}
	}
}

func TestWindowsTerminalBlockedReadCleanup(t *testing.T) {
	terminal := openTestWindowsTerminal(t)
	output, done := readWindowsTerminal(terminal)
	awaitWindowsTerminalOutput(t, output, done, "MUGI_READY=80x24")
	closed := make(chan struct{})
	go func() {
		_ = terminal.Close()
		_ = terminal.Close()
		close(closed)
	}()
	select {
	case <-closed:
	case <-time.After(5 * time.Second):
		t.Fatal("terminal close blocked")
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("blocked terminal read leaked after close")
	}
	if err := terminal.Resize(24, 80); !errors.Is(err, os.ErrClosed) {
		t.Fatalf("resize after close: %v", err)
	}
}

func TestWindowsTerminalStartFailure(t *testing.T) {
	if err := windows.NewLazySystemDLL("kernel32.dll").NewProc("CreatePseudoConsole").Find(); err != nil {
		t.Skip("ConPTY requires Windows 10 1809 or newer")
	}
	_, err := (&Client{Bin: `C:\nonexistent-mugi-adb.exe`}).OpenTerminal("device", 24, 80)
	if err == nil || !strings.Contains(err.Error(), "start adb terminal") {
		t.Fatalf("expected process startup error, got %v", err)
	}
}
