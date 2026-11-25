package server

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"mugi/internal/adb"
	"mugi/internal/scrcpy"
)

const disconnectSerial = "[fe80::1%eth0]:5555"

type disconnectBackend struct {
	stubBackend
	disconnect func(string) error
	unlock     func(string) (bool, error)
}

func (b disconnectBackend) Disconnect(s string) error { return b.disconnect(s) }

func (b disconnectBackend) IsUnlocked(s string) (bool, error) {
	if b.unlock != nil {
		return b.unlock(s)
	}
	return b.stubBackend.IsUnlocked(s)
}

func postDisconnect(router http.Handler, body string, external bool) *httptest.ResponseRecorder {
	req := localRequest(http.MethodPost, "/api/devices/disconnect", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if external {
		req.RemoteAddr = "8.8.8.8:1234"
	}
	res := httptest.NewRecorder()
	router.ServeHTTP(res, req)
	return res
}

func TestDisconnectDeviceRoute(t *testing.T) {
	gin.SetMode(gin.TestMode)
	const body = "{\"serial\":\"" + disconnectSerial + "\"}"
	for _, tc := range []struct {
		name, request               string
		external, active, forwarded bool
		backendErr                  error
		code                        int
	}{
		{"success leaves unrelated session alone", body, false, false, true, nil, http.StatusOK},
		{"non-network", body, false, false, true, adb.ErrNotNetworkDevice, http.StatusBadRequest},
		{"missing", body, false, false, true, adb.ErrDeviceNotFound, http.StatusNotFound},
		{"ADB unavailable", body, false, false, true, errors.New("adb unavailable"), http.StatusBadGateway},
		{"empty serial", "{\"serial\":\"\"}", false, false, false, nil, http.StatusBadRequest},
		{"malformed JSON", "{", false, false, false, nil, http.StatusBadRequest},
		{"external", body, true, false, false, nil, http.StatusForbidden},
		{"active session", body, false, true, false, nil, http.StatusConflict},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var got []string
			backend := disconnectBackend{disconnect: func(serial string) error {
				got = append(got, serial)
				return tc.backendErr
			}}
			manager := scrcpy.NewManager()
			manager.Register(&scrcpy.Session{ID: "other", Serial: "other.lan:5555"})
			if tc.active {
				manager.Register(&scrcpy.Session{ID: "target", Serial: disconnectSerial})
			}
			res := postDisconnect(New(backend, manager).Router(nil), tc.request, tc.external)
			if res.Code != tc.code {
				t.Fatalf("status %d; want %d: %s", res.Code, tc.code, res.Body)
			}
			if tc.forwarded && (len(got) != 1 || got[0] != disconnectSerial) || !tc.forwarded && len(got) != 0 {
				t.Fatalf("backend disconnect calls = %q", got)
			}
			if tc.code == http.StatusOK && res.Body.String() != "{\"ok\":true}" {
				t.Fatalf("unexpected body: %s", res.Body)
			}
			if manager.Get("other") == nil || tc.active && manager.Get("target") == nil {
				t.Fatal("disconnect removed a session")
			}
		})
	}
}

func TestDisconnectDeviceConflictsWithStartingSession(t *testing.T) {
	gin.SetMode(gin.TestMode)
	const serial = "phone.lan:5555"
	unlockStarted, unlockContinue := make(chan struct{}), make(chan struct{})
	backend := disconnectBackend{
		disconnect: func(target string) error {
			if target != "other.lan:5555" {
				t.Errorf("unexpected disconnect for %q", target)
			}
			return nil
		},
		unlock: func(string) (bool, error) {
			close(unlockStarted)
			<-unlockContinue
			return false, nil
		},
	}
	router := New(backend, scrcpy.NewManager()).Router(nil)
	startDone := make(chan struct{})
	go func() {
		defer close(startDone)
		start := localRequest(http.MethodPost, "/api/devices/"+serial+"/sessions", strings.NewReader("{}"))
		start.Header.Set("Content-Type", "application/json")
		router.ServeHTTP(httptest.NewRecorder(), start)
	}()
	defer func() {
		close(unlockContinue)
		<-startDone
	}()
	select {
	case <-unlockStarted:
	case <-time.After(3 * time.Second):
		t.Fatal("session start did not reach the device unlock check")
	}

	same := postDisconnect(router, "{\"serial\":\""+serial+"\"}", false)
	if same.Code != http.StatusConflict {
		t.Fatalf("same device status %d, body %s", same.Code, same.Body)
	}
	other := postDisconnect(router, "{\"serial\":\"other.lan:5555\"}", false)
	if other.Code != http.StatusOK {
		t.Fatalf("unrelated device status %d, body %s", other.Code, other.Body)
	}
}
