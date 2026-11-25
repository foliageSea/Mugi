package adb

import (
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestForwardTCP(t *testing.T) {
	const serial = "usb-device"
	const remote = "localabstract:scrcpy_12345678"
	commandErr := errors.New("exit status 1")
	tests := []struct {
		name       string
		output     string
		stderr     string
		forwardErr error
		list       string
		listErr    error
		fixedErr   error
		wantPort   int
		wantCalls  int
		wantError  string
		wantFixed  bool
	}{
		{name: "printed port", output: "43210\r\n", wantPort: 43210, wantCalls: 1},
		{
			name: "empty output uses exact mapping", wantPort: 43211, wantCalls: 2,
			list: "other-device tcp:43209 " + remote + "\r\n" +
				serial + " tcp:43210 localabstract:scrcpy_other\r\n" +
				serial + " tcp:43211 " + remote + "\r\n",
		},
		{name: "whitespace output", output: " \r\n", list: serial + " tcp:43212 " + remote, wantPort: 43212, wantCalls: 2},
		{name: "non-numeric output", output: "unexpected output", list: serial + " tcp:43213 " + remote, wantPort: 43213, wantCalls: 2},
		{name: "zero output", output: "0", list: serial + " tcp:43214 " + remote, wantPort: 43214, wantCalls: 2},
		{name: "out-of-range output", output: "65536", list: serial + " tcp:43215 " + remote, wantPort: 43215, wantCalls: 2},
		{name: "fixed port fallback", wantCalls: 3, wantFixed: true},
		{name: "no mapping", wantCalls: 5, fixedErr: commandErr, wantError: "no TCP forward found"},
		{name: "other device only", list: "other-device tcp:43210 " + remote, wantCalls: 3, wantFixed: true},
		{name: "other socket only", list: serial + " tcp:43210 localabstract:scrcpy_other", wantCalls: 3, wantFixed: true},
		{name: "invalid mapping port", list: serial + " tcp:65536 " + remote, wantCalls: 3, wantFixed: true},
		{name: "non-TCP mapping", list: serial + " localabstract:host " + remote, wantCalls: 3, wantFixed: true},
		{name: "malformed mapping", list: serial + " tcp:43210", wantCalls: 3, wantFixed: true},
		{name: "forward failure", forwardErr: commandErr, stderr: "device offline", wantCalls: 1, wantError: "device offline"},
		{name: "list failure", listErr: commandErr, wantCalls: 2, wantError: "adb forward --list"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			calls := 0
			run := func(timeout time.Duration, args ...string) (string, string, error) {
				calls++
				wantArgs := []string{"-s", serial, "forward", "tcp:0", remote}
				if calls == 2 {
					wantArgs = []string{"-s", serial, "forward", "--list"}
				} else if calls >= 3 {
					if len(args) != 5 || args[0] != "-s" || args[1] != serial || args[2] != "forward" || !strings.HasPrefix(args[3], "tcp:") || args[3] == "tcp:0" || args[4] != remote {
						t.Fatalf("unexpected fixed-port command: %q", args)
					}
					return "", "", tt.fixedErr
				}
				if timeout != 10*time.Second || !reflect.DeepEqual(args, wantArgs) {
					t.Fatalf("unexpected command: timeout=%s args=%q", timeout, args)
				}
				if calls == 1 {
					return tt.output, tt.stderr, tt.forwardErr
				}
				return tt.list, "", tt.listErr
			}
			port, err := forwardTCP(run, serial, remote)
			if tt.wantError == "" {
				if err != nil {
					t.Fatal(err)
				}
			} else if err == nil || !strings.Contains(err.Error(), tt.wantError) {
				t.Fatalf("expected error containing %q, got %v", tt.wantError, err)
			}
			if tt.wantFixed && (port <= 0 || port > 65535) {
				t.Fatalf("fixed-port fallback returned invalid port %d", port)
			}
			if !tt.wantFixed && port != tt.wantPort {
				t.Fatalf("got port=%d, want port=%d", port, tt.wantPort)
			}
			if calls != tt.wantCalls {
				t.Fatalf("got port=%d calls=%d, want port=%d calls=%d", port, calls, tt.wantPort, tt.wantCalls)
			}
			if (tt.forwardErr != nil || tt.listErr != nil) && !errors.Is(err, commandErr) {
				t.Fatalf("command error was not preserved: %v", err)
			}
		})
	}
}

func TestParseForwardPort(t *testing.T) {
	for _, output := range []string{"", "0", "-1", "65536", "99999999999999999999999", "tcp:43210", "43210\n43211", "not a port"} {
		if port, ok := parseForwardPort(output); ok {
			t.Errorf("accepted invalid output %q as port %d", output, port)
		}
	}
	for _, output := range []string{"1", "65535", " 43210\r\n"} {
		if _, ok := parseForwardPort(output); !ok {
			t.Errorf("rejected valid output %q", output)
		}
	}
}
