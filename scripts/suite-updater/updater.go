package main

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
)

const (
	suiteUpdateLockName    = ".ba-spine-update.lock"
	maxSuiteArchiveSize    = int64(3 * 1024 * 1024 * 1024)
	maxSuiteExpandedSize   = uint64(8 * 1024 * 1024 * 1024)
	maxSuiteArchiveEntries = 200_000
)

var stableVersionPattern = regexp.MustCompile(`^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$`)
var digestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

type suiteManifest struct {
	SchemaVersion int               `json:"schemaVersion"`
	SuiteVersion  string            `json:"suiteVersion"`
	Platform      string            `json:"platform"`
	Apps          map[string]string `json:"apps"`
	DataDirectory string            `json:"dataDirectory"`
}

type updateJournal struct {
	PID        int    `json:"pid"`
	Version    string `json:"version"`
	StageName  string `json:"stageName"`
	BackupName string `json:"backupName"`
}

var updateTargets = []string{"Editor.exe", "Viewer.exe", "README.txt", "licenses", "apps", "suite.json"}

func normalizeStableVersion(value string) (string, error) {
	value = strings.TrimPrefix(value, "v")
	if !stableVersionPattern.MatchString(value) {
		return "", fmt.Errorf("unsupported suite version %q", value)
	}
	return value, nil
}

func isNewerVersion(candidate, current string) bool {
	a, errA := normalizeStableVersion(candidate)
	b, errB := normalizeStableVersion(current)
	if errA != nil || errB != nil {
		return false
	}
	left := strings.SplitN(a, ".", 3)
	right := strings.SplitN(b, ".", 3)
	for index := range left {
		if len(left[index]) != len(right[index]) {
			return len(left[index]) > len(right[index])
		}
		if left[index] != right[index] {
			return left[index] > right[index]
		}
	}
	return false
}

func safeRelativeArchivePath(value string) (string, error) {
	if value == "" || strings.ContainsAny(value, "\\:\x00") || strings.HasPrefix(value, "/") {
		return "", fmt.Errorf("archive contains an unsafe path")
	}
	clean := strings.TrimSuffix(value, "/")
	if clean == "" || path.Clean(clean) != clean {
		return "", fmt.Errorf("archive contains an unsafe path")
	}
	for _, segment := range strings.Split(clean, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return "", fmt.Errorf("archive contains an unsafe path")
		}
	}
	return clean, nil
}

