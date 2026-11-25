package adb

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func disconnectTestADB(t *testing.T) (*Client, string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("requires a POSIX shell")
	}
	dir := t.TempDir()
	bin := filepath.Join(dir, "adb")
	log := filepath.Join(dir, "calls")
	t.Setenv("ADB_CALL_LOG", log)
	script := `#!/bin/sh
{
  printf '[%s]' "$@"
  printf '\n'
} >> "$ADB_CALL_LOG"
case "$1" in
  devices)
    [ "$#" -eq 2 ] && [ "$2" = -l ] || exit 2
    printf '%s\n' 'List of devices attached' "$ADB_DEVICE_LIST"
    ;;
  disconnect)
    [ "$#" -eq 2 ] && [ -n "$2" ] || exit 2
    if [ -n "$ADB_DISCONNECT_OUTPUT" ]; then
      printf '%s\n' "$ADB_DISCONNECT_OUTPUT"
      exit "$ADB_DISCONNECT_STATUS"
    fi
    printf 'disconnected %s\n' "$2"
    ;;
  -s)
    [ "$3" = shell ] && [ "$4" = 'wm size' ] || exit 2
    printf 'Physical size: 1080x2400\n'
    ;;
  *) exit 2 ;;
esac
`
	if err := os.WriteFile(bin, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ADB_DISCONNECT_OUTPUT", "")
	return &Client{Bin: bin}, log
}

func TestDeviceNetworkFlag(t *testing.T) {
	client, log := disconnectTestADB(t)
	t.Setenv("ADB_DEVICE_LIST", `192.168.1.4:5555 device product:foo model:Example transport_id:1
phone.lan:5555 offline transport_id:2
[fe80::1%eth0]:47111 offline transport_id:3
adb-XYZ-f7z30c._adb-tls-connect._tcp offline transport_id:4
USB123 offline usb:1-2 transport_id:5
usb-like:5555 offline usb:2-3 transport_id:6
emulator-5554 offline transport_id:7
`)
	devices, err := client.Devices()
	if err != nil || len(devices) != 7 {
		t.Fatalf("Devices = %#v, %v", devices, err)
	}
	for i, device := range devices {
		if device.Network != (i < 4) {
			t.Errorf("%s network = %v", device.Serial, device.Network)
		}
	}
	if first := devices[0]; first.Model != "Example" || first.Width != 1080 || first.Height != 2400 {
		t.Fatalf("online device metadata: %#v", first)
	}
	assertADBCalls(t, log, "[devices][-l]\n[-s][192.168.1.4:5555][shell][wm size]\n")
}

func TestDisconnectTargetsOneListedNetworkDevice(t *testing.T) {
	for _, tc := range []struct {
		name, serial, listing string
		wantErr               error
	}{
		{"online TCP", "phone.lan:5555", "phone.lan:5555 device", nil},
		{"offline TCP", "192.168.1.4:5555", "192.168.1.4:5555 offline", nil},
		{"offline IPv6", "[fe80::1%eth0]:47111", "[fe80::1%eth0]:47111 offline", nil},
		{"offline mDNS", "adb-XYZ-f7z30c._adb-tls-connect._tcp", "adb-XYZ-f7z30c._adb-tls-connect._tcp offline", nil},
		{"USB", "USB123", "USB123 device usb:1-2", ErrNotNetworkDevice},
		{"USB with network-like serial", "phone.lan:5555", "phone.lan:5555 offline usb:2-3", ErrNotNetworkDevice},
		{"emulator", "emulator-5554", "emulator-5554 device", ErrNotNetworkDevice},
		{"missing", "192.168.1.6:5555", "", ErrDeviceNotFound},
		{"ambiguous", "phone.lan:5555", "phone.lan:5555 offline\nphone.lan:5555 device usb:1-2", ErrNotNetworkDevice},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client, log := disconnectTestADB(t)
			t.Setenv("ADB_DEVICE_LIST", "other.lan:5555 device\n"+tc.listing)
			if err := client.Disconnect(tc.serial); !errors.Is(err, tc.wantErr) {
				t.Fatalf("Disconnect(%q) = %v, want %v", tc.serial, err, tc.wantErr)
			}
			want := "[devices][-l]\n"
			if tc.wantErr == nil {
				want += "[disconnect][" + tc.serial + "]\n"
			}
			assertADBCalls(t, log, want)
		})
	}
}

func TestDisconnectRejectsEmptyTarget(t *testing.T) {
	client, log := disconnectTestADB(t)
	if err := client.Disconnect(""); !errors.Is(err, ErrNotNetworkDevice) {
		t.Fatalf("Disconnect(empty) = %v", err)
	}
	if _, err := os.Stat(log); !os.IsNotExist(err) {
		t.Fatalf("ADB should not be called for empty target: %v", err)
	}
}

func TestDisconnectSurfacesADBErrors(t *testing.T) {
	for _, exit := range []string{"0", "1"} {
		t.Run(exit, func(t *testing.T) {
			client, log := disconnectTestADB(t)
			t.Setenv("ADB_DEVICE_LIST", "phone.lan:5555 offline")
			t.Setenv("ADB_DISCONNECT_OUTPUT", "no such device 'phone.lan:5555'")
			t.Setenv("ADB_DISCONNECT_STATUS", exit)
			if err := client.Disconnect("phone.lan:5555"); err == nil || !strings.Contains(err.Error(), "no such device") {
				t.Fatalf("Disconnect = %v; expected ADB failure", err)
			}
			assertADBCalls(t, log, "[devices][-l]\n[disconnect][phone.lan:5555]\n")
		})
	}
}

func assertADBCalls(t *testing.T, log, want string) {
	t.Helper()
	calls, err := os.ReadFile(log)
	if err != nil || string(calls) != want {
		t.Fatalf("ADB calls = %q, %v; want %q", calls, err, want)
	}
}
