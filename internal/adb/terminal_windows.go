package adb

import (
	"fmt"
	"os"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

type shellTerminal struct {
	input, output *os.File
	process       windows.Handle
	console       windows.Handle
	consoleMu     sync.Mutex
	once          sync.Once
	done          chan struct{}
}

func (c *Client) OpenTerminal(serial string, rows, cols uint16) (Terminal, error) {
	return startWindowsTerminal([]string{c.Bin, "-s", serial, "shell", "-tt"}, rows, cols)
}

func startWindowsTerminal(args []string, rows, cols uint16) (_ *shellTerminal, err error) {
	// ConPTY supplies a real console to adb, including control keys and size
	// changes, without opening a separate console window on the host.
	if err := windows.NewLazySystemDLL("kernel32.dll").NewProc("CreatePseudoConsole").Find(); err != nil {
		return nil, fmt.Errorf("Windows 终端需要 Windows 10 1809 或更新版本: %w", err)
	}
	if rows == 0 || cols == 0 || rows > 32767 || cols > 32767 {
		return nil, fmt.Errorf("invalid terminal size: %dx%d", cols, rows)
	}
	application, err := windows.UTF16PtrFromString(args[0])
	if err != nil {
		return nil, err
	}
	commandLine, err := windows.UTF16PtrFromString(windows.ComposeCommandLine(args))
	if err != nil {
		return nil, err
	}

	// CreatePipe supplies the synchronous, non-inheritable handles ConPTY
	// needs. Wrap only our ends in os.File so Close can cancel blocked I/O.
	var inputRead, inputWrite windows.Handle
	if err := windows.CreatePipe(&inputRead, &inputWrite, nil, 0); err != nil {
		return nil, err
	}
	defer windows.CloseHandle(inputRead)
	input := os.NewFile(uintptr(inputWrite), "android-terminal-input")
	defer func() {
		if err != nil {
			_ = input.Close()
		}
	}()
	var outputRead, outputWrite windows.Handle
	if err := windows.CreatePipe(&outputRead, &outputWrite, nil, 0); err != nil {
		return nil, err
	}
	defer windows.CloseHandle(outputWrite)
	output := os.NewFile(uintptr(outputRead), "android-terminal-output")
	defer func() {
		if err != nil {
			_ = output.Close()
		}
	}()
	var console windows.Handle
	if err := windows.CreatePseudoConsole(windows.Coord{X: int16(cols), Y: int16(rows)}, inputRead, outputWrite, 0, &console); err != nil {
		return nil, fmt.Errorf("create Windows terminal: %w", err)
	}
	defer func() {
		if err != nil {
			// Close output before ConPTY to avoid shutdown deadlocks on Windows 10.
			_ = output.Close()
			windows.ClosePseudoConsole(console)
		}
	}()
	attributes, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		return nil, err
	}
	defer attributes.Delete()
	// Unlike most attributes, PSEUDOCONSOLE takes the handle itself, not its
	// address. Reinterpret its bits without uintptr-to-pointer arithmetic.
	consolePointer := *(*unsafe.Pointer)(unsafe.Pointer(&console))
	if err := attributes.Update(windows.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, consolePointer, unsafe.Sizeof(console)); err != nil {
		return nil, err
	}
	startup := windows.StartupInfoEx{
		StartupInfo:             windows.StartupInfo{Cb: uint32(unsafe.Sizeof(windows.StartupInfoEx{}))},
		ProcThreadAttributeList: attributes.List(),
	}
	var process windows.ProcessInformation
	if err := windows.CreateProcess(application, commandLine, nil, nil, false, windows.EXTENDED_STARTUPINFO_PRESENT, nil, nil, &startup.StartupInfo, &process); err != nil {
		return nil, fmt.Errorf("start adb terminal: %w", err)
	}
	_ = windows.CloseHandle(process.Thread)
	terminal := &shellTerminal{input: input, output: output, process: process.Process, console: console, done: make(chan struct{})}
	go func() {
		_, _ = windows.WaitForSingleObject(terminal.process, windows.INFINITE)
		// Closing ConPTY after adb exits lets the reader receive EOF. Leave the
		// output pipe open here so any final output can still be consumed.
		terminal.closeConsole()
		close(terminal.done)
	}()
	return terminal, nil
}

func (t *shellTerminal) Read(data []byte) (int, error) {
	return t.output.Read(data)
}

func (t *shellTerminal) Write(data []byte) (int, error) {
	return t.input.Write(data)
}

func (t *shellTerminal) Resize(rows, cols uint16) error {
	t.consoleMu.Lock()
	defer t.consoleMu.Unlock()
	if t.console == 0 {
		return os.ErrClosed
	}
	if rows == 0 || cols == 0 || rows > 32767 || cols > 32767 {
		return fmt.Errorf("invalid terminal size: %dx%d", cols, rows)
	}
	return windows.ResizePseudoConsole(t.console, windows.Coord{X: int16(cols), Y: int16(rows)})
}

func (t *shellTerminal) closeConsole() {
	t.consoleMu.Lock()
	defer t.consoleMu.Unlock()
	if t.console != 0 {
		windows.ClosePseudoConsole(t.console)
		t.console = 0
	}
}

func (t *shellTerminal) Close() error {
	t.once.Do(func() {
		_ = windows.TerminateProcess(t.process, 0)
		// os.File.Close cancels blocked pipe I/O. In particular, closing output
		// must precede ClosePseudoConsole, which can write a final screen frame.
		_ = t.input.Close()
		_ = t.output.Close()
		t.closeConsole()
		<-t.done
		_ = windows.CloseHandle(t.process)
	})
	return nil
}