func suiteManifestAt(root string) (suiteManifest, error) {
	var manifest suiteManifest
	manifestPath := filepath.Join(root, "suite.json")
	info, err := os.Lstat(manifestPath)
	if err != nil {
		return manifest, fmt.Errorf("suite.json is unavailable: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > 16*1024 {
		return manifest, fmt.Errorf("suite.json must be a small regular file")
	}
	contents, err := os.ReadFile(manifestPath)
	if err != nil {
		return manifest, err
	}
	decoder := json.NewDecoder(strings.NewReader(string(contents)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil {
		return manifest, fmt.Errorf("suite.json is invalid: %w", err)
	}
	if manifest.SchemaVersion != 1 || manifest.Platform != "windows-x64" || manifest.DataDirectory != "data" {
		return manifest, fmt.Errorf("suite.json has an unsupported schema or platform")
	}
	version, err := normalizeStableVersion(manifest.SuiteVersion)
	if err != nil || version != manifest.SuiteVersion {
		return manifest, fmt.Errorf("suite.json has an invalid suite version")
	}
	if len(manifest.Apps) != 2 || manifest.Apps["editor"] != "apps/editor/BASpineEditor/bin/launcher.exe" || manifest.Apps["viewer"] != "apps/viewer/BASpineViewer/bin/launcher.exe" {
		return manifest, fmt.Errorf("suite.json does not declare the expected app bundles")
	}
	return manifest, nil
}

func validateSuiteContents(root string, requireData bool) error {
	manifest, err := suiteManifestAt(root)
	if err != nil {
		return err
	}
	for _, file := range []string{"Editor.exe", "Viewer.exe", "README.txt", "SuiteUpdater.exe"} {
		if err := requireRegularFile(filepath.Join(root, file)); err != nil {
			return fmt.Errorf("%s is missing or invalid: %w", file, err)
		}
	}
	for _, directory := range []string{"apps", "licenses"} {
		if err := requireRegularDirectory(filepath.Join(root, directory)); err != nil {
			return fmt.Errorf("%s is missing or invalid: %w", directory, err)
		}
	}
	for _, app := range []string{"editor", "viewer"} {
		launcher := filepath.Join(root, filepath.FromSlash(manifest.Apps[app]))
		if err := requireRegularFile(launcher); err != nil {
			return fmt.Errorf("%s app bundle is incomplete: %w", app, err)
		}
	}
	if requireData {
		dataPath := filepath.Join(root, manifest.DataDirectory)
		if err := requireRegularDirectory(dataPath); err != nil {
			return fmt.Errorf("suite data directory is missing or invalid: %w", err)
		}
	}
	return nil
}

func requireRegularFile(value string) error {
	info, err := os.Lstat(value)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("expected a regular file")
	}
	return nil
}

func requireRegularDirectory(value string) error {
	info, err := os.Lstat(value)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("expected a regular directory")
	}
	return nil
}

func verifyArchiveDigest(archivePath, expected string) error {
	if !digestPattern.MatchString(expected) {
		return fmt.Errorf("suite update checksum is invalid")
	}
	info, err := os.Lstat(archivePath)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() <= 0 || info.Size() > maxSuiteArchiveSize {
		return fmt.Errorf("suite update archive is missing, unsafe, or too large")
	}
	file, err := os.Open(archivePath)
	if err != nil {
		return err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, io.LimitReader(file, maxSuiteArchiveSize+1)); err != nil {
		return err
	}
	if hex.EncodeToString(hash.Sum(nil)) != expected {
		return fmt.Errorf("suite update archive does not match its SHA-256 checksum")
	}
	return nil
}

func extractSuiteArchive(root, archivePath, expectedVersion string) (string, error) {
	archive, err := os.Open(archivePath)
	if err != nil {
		return "", err
	}
	defer archive.Close()
	info, err := archive.Stat()
	if err != nil {
		return "", err
	}
	reader, err := zip.NewReader(archive, info.Size())
	if err != nil {
		return "", fmt.Errorf("suite update ZIP is invalid: %w", err)
	}
	if len(reader.File) == 0 || len(reader.File) > maxSuiteArchiveEntries {
		return "", fmt.Errorf("suite update ZIP has an invalid entry count")
	}
	stage, err := os.MkdirTemp(root, ".ba-spine-update-stage-")
	if err != nil {
		return "", err
	}
	keepStage := false
	defer func() {
		if !keepStage {
			_ = os.RemoveAll(stage)
		}
	}()
	seen := make(map[string]struct{}, len(reader.File))
	var expandedBytes uint64
	hasDataReadme := false
	for _, entry := range reader.File {
		name, err := safeRelativeArchivePath(entry.Name)
		if err != nil {
			return "", fmt.Errorf("suite update ZIP: %w", err)
		}
		folded := strings.ToLower(name)
		if _, exists := seen[folded]; exists {
			return "", fmt.Errorf("suite update ZIP contains a duplicate path")
		}
		seen[folded] = struct{}{}
		parts := strings.Split(name, "/")
		top := parts[0]
		if top != "Editor.exe" && top != "Viewer.exe" && top != "README.txt" && top != "suite.json" && top != "SuiteUpdater.exe" && top != "apps" && top != "licenses" && top != "data" {
			return "", fmt.Errorf("suite update ZIP contains an unexpected top-level path")
		}
		isDirectory := entry.FileInfo().IsDir() || strings.HasSuffix(entry.Name, "/")
		mode := entry.Mode()
		if mode&os.ModeSymlink != 0 || (!isDirectory && !mode.IsRegular()) {
			return "", fmt.Errorf("suite update ZIP contains a link or special file")
		}
		if entry.UncompressedSize64 > maxSuiteExpandedSize-expandedBytes {
			return "", fmt.Errorf("suite update ZIP expands beyond the size limit")
		}
		expandedBytes += entry.UncompressedSize64
		if top == "data" {
			if isDirectory && name == "data" {
				continue
			}
			if isDirectory || name != "data/README.txt" || entry.UncompressedSize64 > 4096 {
				return "", fmt.Errorf("suite update ZIP contains unexpected data directory content")
			}
			if err := consumeZipEntry(entry); err != nil {
				return "", err
			}
			hasDataReadme = true
			continue
		}
		destination := filepath.Join(stage, filepath.FromSlash(name))
		if !pathWithin(stage, destination) {
			return "", fmt.Errorf("suite update ZIP path escapes its stage directory")
		}
		if isDirectory {
			if err := os.MkdirAll(destination, 0755); err != nil {
				return "", err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(destination), 0755); err != nil {
			return "", err
		}
		if err := extractZipFile(entry, destination); err != nil {
			return "", err
		}
	}
	if !hasDataReadme {
		return "", fmt.Errorf("suite update ZIP is missing the data placeholder README")
	}
	if err := validateSuiteContents(stage, false); err != nil {
		return "", fmt.Errorf("suite update ZIP is incomplete: %w", err)
	}
	manifest, err := suiteManifestAt(stage)
	if err != nil {
		return "", err
	}
	version, err := normalizeStableVersion(expectedVersion)
	if err != nil || manifest.SuiteVersion != version {
		return "", fmt.Errorf("suite update ZIP version does not match the requested version")
	}
	keepStage = true
	return stage, nil
}

func consumeZipEntry(entry *zip.File) error {
	input, err := entry.Open()
	if err != nil {
		return err
	}
	defer input.Close()
	length, err := io.Copy(io.Discard, io.LimitReader(input, 4097))
	if err == nil && (length != int64(entry.UncompressedSize64) || length > 4096) {
		return fmt.Errorf("suite update ZIP data placeholder size is invalid")
	}
	return err
}

func extractZipFile(entry *zip.File, destination string) error {
	input, err := entry.Open()
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, entry.Mode().Perm()&0755)
	if err != nil {
		return err
	}
	length, copyErr := io.Copy(output, io.LimitReader(input, int64(entry.UncompressedSize64)+1))
	closeErr := output.Close()
	if copyErr != nil {
		_ = os.Remove(destination)
		return copyErr
	}
	if closeErr != nil {
		_ = os.Remove(destination)
		return closeErr
	}
	if length != int64(entry.UncompressedSize64) {
		_ = os.Remove(destination)
		return fmt.Errorf("suite update ZIP entry length does not match its metadata")
	}
	return nil
}

func pathWithin(root, candidate string) bool {
	relative, err := filepath.Rel(root, candidate)
	return err == nil && relative != "." && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative)
}

