package scrcpy

import (
	"strings"
	"testing"
)

func TestSessionShellCommandMaxFps(t *testing.T) {
	for _, tc := range []struct {
		name string
		opts SessionOptions
		want string
	}{
		{"mirror cap", SessionOptions{Mode: "mirror", MaxFps: 30}, "max_fps=30"},
		{"display cap", SessionOptions{Mode: "display", MaxFps: 120}, "max_fps=120"},
		{"unlimited", SessionOptions{}, ""},
		{"negative", SessionOptions{MaxFps: -1}, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			command := sessionShellCommand("01234567", tc.opts)
			var got string
			for _, arg := range strings.Fields(command) {
				if strings.HasPrefix(arg, "max_fps=") {
					if got != "" {
						t.Fatalf("duplicate max_fps arguments in %q", command)
					}
					got = arg
				}
			}
			if got != tc.want {
				t.Errorf("max_fps argument = %q, want %q (empty means omitted)", got, tc.want)
			}
		})
	}
}
