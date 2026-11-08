//go:build windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func main() {
	if err := runUpdater(os.Args[1:]); err != nil {
		showUpdaterMessage("BA Spine Suite update", err.Error(), messageIconError)
		args := os.Args[1:]
		if len(args) == 5 && args[0] == "--install" && (args[4] == "editor" || args[4] == "viewer") {
			if root, rootErr := updaterRoot(); rootErr == nil {
				_ = launchSuiteApp(root, args[4])
			}
		}
	}
}

func runUpdater(args []string) error {
	root, err := updaterRoot()
	if err != nil {
		return err
	}
	if len(args) == 2 && args[0] == "--recover" {
		app := args[1]
		if app != "editor" && app != "viewer" {
			return fmt.Errorf("unsupported app launcher")
		}
		if _, err := recoverSuiteUpdate(root, processIsAlive); err != nil {
			return err
		}
		if err := validateSuiteContents(root, true); err != nil {
			return fmt.Errorf("suite recovery did not leave a valid installation: %w", err)
		}
		return launchSuiteApp(root, app)
	}
	if len(args) != 5 || args[0] != "--install" {
		return fmt.Errorf("usage: SuiteUpdater.exe --install <archive> <sha256> <version> <editor|viewer>")
	}
	archivePath, checksum, version, app := args[1], strings.ToLower(args[2]), args[3], args[4]
	if app != "editor" && app != "viewer" {
		return fmt.Errorf("unsupported app launcher")
	}
	if _, err := recoverSuiteUpdate(root, processIsAlive); err != nil {
		return err
	}
	manifest, err := suiteManifestAt(root)
	if err != nil {
		return err
	}
	version, err = normalizeStableVersion(version)
	if err != nil || !isNewerVersion(version, manifest.SuiteVersion) {
		return fmt.Errorf("the requested suite version is invalid or is not newer than the installed version")
	}
	if err := validateUpdateArchiveLocation(root, archivePath, version); err != nil {
		return err
	}
	if err := verifyArchiveDigest(archivePath, checksum); err != nil {
		return err
	}
	stage, err := extractSuiteArchive(root, archivePath, version)
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	if showUpdaterMessage("BA Spine Suite update", "The suite update is ready. Save any Editor work, then close both BA Spine apps. Click OK to wait for them to close, or Cancel to keep the current version.", messageIconInfo|messageButtonOKCancel) != messageOK {
		_ = launchSuiteApp(root, app)
		return nil
	}
	if err := waitForSuiteApps(root, 30*time.Minute); err != nil {
		return err
	}
	if err := applySuiteUpdate(root, stage, version, os.Getpid()); err != nil {
		return err
	}
	_ = os.Remove(archivePath)
	_ = os.Remove(strings.TrimSuffix(archivePath, ".zip") + ".zip.sha256")
	_ = os.Remove(filepath.Join(root, ".ba-spine-update", "suite-update-"+version+".json"))
	_ = os.Remove(filepath.Join(root, ".ba-spine-update"))
	return launchSuiteApp(root, app)
}

func updaterRoot() (string, error) {
	executable, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("cannot locate the suite updater: %w", err)
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		return "", fmt.Errorf("cannot resolve the suite updater: %w", err)
	}
	root, err := filepath.EvalSymlinks(filepath.Dir(executable))
	if err != nil {
		return "", fmt.Errorf("cannot resolve the suite directory: %w", err)
	}
	info, err := os.Stat(root)
	if err != nil || !info.IsDir() {
		return "", fmt.Errorf("suite directory is unavailable")
	}
	return root, nil
}

func launchSuiteApp(root, app string) error {
	name := "Editor.exe"
	if app == "viewer" {
		name = "Viewer.exe"
	}
	return startDetached(filepath.Join(root, name), nil, root)
}
