package server

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"mugi/internal/scrcpy"
)

const testIconDevice = "10.10.2.108:42133"

type appIconTestBackend struct{ stubBackend }

func (appIconTestBackend) AppIcon(_ context.Context, serial, pkg, key string) ([]byte, error) {
	if serial != testIconDevice || pkg != "com.example.app" || key[:3] != "aaa" {
		return nil, errors.New("not found")
	}
	return []byte("test image"), nil
}

func TestAppIconRoute(t *testing.T) {
	key := strings.Repeat("a", 32) + "-" + strings.Repeat("b", 32)
	for _, tt := range []struct {
		mode     AccessMode
		pkg, key string
		status   int
	}{
		{AccessLocal, "com.example.app", key, http.StatusOK},
		{AccessLocal, "com.example.other", key, http.StatusNotFound},
		{AccessLocal, "com.example;bad", key, http.StatusBadRequest},
		{AccessLocal, "com.example.app", "bad-key", http.StatusBadRequest},
		{AccessExternal, "com.example.app", key, http.StatusForbidden},
	} {
		router := NewWithAccessMode(appIconTestBackend{}, scrcpy.NewManager(), tt.mode).Router(http.FS(fstest.MapFS{}))
		w := httptest.NewRecorder()
		router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/devices/"+testIconDevice+"/apps/"+tt.pkg+"/icon?v="+tt.key, nil))
		if w.Code != tt.status {
			t.Fatalf("status %d, want %d", w.Code, tt.status)
		}
		if tt.status == http.StatusOK && (w.Header().Get("Content-Type") != "image/png" || w.Body.String() != "test image") {
			t.Fatal("response should carry the image bytes")
		}
		if tt.status == http.StatusNotFound && w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("failed extraction must not be cached")
		}
	}
}
