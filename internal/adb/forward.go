package adb

import (
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"
)

// ForwardTCP forwards an automatically allocated local TCP port to remote.
func (c *Client) ForwardTCP(serial, remote string) (int, error) {
	return forwardTCP(c.run, serial, remote)
}

func forwardTCP(run func(time.Duration, ...string) (string, string, error), serial, remote string) (int, error) {
	out, stderr, err := run(10*time.Second, "-s", serial, "forward", "tcp:0", remote)
	if err != nil {
		return 0, fmt.Errorf("adb forward: %w: %s", err, strings.TrimSpace(stderr))
	}
	if port, ok := parseForwardPort(out); ok {
		return port, nil
	}

	// Some adb client/server combinations establish the forward without
	// printing its allocated port. The list is server-wide even with -s,
	// so match both the device and the exact remote endpoint.
	list, listStderr, err := run(10*time.Second, "-s", serial, "forward", "--list")
	if err != nil {
		return 0, fmt.Errorf("adb forward --list after port output %q: %w: %s", out, err, strings.TrimSpace(listStderr))
	}
	for _, line := range strings.Split(list, "\n") {
		fields := strings.Fields(line)
		if len(fields) != 3 || fields[0] != serial || fields[2] != remote || !strings.HasPrefix(fields[1], "tcp:") {
			continue
		}
		if port, ok := parseForwardPort(strings.TrimPrefix(fields[1], "tcp:")); ok {
			return port, nil
		}
	}

	// A few ADB implementations accept tcp:0 but neither print the selected
	// port nor expose the mapping through --list. Reserve a local port and
	// request that exact port instead. This also avoids depending on the
	// output format of vendor-modified ADB clients.
	if port, fixedErr := forwardFixedTCP(run, serial, remote); fixedErr == nil {
		return port, nil
	} else {
		return 0, fmt.Errorf("adb forward returned invalid port: %q (stderr: %q); no TCP forward found for %s to %s; fixed-port fallback failed: %w", out, strings.TrimSpace(stderr), serial, remote, fixedErr)
	}
}

const fixedForwardAttempts = 3

func forwardFixedTCP(run func(time.Duration, ...string) (string, string, error), serial, remote string) (int, error) {
	var lastErr error
	for attempt := 0; attempt < fixedForwardAttempts; attempt++ {
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return 0, fmt.Errorf("reserve local TCP port: %w", err)
		}
		port := listener.Addr().(*net.TCPAddr).Port
		_ = listener.Close()

		_, stderr, err := run(10*time.Second, "-s", serial, "forward", fmt.Sprintf("tcp:%d", port), remote)
		if err == nil {
			return port, nil
		}
		lastErr = fmt.Errorf("adb forward tcp:%d: %w: %s", port, err, strings.TrimSpace(stderr))
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("no attempts made")
	}
	return 0, lastErr
}

func parseForwardPort(output string) (int, bool) {
	port, err := strconv.Atoi(strings.TrimSpace(output))
	return port, err == nil && port > 0 && port <= 65535
}
