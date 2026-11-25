package scrcpy

import (
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"
	"sync"
	"time"
)

var serverSHA256 = sync.OnceValue(func() string {
	sum := sha256.Sum256(serverBinary)
	return hex.EncodeToString(sum[:])
})

func remoteSizeMatches(out string) bool {
	size, err := strconv.Atoi(strings.TrimSpace(out))
	return err == nil && size == len(serverBinary)
}

// remoteSHAMatches treats an unusable sha256sum (missing applet, odd output)
// as "cannot verify" and accepts the file, since the size already matched.
func remoteSHAMatches(out string, err error) bool {
	fields := strings.Fields(out)
	if err != nil || len(fields) == 0 || len(fields[0]) != sha256.Size*2 {
		return true
	}
	return strings.EqualFold(fields[0], serverSHA256())
}

func (b *AdbBackend) remoteServerCurrent(serial string) bool {
	sizeOut, err := b.Adb.Shell(serial, 5*time.Second, "stat -c %s "+remoteServerPath)
	if err != nil || !remoteSizeMatches(sizeOut) {
		return false
	}
	shaOut, shaErr := b.Adb.Shell(serial, 10*time.Second, "sha256sum "+remoteServerPath)
	return remoteSHAMatches(shaOut, shaErr)
}

func (b *AdbBackend) forgetServer(serial string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.pushed, serial)
}

func serverFileMissing(logs string) bool {
	return strings.Contains(logs, "ClassNotFoundException") ||
		strings.Contains(logs, "No such file or directory")
}
