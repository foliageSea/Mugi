package scrcpy

import (
	"errors"
	"strconv"
	"strings"
	"testing"
)

func TestRemoteSizeMatches(t *testing.T) {
	size := strconv.Itoa(len(serverBinary))
	cases := map[string]bool{
		size:               true,
		size + "\n":        true,
		"0":                false,
		"":                 false,
		"stat: No such":    false,
		size + "0":         false,
		"  " + size + "  ": true,
	}
	for out, want := range cases {
		if got := remoteSizeMatches(out); got != want {
			t.Errorf("remoteSizeMatches(%q) = %v, want %v", out, got, want)
		}
	}
}

func TestRemoteSHAMatches(t *testing.T) {
	good := serverSHA256()
	bad := strings.Repeat("0", len(good))
	cases := []struct {
		name string
		out  string
		err  error
		want bool
	}{
		{"match", good + "  /data/local/tmp/mugi/scrcpy-server\n", nil, true},
		{"uppercase match", strings.ToUpper(good) + "  x", nil, true},
		{"mismatch", bad + "  x", nil, false},
		{"command failed", "", errors.New("sha256sum: not found"), true},
		{"empty output", "", nil, true},
		{"unexpected output", "sha256sum: applet not found", nil, true},
	}
	for _, tc := range cases {
		if got := remoteSHAMatches(tc.out, tc.err); got != tc.want {
			t.Errorf("%s: remoteSHAMatches = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestServerFileMissing(t *testing.T) {
	cases := map[string]bool{
		"java.lang.ClassNotFoundException: com.genymobile.scrcpy.Server": true,
		"app_process: /data/local/tmp/x: No such file or directory":      true,
		"server exited before opening @scrcpy_1: exit status 1":          false,
		"video socket: dial forwarded port 1: refused":                   false,
	}
	for logs, want := range cases {
		if got := serverFileMissing(logs); got != want {
			t.Errorf("serverFileMissing(%q) = %v, want %v", logs, got, want)
		}
	}
}
