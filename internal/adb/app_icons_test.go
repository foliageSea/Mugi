package adb

import (
	"bytes"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAppIconKeys(t *testing.T) {
	const pkg = "com.example.app"
	const listing = "physical-serial\nbuild-id\n0\npackage:/data/app/~~x==/a==/base.apk=com.example.app versionCode:123\npackage:/system/framework/framework-res.apk=android versionCode:37\nignored\n"
	keys := parseAppIconKeys(listing, "wireless-serial")
	if len(keys) != 2 || !ValidAppIconRequest(pkg, keys[pkg]) || !ValidAppIconRequest("android", keys["android"]) {
		t.Fatalf("unexpected keys: %v", keys)
	}
	if ValidAppIconRequest("com.example;touch", keys[pkg]) || ValidAppIconRequest(pkg, strings.Repeat("/", 65)) {
		t.Fatal("accepted invalid request")
	}
	if got := parseAppIconKeys(strings.ReplaceAll(listing, "\n", "\r\n"), "usb-serial")[pkg]; got != keys[pkg] {
		t.Fatal("same device should reuse cached icons across connections")
	}
	for _, pair := range [][2]string{{"physical-serial", "other-device"}, {"build-id", "new-build"}, {"123", "124"}, {"a==/", "b==/"}} {
		got := parseAppIconKeys(strings.ReplaceAll(listing, pair[0], pair[1]), "wireless-serial")[pkg]
		if got == "" || got == keys[pkg] {
			t.Errorf("change %q should generate a new key, got %q", pair[0], got)
		}
	}
}

func TestAppIconDiskCache(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cache", "icon")
	key := strings.Repeat("a", 65)
	newKey := strings.Repeat("b", 65)
	var data bytes.Buffer
	if err := png.Encode(&data, image.NewNRGBA(image.Rect(0, 0, 96, 96))); err != nil {
		t.Fatal(err)
	}
	if readAppIcon(path, key) != nil {
		t.Fatal("empty cache should miss")
	}
	if err := writeAppIcon(path, key, data.Bytes()); err != nil {
		t.Fatal(err)
	}
	if got := readAppIcon(path, key); !bytes.Equal(got, data.Bytes()) {
		t.Fatal("valid disk entry should hit")
	}
	if readAppIcon(path, newKey) != nil {
		t.Fatal("outdated version should miss")
	}
	if err := writeAppIcon(path, newKey, data.Bytes()); err != nil {
		t.Fatal(err)
	}
	if readAppIcon(path, key) != nil || readAppIcon(path, newKey) == nil {
		t.Fatal("replacement must update the cache revision")
	}
	if err := os.WriteFile(path, []byte(newKey+"not a PNG"), 0600); err != nil {
		t.Fatal(err)
	}
	if readAppIcon(path, newKey) != nil {
		t.Fatal("invalid PNG should miss")
	}
}
