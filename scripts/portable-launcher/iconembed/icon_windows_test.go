//go:build windows

package main

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"unsafe"
)

func TestEmbedBrandIconAddsAWindowsGroupIconResource(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	copyPath := filepath.Join(t.TempDir(), "portable-launcher-test.exe")
	contents, err := os.ReadFile(executable)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(copyPath, contents, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := embedBrandIcon(copyPath); err != nil {
		t.Fatal(err)
	}

	path, err := syscall.UTF16PtrFromString(copyPath)
	if err != nil {
		t.Fatal(err)
	}
	loadLibraryExW := syscall.NewLazyDLL("kernel32.dll").NewProc("LoadLibraryExW")
	module, _, callErr := loadLibraryExW.Call(uintptr(unsafe.Pointer(path)), 0, 0x22)
	if module == 0 {
		t.Fatalf("LoadLibraryExW failed: %v", callErr)
	}
	defer syscall.NewLazyDLL("kernel32.dll").NewProc("FreeLibrary").Call(module)

	findResourceW := syscall.NewLazyDLL("kernel32.dll").NewProc("FindResourceW")
	resource, _, callErr := findResourceW.Call(module, 1, 14)
	if resource == 0 {
		t.Fatalf("FindResourceW did not find RT_GROUP_ICON: %v", callErr)
	}
	sizeOfResource := syscall.NewLazyDLL("kernel32.dll").NewProc("SizeofResource")
	resourceSize, _, callErr := sizeOfResource.Call(module, resource)
	if resourceSize < 6+14*uintptr(len(iconSizes)) {
		t.Fatalf("group icon resource size = %d, error %v", resourceSize, callErr)
	}
	for index := range iconSizes {
		iconResource, _, iconErr := findResourceW.Call(module, uintptr(index+1), 3)
		if iconResource == 0 {
			t.Fatalf("FindResourceW did not find RT_ICON id %d: %v", index+1, iconErr)
		}
		iconSize, _, iconErr := sizeOfResource.Call(module, iconResource)
		if iconSize < 40 {
			t.Fatalf("RT_ICON id %d size = %d, error %v", index+1, iconSize, iconErr)
		}
	}
}
