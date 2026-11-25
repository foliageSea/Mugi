package adb

import (
	"os"
	"path/filepath"
	"testing"
)

func TestNewHonoursADBEnvironment(t *testing.T) {
	path := filepath.Join(t.TempDir(), "custom-adb.exe")
	if err := os.WriteFile(path, []byte("stub"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ADB", path)
	client, err := New()
	if err != nil {
		t.Fatal(err)
	}
	if client.Bin != path {
		t.Fatalf("ADB override ignored: %s", client.Bin)
	}
}

func TestNewRejectsMissingADBOverride(t *testing.T) {
	t.Setenv("ADB", filepath.Join(t.TempDir(), "missing-adb.exe"))
	if _, err := New(); err == nil {
		t.Fatal("invalid explicit ADB path must not silently fall back to PATH")
	}
}
