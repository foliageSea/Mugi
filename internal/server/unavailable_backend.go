package server

import (
	"io"

	"mugi/internal/adb"
	"mugi/internal/scrcpy"
)

// UnavailableBackend keeps the desktop application available when the local
// adb executable is not installed yet. The UI can still load and report the
// configuration problem, while every device operation returns the same
// actionable startup error.
type UnavailableBackend struct {
	err error
}

// NewUnavailableBackend creates a backend that reports err for all device
// operations. err should explain how to make adb available to the process.
func NewUnavailableBackend(err error) DeviceBackend {
	return &UnavailableBackend{err: err}
}

func (b *UnavailableBackend) Devices() ([]adb.Device, error) { return nil, b.err }

func (b *UnavailableBackend) IsUnlocked(string) (bool, error) { return false, b.err }

func (b *UnavailableBackend) Pair(string, int, string) error { return b.err }

func (b *UnavailableBackend) Connect(string, int) (string, error) { return "", b.err }

func (b *UnavailableBackend) Disconnect(string) error { return b.err }

func (b *UnavailableBackend) Apps(string) ([]adb.App, error) { return nil, b.err }

func (b *UnavailableBackend) StartSession(string, scrcpy.SessionOptions) (*scrcpy.Session, error) {
	return nil, b.err
}

func (b *UnavailableBackend) Push(string, string, io.Reader) error { return b.err }

func (b *UnavailableBackend) Install(string, io.Reader) (string, error) { return "", b.err }

func (b *UnavailableBackend) ListFiles(string, string) ([]adb.FileInfo, error) {
	return nil, b.err
}

func (b *UnavailableBackend) Pull(string, string, io.Writer) error { return b.err }

func (b *UnavailableBackend) CreateDirectory(string, string) error { return b.err }

func (b *UnavailableBackend) CopyFile(string, string, string) error { return b.err }

func (b *UnavailableBackend) RenameFile(string, string, string) error { return b.err }

func (b *UnavailableBackend) DeleteFile(string, string) error { return b.err }

var _ DeviceBackend = (*UnavailableBackend)(nil)
