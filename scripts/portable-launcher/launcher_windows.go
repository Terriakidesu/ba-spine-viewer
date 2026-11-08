//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

const (
	detachedProcess       = 0x00000008
	createNewProcessGroup = 0x00000200
	messageBoxError       = 0x00000010
)

func main() {
	if app != "editor" && app != "viewer" {
		showError("This BA Spine Suite launcher is not configured for a supported app.")
		os.Exit(1)
	}
	if err := launch(os.Args[1:]); err != nil {
		showError(fmt.Sprintf("BA Spine %s could not start.\n\n%s", strings.Title(app), err.Error()))
		os.Exit(1)
	}
}

func launch(args []string) error {
	executable, err := os.Executable()
	if err != nil {
		return fmt.Errorf("cannot locate this launcher: %w", err)
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		return fmt.Errorf("cannot resolve this launcher: %w", err)
	}
	root, err := filepath.EvalSymlinks(filepath.Dir(executable))
	if err != nil {
		return fmt.Errorf("cannot resolve the suite directory: %w", err)
	}
	rootInfo, err := os.Stat(root)
	if err != nil || !rootInfo.IsDir() {
		return fmt.Errorf("suite directory is unavailable")
	}
	if info, err := os.Lstat(filepath.Join(root, ".ba-spine-update.lock")); err == nil {
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("suite update recovery marker is invalid")
		}
		updater := filepath.Join(root, "SuiteUpdater.exe")
		updaterInfo, err := os.Lstat(updater)
		if err != nil || !updaterInfo.Mode().IsRegular() || updaterInfo.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("suite update was interrupted and the recovery helper is unavailable")
		}
		recovery := exec.Command(updater, "--recover", app)
		recovery.Dir = root
		recovery.SysProcAttr = &syscall.SysProcAttr{CreationFlags: detachedProcess | createNewProcessGroup}
		if err := recovery.Start(); err != nil {
			return fmt.Errorf("could not start suite update recovery: %w", err)
		}
		return recovery.Process.Release()
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("suite update state could not be checked: %w", err)
	}
	manifest, dataPath, err := parseManifest(root)
	if err != nil {
		return err
	}
	target, err := appExecutable(root, manifest)
	if err != nil {
		return err
	}
	command := exec.Command(target, args...)
	command.Dir = root
	environment := os.Environ()
	environment = replaceEnvironment(environment, "BA_SPINE_SUITE_ROOT", root)
	environment = replaceEnvironment(environment, "BA_SPINE_SUITE_DATA", dataPath)
	for _, key := range []string{"BA_SPINE_WORKSPACE_ROOT", "BA_SPINE_EDITOR_MCP", "BA_SPINE_EDITOR_WAVEFORM_PROFILE"} {
		environment = removeEnvironment(environment, key)
	}
	command.Env = environment
	command.SysProcAttr = &syscall.SysProcAttr{CreationFlags: detachedProcess | createNewProcessGroup}
	if err := command.Start(); err != nil {
		return fmt.Errorf("cannot start the %s app bundle: %w", app, err)
	}
	return command.Process.Release()
}

func removeEnvironment(values []string, key string) []string {
	prefix := strings.ToUpper(key + "=")
	result := make([]string, 0, len(values))
	for _, item := range values {
		if !strings.HasPrefix(strings.ToUpper(item), prefix) {
			result = append(result, item)
		}
	}
	return result
}

func showError(message string) {
	user32 := syscall.NewLazyDLL("user32.dll")
	messageBox := user32.NewProc("MessageBoxW")
	text, _ := syscall.UTF16PtrFromString(message)
	title, _ := syscall.UTF16PtrFromString("BA Spine Suite")
	messageBox.Call(0, uintptr(unsafe.Pointer(text)), uintptr(unsafe.Pointer(title)), messageBoxError)
}
