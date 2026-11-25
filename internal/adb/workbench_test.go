package adb

import (
	"os/exec"
	"strings"
	"testing"
)

func TestWorkbenchValidation(t *testing.T) {
	for _, tc := range [][2]string{
		{"app-clear", "com.example; reboot"}, {"app-clear", "--user"},
		{"brightness", "256"}, {"brightness", "-1"}, {"brightness", "1;id"}, {"brightness", "01"},
		{"control-state", "0"}, {"control-state", "id"},
		{"media-volume", ""}, {"media-volume", "-1"}, {"media-volume", "-0"}, {"media-volume", "01"},
		{"media-volume", "+1"}, {"media-volume", "1.0"}, {"media-volume", "1e1"}, {"media-volume", " 1"},
		{"media-volume", "1\n"}, {"media-volume", "1;id"}, {"media-volume", "256"},
		{"wifi", "disable;id"}, {"device-info", "id"}, {"reboot", "bootloader"}, {"home", "extra"}, {"shell", "id"},
	} {
		if _, err := OperationCommand(tc[0], tc[1]); err == nil {
			t.Errorf("accepted %q", tc)
		}
	}
	command, err := OperationCommand("app-clear", "com.example.app")
	if err != nil || !strings.Contains(command, "--user") || !strings.Contains(command, "'com.example.app'") {
		t.Fatalf("%s: %v", command, err)
	}
	if _, err := OperationCommand("brightness", "0"); err != nil {
		t.Fatal(err)
	}
	if _, err := OperationCommand("brightness", "255"); err != nil {
		t.Fatal(err)
	}
	command, err = OperationCommand("battery", "")
	if err != nil || command != "dumpsys battery" {
		t.Fatalf("%s: %v", command, err)
	}
}

func TestMediaVolumeCommand(t *testing.T) {
	for _, value := range []string{"0", "53", "255"} {
		command, err := OperationCommand("media-volume", value)
		want := "cmd media_session volume --stream 3 --set '" + value + "'"
		if err != nil || command != want {
			t.Fatalf("got %q (%v), want %q", command, err, want)
		}
	}
}

func TestControlStateCommand(t *testing.T) {
	command, err := OperationCommand("control-state", "")
	if err != nil {
		t.Fatal(err)
	}
	for _, tool := range []string{"sh", "awk", "sed", "head"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skipf("local shell fixture needs %s: %v", tool, err)
		}
	}
	// Stub every Android service. Never use a real device in this test.
	const mock = `
cmd() {
  case "$*" in
    'wifi status') printf '%s\n' "$wifi_status";;
    'media_session volume --stream 3 --get') printf '%s\n' "$volume_status";;
    *) return 1;;
  esac
}
dumpsys() {
  case "$*" in
    '-t 2 wifi') printf '%s\n' "$wifi_dump";;
    '-t 2 bluetooth_manager') printf '%s\n' "$bluetooth_dump";;
    *) return 1;;
  esac
}
settings() {
  case "$*" in
    'get global bluetooth_on') echo 1;;
    'get global airplane_mode_on') echo 0;;
    'get system screen_brightness') echo "$brightness_setting";;
    'get system screen_brightness_mode') echo 1;;
    *) return 1;;
  esac
}
`
	for _, tc := range []struct {
		name   string
		input  string
		output string
	}{
		{
			name: "connected with native audio range",
			input: `wifi_status='Wifi is enabled
Wifi is connected to private-ssid'
bluetooth_dump='Bluetooth Status:
  State:         OFF'
volume_status='[V] Connecting to AudioService
[V] volume is 53 in range [0..150]'
brightness_setting=81`,
			output: "wifi=1\nwifi_connected=1\nbluetooth=0\nairplane=0\nbrightness=81\nauto_brightness=1\nvolume=53,0,150\n",
		},
		{
			name: "transitions and unsupported audio stay unknown",
			input: `wifi_status='Wifi is disabled'
wifi_dump='Wi-Fi is enabling'
bluetooth_dump='Bluetooth Status:
  state: TURNING_OFF'
volume_status='Unknown command: volume'
brightness_setting=null`,
			output: "wifi=\nwifi_connected=\nbluetooth=\nairplane=0\nbrightness=\nauto_brightness=1\nvolume=\n",
		},
		{
			name: "association separate from enabled and Bluetooth fallback",
			input: `wifi_status='Wifi is enabled
Wifi is not connected'`,
			output: "wifi=1\nwifi_connected=0\nbluetooth=1\nairplane=0\nbrightness=\nauto_brightness=1\nvolume=\n",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			sh := exec.Command("sh", "-s")
			sh.Stdin = strings.NewReader(mock + tc.input + "\n" + command)
			output, err := sh.CombinedOutput()
			if err != nil || string(output) != tc.output {
				t.Fatalf("got %q (%v), want %q", output, err, tc.output)
			}
		})
	}
}

func TestBoundedCommandOutput(t *testing.T) {
	b := &limitedBuffer{limit: 5}
	if _, err := b.Write([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	if _, err := b.Write([]byte("overflow")); err == nil {
		t.Fatal("unbounded output")
	}
	if b.Len() != 5 {
		t.Fatal("buffer exceeded limit")
	}
}
