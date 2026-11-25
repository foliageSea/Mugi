package scrcpy

import (
	"bytes"
	"errors"
	"io"
	"net"
	"testing"
	"time"
)

type resetDeadlineConn struct {
	net.Conn
	deadlines []time.Time
	writes    [][]byte
	writeErr  error
}

func (c *resetDeadlineConn) SetWriteDeadline(deadline time.Time) error {
	c.deadlines = append(c.deadlines, deadline)
	return nil
}

func (c *resetDeadlineConn) Write(data []byte) (int, error) {
	c.writes = append(c.writes, append([]byte(nil), data...))
	if c.writeErr != nil {
		return 0, c.writeErr
	}
	return len(data), nil
}

func TestVideoResetClearsWriteDeadline(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(map[bool]string{false: "success", true: "failure"}[fail], func(t *testing.T) {
			conn := &resetDeadlineConn{}
			if fail {
				conn.writeErr = errors.New("write failed")
			}
			sess := &Session{control: conn}
			before := time.Now()
			err := sess.SendControl(EncodeResetVideo())
			if (err != nil) != fail {
				t.Fatalf("unexpected reset error: %v", err)
			}
			if len(conn.deadlines) != 2 || !conn.deadlines[1].IsZero() {
				t.Fatalf("reset must set and clear its deadline: %v", conn.deadlines)
			}
			if conn.deadlines[0].Before(before.Add(time.Second)) || conn.deadlines[0].After(time.Now().Add(time.Second)) {
				t.Fatal("reset write must have a one-second deadline")
			}
			if len(conn.writes) != 1 || !bytes.Equal(conn.writes[0], EncodeResetVideo()) {
				t.Fatal("reset control payload changed")
			}
			conn.writeErr = nil
			if err := sess.SendControl(EncodeSetDisplayPower(true)); err != nil {
				t.Fatal(err)
			}
			if len(conn.deadlines) != 2 {
				t.Fatal("ordinary control writes must not change recovery deadlines")
			}
		})
	}
}

func TestVideoResetWriteTimeoutDoesNotPoisonControlChannel(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	sess := &Session{control: server}
	err := sess.SendControl(EncodeResetVideo()) // No reader: the write must time out.
	var netErr net.Error
	if !errors.As(err, &netErr) || !netErr.Timeout() {
		t.Fatalf("expected a reset write timeout, got %v", err)
	}
	if err := client.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	received := make(chan error, 1)
	go func() {
		data := make([]byte, 2)
		_, err := io.ReadFull(client, data)
		if err == nil && !bytes.Equal(data, EncodeSetDisplayPower(true)) {
			err = errors.New("unexpected control payload")
		}
		received <- err
	}()
	if err := sess.SendControl(EncodeSetDisplayPower(true)); err != nil {
		t.Fatalf("expired reset deadline leaked into ordinary control write: %v", err)
	}
	if err := <-received; err != nil {
		t.Fatal(err)
	}
}
