package adb

import (
	"bytes"
	"context"
	"crypto/sha256"
	_ "embed"
	"fmt"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"mugi/internal/hostexec"
)

//go:embed assets/app-icons.dex
var appIconDex []byte

var (
	appIconDexID     = fmt.Sprintf("%x", sha256.Sum256(appIconDex))
	appIconRemote    = "/data/local/tmp/mugi/app-icons-" + appIconDexID + ".dex"
	appIconPackage   = regexp.MustCompile(`^(?:[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+|android)$`)
	appIconKey       = regexp.MustCompile(`^[a-f0-9]{32}-[a-f0-9]{32}$`)
	appIconUser      = regexp.MustCompile(`^[0-9]+$`)
	appIconMetadata  = regexp.MustCompile(`^package:/.+=([^= ]+)\s+versionCode:[0-9]+$`)
	appIconLocks     [64]chan struct{}
	appIconWorkers   = make(chan struct{}, 4)
	initAppIconLocks = sync.OnceFunc(func() {
		for i := range appIconLocks {
			appIconLocks[i] = make(chan struct{}, 1)
		}
	})
)

const maxAppIconBytes = 256 << 10

func iconHash(value string) string {
	sum := sha256.Sum256([]byte(value))
	return fmt.Sprintf("%x", sum[:16])
}

func ValidAppIconRequest(pkg, key string) bool {
	return len(pkg) <= 255 && appIconPackage.MatchString(pkg) && appIconKey.MatchString(key)
}

// AppIconKeys reads icon revision metadata once for the entire app list.
// Including the code path also detects typical reinstalls with an unchanged version code.
func (c *Client) AppIconKeys(serial string) map[string]string {
	keys, _ := c.appIconKeys(context.Background(), serial, "")
	return keys
}

func (c *Client) appIconKeys(ctx context.Context, serial, pkg string) (map[string]string, error) {
	command := `user=$(am get-current-user) && getprop ro.serialno && getprop ro.build.fingerprint && echo "$user" && pm list packages --user "$user" -f --show-versioncode`
	if pkg != "" {
		command += " " + shellQuote(pkg)
	}
	out, err := c.runAppIconADB(ctx, 2<<20, "-s", serial, "shell", "-T", command)
	if err != nil {
		return nil, err
	}
	return parseAppIconKeys(string(out), serial), nil
}

func parseAppIconKeys(out, serial string) map[string]string {
	lines := strings.Split(strings.ReplaceAll(out, "\r", ""), "\n")
	if len(lines) < 4 || strings.TrimSpace(lines[1]) == "" || !appIconUser.MatchString(strings.TrimSpace(lines[2])) {
		return nil
	}
	hardware := strings.TrimSpace(lines[0])
	if hardware == "" || strings.EqualFold(hardware, "unknown") {
		hardware = serial
	}
	deviceID := iconHash(hardware + "\x00" + strings.TrimSpace(lines[2]))
	keys := make(map[string]string)
	for _, line := range lines[3:] {
		line = strings.TrimSpace(line)
		match := appIconMetadata.FindStringSubmatch(line)
		if match == nil || !appIconPackage.MatchString(match[1]) {
			continue
		}
		keys[match[1]] = deviceID + "-" + iconHash(appIconDexID+"\x00"+strings.TrimSpace(lines[1])+"\x00"+line)
	}
	return keys
}

