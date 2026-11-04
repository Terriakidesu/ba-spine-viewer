//go:build windows

package main

import (
	"fmt"
	"os"
	"runtime"
	"syscall"
	"unsafe"
)

var (
	kernel32             = syscall.NewLazyDLL("kernel32.dll")
	beginUpdateResourceW = kernel32.NewProc("BeginUpdateResourceW")
	updateResourceW      = kernel32.NewProc("UpdateResourceW")
	endUpdateResourceW   = kernel32.NewProc("EndUpdateResourceW")
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: go run ./iconembed <launcher.exe>")
		os.Exit(2)
	}
	if err := embedBrandIcon(os.Args[1]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func embedBrandIcon(path string) error {
	images := make([][]byte, len(iconSizes))
	for index, size := range iconSizes {
		images[index] = makeIconDIB(size)
	}
	group, err := iconGroupResource(images)
	if err != nil {
		return err
	}

	widePath, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return fmt.Errorf("invalid launcher path: %w", err)
	}
	if err := beginUpdateResourceW.Find(); err != nil {
		return err
	}
	handle, _, callErr := beginUpdateResourceW.Call(uintptr(unsafe.Pointer(widePath)), 0)
	if handle == 0 {
		return win32CallError("BeginUpdateResourceW", callErr)
	}
	finished := false
	defer func() {
		if !finished {
			endUpdateResourceW.Call(handle, 1)
		}
	}()

	for index, image := range images {
		if err := updateIconResource(handle, 3, uintptr(index+1), image); err != nil {
			return err
		}
	}
	if err := updateIconResource(handle, 14, 1, group); err != nil {
		return err
	}
	result, _, callErr := endUpdateResourceW.Call(handle, 0)
	if result == 0 {
		return win32CallError("EndUpdateResourceW", callErr)
	}
	finished = true
	return nil
}

func updateIconResource(handle, resourceType, resourceName uintptr, data []byte) error {
	if len(data) == 0 {
		return fmt.Errorf("refusing to write an empty Windows icon resource")
	}
	result, _, callErr := updateResourceW.Call(
		handle,
		resourceType,
		resourceName,
		0,
		uintptr(unsafe.Pointer(&data[0])),
		uintptr(len(data)),
	)
	runtime.KeepAlive(data)
	if result == 0 {
		return win32CallError("UpdateResourceW", callErr)
	}
	return nil
}

func win32CallError(api string, callErr error) error {
	if callErr == nil || callErr == syscall.Errno(0) {
		return fmt.Errorf("%s failed without a Windows error code", api)
	}
	return fmt.Errorf("%s failed: %w", api, callErr)
}
