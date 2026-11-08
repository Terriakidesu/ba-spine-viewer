//go:build windows

package main

import (
	"fmt"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const (
	th32csSnapProcess              = 0x00000002
	processQueryLimitedInformation = 0x1000
	waitTimeout                    = 258
	createNewProcessGroup          = 0x00000200
	detachedProcess                = 0x00000008
	messageButtonOKCancel          = 0x00000001
	messageIconInfo                = 0x00000040
	messageIconError               = 0x00000010
	messageOK                      = 1
)

var (
	kernel32                  = syscall.NewLazyDLL("kernel32.dll")
	queryFullProcessImageName = kernel32.NewProc("QueryFullProcessImageNameW")
	waitForSingleObject       = kernel32.NewProc("WaitForSingleObject")
	user32                    = syscall.NewLazyDLL("user32.dll")
	messageBox                = user32.NewProc("MessageBoxW")
)

func suiteAppProcesses(root string) ([]string, error) {
	snapshot, err := syscall.CreateToolhelp32Snapshot(th32csSnapProcess, 0)
	if err != nil {
		return nil, err
	}
	defer syscall.CloseHandle(snapshot)
	var entry syscall.ProcessEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	if err := syscall.Process32First(snapshot, &entry); err != nil {
		return nil, err
	}
	rootPrefix := strings.ToLower(filepath.Clean(root) + string(filepath.Separator) + "apps" + string(filepath.Separator))
	var running []string
	for {
		image := processImagePath(entry.ProcessID)
		if image != "" {
			clean := strings.ToLower(filepath.Clean(image))
			if strings.HasPrefix(clean, rootPrefix) {
				running = append(running, image)
			}
		}
		if err := syscall.Process32Next(snapshot, &entry); err != nil {
			if err == syscall.ERROR_NO_MORE_FILES {
				break
			}
			return nil, err
		}
	}
	return running, nil
}

func processImagePath(pid uint32) string {
	handle, err := syscall.OpenProcess(processQueryLimitedInformation, false, pid)
	if err != nil {
		return ""
	}
	defer syscall.CloseHandle(handle)
	buffer := make([]uint16, 32768)
	length := uint32(len(buffer))
	result, _, _ := queryFullProcessImageName.Call(uintptr(handle), 0, uintptr(unsafe.Pointer(&buffer[0])), uintptr(unsafe.Pointer(&length)))
	if result == 0 || length == 0 || length > uint32(len(buffer)) {
		return ""
	}
	return syscall.UTF16ToString(buffer[:length])
}

func processIsAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	handle, err := syscall.OpenProcess(syscall.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		// Treat access-denied as alive; recovery must not race an inaccessible owner.
		return err != syscall.Errno(87)
	}
	defer syscall.CloseHandle(handle)
	result, _, _ := waitForSingleObject.Call(uintptr(handle), 0)
	return result == waitTimeout
}

func waitForSuiteApps(root string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		running, err := suiteAppProcesses(root)
		if err != nil {
			return fmt.Errorf("could not check whether suite apps are closed: %w", err)
		}
		if len(running) == 0 {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("timed out waiting for both suite apps to close; close BA Spine Editor and Viewer, then retry the update")
		}
		time.Sleep(500 * time.Millisecond)
	}
}

func showUpdaterMessage(title, text string, flags uintptr) int {
	titlePointer, _ := syscall.UTF16PtrFromString(title)
	textPointer, _ := syscall.UTF16PtrFromString(text)
	result, _, _ := messageBox.Call(0, uintptr(unsafe.Pointer(textPointer)), uintptr(unsafe.Pointer(titlePointer)), flags)
	return int(result)
}

func startDetached(executable string, args []string, workingDirectory string) error {
	command := syscall.StringToUTF16Ptr(executable)
	parts := make([]string, len(args)+1)
	parts[0] = executable
	copy(parts[1:], args)
	quoted := make([]string, len(parts))
	for index, value := range parts {
		quoted[index] = syscall.EscapeArg(value)
	}
	arguments := syscall.StringToUTF16Ptr(strings.Join(quoted, " "))
	working, err := syscall.UTF16PtrFromString(workingDirectory)
	if err != nil {
		return err
	}
	startup := syscall.StartupInfo{}
	startup.Cb = uint32(unsafe.Sizeof(startup))
	var process syscall.ProcessInformation
	err = syscall.CreateProcess(command, arguments, nil, nil, false, createNewProcessGroup|detachedProcess, nil, working, &startup, &process)
	if err != nil {
		return err
	}
	_ = syscall.CloseHandle(process.Thread)
	_ = syscall.CloseHandle(process.Process)
	return nil
}