func applySuiteUpdate(root, stage, version string, pid int) error {
	current, err := suiteManifestAt(root)
	if err != nil {
		return err
	}
	if !isNewerVersion(version, current.SuiteVersion) {
		return fmt.Errorf("suite update is not newer than the installed version")
	}
	if err := validateSuiteContents(root, true); err != nil {
		return fmt.Errorf("installed suite is incomplete: %w", err)
	}
	backup, err := os.MkdirTemp(root, ".ba-spine-update-backup-")
	if err != nil {
		return err
	}
	journal := updateJournal{PID: pid, Version: version, StageName: filepath.Base(stage), BackupName: filepath.Base(backup)}
	if err := createJournal(root, journal); err != nil {
		_ = os.RemoveAll(backup)
		return err
	}
	for _, name := range updateTargets {
		target := filepath.Join(root, name)
		staged := filepath.Join(stage, name)
		backupTarget := filepath.Join(backup, name)
		if err := os.Rename(target, backupTarget); err != nil {
			return rollbackAfterFailure(root, journal, fmt.Errorf("could not stage existing %s: %w", name, err))
		}
		if err := os.Rename(staged, target); err != nil {
			return rollbackAfterFailure(root, journal, fmt.Errorf("could not install %s: %w", name, err))
		}
	}
	installed, err := suiteManifestAt(root)
	if err != nil || installed.SuiteVersion != version {
		return rollbackAfterFailure(root, journal, errors.New("installed suite manifest did not verify"))
	}
	// The new suite is committed after verification; a partial backup cleanup
	// cannot be rolled back safely because some old files may already be gone.
	_ = os.RemoveAll(backup)
	if err := os.RemoveAll(stage); err != nil {
		return fmt.Errorf("suite update succeeded but staging cleanup failed: %w", err)
	}
	if err := os.Remove(filepath.Join(root, suiteUpdateLockName)); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("suite update succeeded but update lock cleanup failed: %w", err)
	}
	return nil
}

func createJournal(root string, journal updateJournal) error {
	file, err := os.OpenFile(filepath.Join(root, suiteUpdateLockName), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return fmt.Errorf("another suite update is already running")
	}
	encodeErr := json.NewEncoder(file).Encode(journal)
	syncErr := file.Sync()
	closeErr := file.Close()
	if encodeErr != nil || syncErr != nil || closeErr != nil {
		_ = os.Remove(filepath.Join(root, suiteUpdateLockName))
		return errors.Join(encodeErr, syncErr, closeErr)
	}
	return nil
}

func rollbackAfterFailure(root string, journal updateJournal, cause error) error {
	if rollbackErr := rollbackSuiteUpdate(root, journal); rollbackErr != nil {
		return fmt.Errorf("%v; rollback needs attention: %w", cause, rollbackErr)
	}
	return cause
}

