package adb

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"

	"mugi/internal/hostexec"
)

//go:embed device-info.sh
var DeviceInfoCommand string

//go:embed operations.json
var operationsJSON []byte

type Operation struct {
	Command string   `json:"command"`
	Package bool     `json:"package"`
	Choices []string `json:"choices"`
	Integer []int    `json:"integer"`
}

var operations = func() map[string]Operation {
	var result map[string]Operation
	if err := json.Unmarshal(operationsJSON, &result); err != nil {
		panic(err)
	}
	return result
}()

var packageName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$`)

func ValidPackage(value string) bool { return len(value) <= 255 && packageName.MatchString(value) }

// OperationCommand is shared with the WebUSB command builder through operations.json.
// Only named operations and validated arguments can reach the device shell.
func OperationCommand(name, value string) (string, error) {
	if name == "device-info" && value == "" {
		return DeviceInfoCommand, nil
	}
	if name == "reboot" && value == "" {
		return "", nil
	}
	op, ok := operations[name]
	if !ok {
		return "", errors.New("不支持的设备操作")
	}
	valid := value == ""
	switch {
	case op.Package:
		valid = ValidPackage(value)
	case len(op.Integer) == 2:
		n, err := strconv.Atoi(value)
		valid = err == nil && strconv.Itoa(n) == value && n >= op.Integer[0] && n <= op.Integer[1]
	case len(op.Choices) > 0:
		valid = false
		for _, choice := range op.Choices {
			if value == choice {
				valid = true
			}
		}
	}
	if !valid {
		return "", errors.New("设备操作参数无效")
	}
	return strings.ReplaceAll(op.Command, "{value}", shellQuote(value)), nil
}

// limitedBuffer fails rather than retaining unbounded command output.
type limitedBuffer struct {
	bytes.Buffer
	limit int
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if len(p) > b.limit-b.Len() {
		return 0, errors.New("设备输出超过大小限制")
	}
	return b.Buffer.Write(p)
}

func (c *Client) Workbench(ctx context.Context, serial, operation, value string) (string, error) {
	command, err := OperationCommand(operation, value)
	if err != nil {
		return "", err
	}
	args := []string{"-s", serial, "shell", command}
	if operation == "reboot" {
		args = []string{"-s", serial, "reboot"}
	}
	cmd := hostexec.CommandContext(ctx, c.Bin, args...)
	out := &limitedBuffer{limit: 8 << 20}
	cmd.Stdout, cmd.Stderr = out, out
	err = cmd.Run()
	text := strings.TrimSpace(out.String())
	if err != nil {
		return "", fmt.Errorf("设备操作失败: %w: %s", err, text)
	}
	if strings.Contains(text, "Failure [") || strings.HasPrefix(text, "Error:") || strings.HasPrefix(text, "Security exception:") || strings.Contains(text, "Unknown command:") {
		return "", errors.New(text)
	}
	if (operation == "app-clear" || operation == "app-uninstall") && text != "Success" {
		return "", fmt.Errorf("操作未成功: %s", text)
	}
	return text, nil
}

func (c *Client) Screenshot(ctx context.Context, serial string) ([]byte, error) {
	cmd := hostexec.CommandContext(ctx, c.Bin, "-s", serial, "exec-out", "screencap -p")
	out, stderr := &limitedBuffer{limit: 32 << 20}, &limitedBuffer{limit: 64 << 10}
	cmd.Stdout, cmd.Stderr = out, stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("截图失败: %w: %s", err, stderr.String())
	}
	data := out.Bytes()
	if !bytes.HasPrefix(data, []byte("\x89PNG\r\n\x1a\n")) {
		return nil, errors.New("设备未返回 PNG 截图")
	}
	return data, nil
}

func (c *Client) ExportAPK(ctx context.Context, serial, pkg string, index int, w io.Writer) error {
	text, err := c.Workbench(ctx, serial, "package-paths", pkg)
	if err != nil {
		return err
	}
	var paths []string
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(line, "package:/") && strings.HasSuffix(strings.TrimSpace(line), ".apk") {
			paths = append(paths, strings.TrimSpace(strings.TrimPrefix(line, "package:")))
		}
	}
	if index < 0 || index >= len(paths) {
		return errors.New("APK 文件不存在，请刷新应用详情")
	}
	cmd := hostexec.CommandContext(ctx, c.Bin, "-s", serial, "exec-out", "cat -- "+shellQuote(paths[index]))
	cmd.Stdout = w
	stderr := &limitedBuffer{limit: 64 << 10}
	cmd.Stderr = stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("导出 APK 失败: %w: %s", err, stderr.String())
	}
	return nil
}

type InstallOptions struct {
	Downgrade bool `json:"downgrade"`
	Test      bool `json:"test"`
}

func (c *Client) InstallSet(ctx context.Context, serial string, paths []string, opts InstallOptions) (string, error) {
	verb := "install"
	if len(paths) > 1 {
		verb = "install-multiple"
	}
	args := []string{"-s", serial, verb, "-r"}
	if opts.Downgrade {
		args = append(args, "-d")
	}
	if opts.Test {
		args = append(args, "-t")
	}
	args = append(args, paths...)
	cmd := hostexec.CommandContext(ctx, c.Bin, args...)
	stdout, stderr := &limitedBuffer{limit: 1 << 20}, &limitedBuffer{limit: 1 << 20}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	err := cmd.Run()
	text, err := installResult(stdout.String(), stderr.String(), err)
	if err != nil {
		return "", err
	}
	if !regexp.MustCompile(`(?m)^Success\s*$`).MatchString(text) {
		return "", fmt.Errorf("安装未成功: %s", text)
	}
	return text, nil
}