// AppIcon returns a cached launcher icon or renders it on the device. It never
// caches errors. The revision is verified against the device on a cache miss.
func (c *Client) AppIcon(ctx context.Context, serial, pkg, key string) ([]byte, error) {
	if !ValidAppIconRequest(pkg, key) {
		return nil, fmt.Errorf("invalid app icon request")
	}
	cacheDir, err := os.UserCacheDir()
	var path string
	slot := key[:32] + "-" + iconHash(pkg)
	if err == nil {
		path = filepath.Join(cacheDir, "mugi", "app-icons", slot)
		if data := readAppIcon(path, key); data != nil {
			return data, nil
		}
	}

	initAppIconLocks()
	hash := sha256.Sum256([]byte(slot))
	lock := appIconLocks[int(hash[0])%len(appIconLocks)]
	select {
	case lock <- struct{}{}:
		defer func() { <-lock }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	if data := readAppIcon(path, key); data != nil {
		return data, nil
	}
	select {
	case appIconWorkers <- struct{}{}:
		defer func() { <-appIconWorkers }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}

	keys, err := c.appIconKeys(ctx, serial, pkg)
	if err != nil || keys[pkg] != key {
		return nil, fmt.Errorf("app icon revision unavailable")
	}
	if err := c.ensureAppIconDex(ctx, serial); err != nil {
		return nil, err
	}
	out, err := c.runAppIconADB(ctx, maxAppIconBytes, "-s", serial, "shell", "-T",
		"CLASSPATH="+appIconRemote+" app_process /system/bin dev.mugi.icons.Main "+shellQuote(pkg))
	if err != nil || !validAppIconPNG(out) {
		return nil, fmt.Errorf("could not render app icon")
	}
	if path != "" {
		// Disk permissions, quota or platform-specific rename failures should
		// not prevent serving an icon that was successfully rendered.
		_ = writeAppIcon(path, key, out)
	}
	return out, nil
}

func (c *Client) ensureAppIconDex(ctx context.Context, serial string) error {
	if _, err := c.runAppIconADB(ctx, 4096, "-s", serial, "shell", "-T", "test -r "+appIconRemote); err == nil {
		return nil
	}
	if _, err := c.runAppIconADB(ctx, 4096, "-s", serial, "shell", "-T", "mkdir -p /data/local/tmp/mugi"); err != nil {
		return err
	}
	local, err := os.CreateTemp("", "mugi-app-icons-*")
	if err != nil {
		return err
	}
	defer os.Remove(local.Name())
	_, writeErr := local.Write(appIconDex)
	closeErr := local.Close()
	if writeErr != nil {
		return writeErr
	}
	if closeErr != nil {
		return closeErr
	}
	staged := "/data/local/tmp/mugi/" + filepath.Base(local.Name()) + ".dex"
	deployed := false
	defer func() {
		if !deployed {
			_, _ = c.runAppIconADB(context.Background(), 4096, "-s", serial, "shell", "-T", "rm -f "+staged)
		}
	}()
	if _, err := c.runAppIconADB(ctx, 4096, "-s", serial, "push", local.Name(), staged); err != nil {
		return err
	}
	_, err = c.runAppIconADB(ctx, 4096, "-s", serial, "shell", "-T", "chmod 444 "+staged+" && mv -f "+staged+" "+appIconRemote)
	deployed = err == nil
	return err
}

func (c *Client) runAppIconADB(ctx context.Context, limit int, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	cmd := hostexec.CommandContext(ctx, c.Bin, args...)
	out := limitedAppIconBuffer{limit: limit}
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return nil, err
	}
	if out.overflow {
		return nil, fmt.Errorf("app icon ADB output too large")
	}
	return out.data.Bytes(), nil
}

type limitedAppIconBuffer struct {
	data     bytes.Buffer
	limit    int
	overflow bool
}

func (b *limitedAppIconBuffer) Write(p []byte) (int, error) {
	n := len(p)
	if room := b.limit - b.data.Len(); n > room {
		p = p[:room]
		b.overflow = true
	}
	_, _ = b.data.Write(p)
	return n, nil
}

func validAppIconPNG(data []byte) bool {
	config, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width <= 0 || config.Width > 128 || config.Height <= 0 || config.Height > 128 {
		return false
	}
	_, err = png.Decode(bytes.NewReader(data))
	return err == nil
}

func readAppIcon(path, key string) []byte {
	if path == "" {
		return nil
	}
	file, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, int64(len(key)+maxAppIconBytes+1)))
	if err != nil || len(data) <= len(key) || len(data) > len(key)+maxAppIconBytes || string(data[:len(key)]) != key {
		return nil
	}
	data = data[len(key):]
	if !validAppIconPNG(data) {
		return nil
	}
	return data
}

func writeAppIcon(path, key string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	file, err := os.CreateTemp(dir, ".icon-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	_, err = file.Write(append([]byte(key), data...))
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(file.Name(), path)
}