func readJournal(root string) (updateJournal, error) {
	var journal updateJournal
	path := filepath.Join(root, suiteUpdateLockName)
	info, err := os.Lstat(path)
	if err != nil {
		return journal, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > 4096 {
		return journal, fmt.Errorf("suite update lock is invalid")
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		return journal, err
	}
	if err := json.Unmarshal(contents, &journal); err != nil {
		return journal, fmt.Errorf("suite update lock is invalid: %w", err)
	}
	version, versionErr := normalizeStableVersion(journal.Version)
	if journal.PID <= 0 || versionErr != nil || version != journal.Version ||
		!strings.HasPrefix(journal.StageName, ".ba-spine-update-stage-") || filepath.Base(journal.StageName) != journal.StageName ||
		!strings.HasPrefix(journal.BackupName, ".ba-spine-update-backup-") || filepath.Base(journal.BackupName) != journal.BackupName {
		return journal, fmt.Errorf("suite update lock contains unsafe recovery paths")
	}
	return journal, nil
}

func rollbackSuiteUpdate(root string, journal updateJournal) error {
	backup := filepath.Join(root, journal.BackupName)
	var failures []error
	for index := len(updateTargets) - 1; index >= 0; index-- {
		name := updateTargets[index]
		backupTarget := filepath.Join(backup, name)
		if _, err := os.Lstat(backupTarget); err != nil {
			if !os.IsNotExist(err) {
				failures = append(failures, err)
			}
			continue
		}
		target := filepath.Join(root, name)
		if err := removeKnownTarget(target); err != nil {
			failures = append(failures, fmt.Errorf("could not remove partial %s: %w", name, err))
			continue
		}
		if err := os.Rename(backupTarget, target); err != nil {
			failures = append(failures, fmt.Errorf("could not restore %s: %w", name, err))
		}
	}
	if len(failures) > 0 {
		return errors.Join(failures...)
	}
	if err := os.RemoveAll(filepath.Join(root, journal.StageName)); err != nil {
		return err
	}
	if err := os.RemoveAll(backup); err != nil {
		return err
	}
	if err := os.Remove(filepath.Join(root, suiteUpdateLockName)); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func removeKnownTarget(target string) error {
	info, err := os.Lstat(target)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || (!info.IsDir() && !info.Mode().IsRegular()) {
		return fmt.Errorf("refusing to remove a symlink or special file")
	}
	return os.RemoveAll(target)
}

// recoverSuiteUpdate rolls back an interrupted file swap, or finishes cleanup if the new manifest was committed.
func recoverSuiteUpdate(root string, processAlive func(int) bool) (bool, error) {
	journal, err := readJournal(root)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if processAlive(journal.PID) {
		return true, fmt.Errorf("a suite update is still running")
	}
	manifest, manifestErr := suiteManifestAt(root)
	if manifestErr == nil && manifest.SuiteVersion == journal.Version && validateSuiteContents(root, true) == nil {
		_ = os.RemoveAll(filepath.Join(root, journal.BackupName))
		_ = os.RemoveAll(filepath.Join(root, journal.StageName))
		if err := os.Remove(filepath.Join(root, suiteUpdateLockName)); err != nil && !os.IsNotExist(err) {
			return true, err
		}
		return true, nil
	}
	if err := rollbackSuiteUpdate(root, journal); err != nil {
		return true, fmt.Errorf("interrupted suite update could not be rolled back: %w", err)
	}
	return true, nil
}

func validateUpdateArchiveLocation(root, archivePath string, version string) error {
	version, err := normalizeStableVersion(version)
	if err != nil {
		return err
	}
	root, err = filepath.Abs(root)
	if err != nil {
		return err
	}
	archivePath, err = filepath.Abs(archivePath)
	if err != nil {
		return err
	}
	updateDirectory := filepath.Join(root, ".ba-spine-update")
	updateInfo, err := os.Lstat(updateDirectory)
	if err != nil || !updateInfo.IsDir() || updateInfo.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("suite update staging directory is missing or unsafe")
	}
	actualUpdateDirectory, err := filepath.EvalSymlinks(updateDirectory)
	if err != nil || !samePath(actualUpdateDirectory, updateDirectory) {
		return fmt.Errorf("suite update staging directory resolves outside the suite")
	}
	relative, err := filepath.Rel(root, archivePath)
	if err != nil || filepath.IsAbs(relative) || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return fmt.Errorf("suite update archive must be inside the suite")
	}
	parts := strings.Split(filepath.ToSlash(relative), "/")
	expectedName := fmt.Sprintf("BA-Spine-Suite-%s-win-x64.zip", version)
	if len(parts) != 2 || parts[0] != ".ba-spine-update" || parts[1] != expectedName {
		return fmt.Errorf("suite update archive path is invalid")
	}
	archiveInfo, err := os.Lstat(archivePath)
	if err != nil || !archiveInfo.Mode().IsRegular() || archiveInfo.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("suite update archive is missing or unsafe")
	}
	return nil
}

func samePath(left, right string) bool {
	left = filepath.Clean(left)
	right = filepath.Clean(right)
	if os.PathSeparator == '\\' {
		return strings.EqualFold(left, right)
	}
	return left == right
}
