package main

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func testManifest(version string) suiteManifest {
	return suiteManifest{
		SchemaVersion: 1,
		SuiteVersion:  version,
		Platform:      "windows-x64",
		Apps: map[string]string{
			"editor": "apps/editor/BASpineEditor/bin/launcher.exe",
			"viewer": "apps/viewer/BASpineViewer/bin/launcher.exe",
		},
		DataDirectory: "data",
	}
}

func writeTestSuite(t *testing.T, root, version, marker string) {
	t.Helper()
	writeTestFile(t, root, "Editor.exe", "editor-root-"+marker)
	writeTestFile(t, root, "Viewer.exe", "viewer-root-"+marker)
	writeTestFile(t, root, "README.txt", "readme-"+marker)
	writeTestFile(t, root, "SuiteUpdater.exe", "existing-updater")
	writeTestFile(t, root, "suite.json", mustJSON(t, testManifest(version)))
	writeTestFile(t, root, "apps/editor/BASpineEditor/bin/launcher.exe", "editor-app-"+marker)
	writeTestFile(t, root, "apps/viewer/BASpineViewer/bin/launcher.exe", "viewer-app-"+marker)
	writeTestFile(t, root, "licenses/LICENSE.txt", "license-"+marker)
	writeTestFile(t, root, "data/README.txt", "placeholder")
}

func writeTestFile(t *testing.T, root, relativePath, content string) {
	t.Helper()
	full := filepath.Join(root, filepath.FromSlash(relativePath))
	if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
}

func mustJSON(t *testing.T, value any) string {
	t.Helper()
	bytes, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(bytes)
}

func writeTestArchive(t *testing.T, archivePath, version string, extra map[string]string) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(archivePath), 0755); err != nil {
		t.Fatal(err)
	}
	file, err := os.Create(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(file)
	entries := map[string]string{
		"Editor.exe":       "editor-root-new",
		"Viewer.exe":       "viewer-root-new",
		"README.txt":       "readme-new",
		"SuiteUpdater.exe": "new-updater-not-installed-by-current-helper",
		"suite.json":       mustJSON(t, testManifest(version)),
		"apps/editor/BASpineEditor/bin/launcher.exe": "editor-app-new",
		"apps/viewer/BASpineViewer/bin/launcher.exe": "viewer-app-new",
		"licenses/LICENSE.txt":                       "license-new",
		"data/README.txt":                            "placeholder",
	}
	for name, content := range extra {
		entries[name] = content
	}
	for _, name := range []string{"apps/", "apps/editor/", "apps/editor/BASpineEditor/", "apps/editor/BASpineEditor/bin/", "apps/viewer/", "apps/viewer/BASpineViewer/", "apps/viewer/BASpineViewer/bin/", "licenses/", "data/"} {
		header := &zip.FileHeader{Name: name, Method: zip.Deflate}
		header.SetMode(os.ModeDir | 0755)
		if _, err := writer.CreateHeader(header); err != nil {
			t.Fatal(err)
		}
	}
	for name, content := range entries {
		header := &zip.FileHeader{Name: name, Method: zip.Deflate}
		header.SetMode(0644)
		entry, err := writer.CreateHeader(header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.WriteString(entry, content); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	bytes, err := os.ReadFile(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(bytes)
	return hex.EncodeToString(digest[:])
}

func readTestFile(t *testing.T, root, relativePath string) string {
	t.Helper()
	contents, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(relativePath)))
	if err != nil {
		t.Fatal(err)
	}
	return string(contents)
}

func TestSuiteUpdateReplacesBothAppsAndPreservesDataAndUpdater(t *testing.T) {
	root := t.TempDir()
	writeTestSuite(t, root, "0.2.0", "old")
	writeTestFile(t, root, "data/authored-project.json", "keep-this")
	archive := filepath.Join(root, ".ba-spine-update", "BA-Spine-Suite-0.3.0-win-x64.zip")
	digest := writeTestArchive(t, archive, "0.3.0", nil)
	if err := validateUpdateArchiveLocation(root, archive, "0.3.0"); err != nil {
		t.Fatal(err)
	}
	if err := verifyArchiveDigest(archive, digest); err != nil {
		t.Fatal(err)
	}
	stage, err := extractSuiteArchive(root, archive, "0.3.0")
	if err != nil {
		t.Fatal(err)
	}
	if err := applySuiteUpdate(root, stage, "0.3.0", os.Getpid()); err != nil {
		t.Fatal(err)
	}
	manifest, err := suiteManifestAt(root)
	if err != nil {
		t.Fatal(err)
	}
	if manifest.SuiteVersion != "0.3.0" {
		t.Fatalf("suite version = %q", manifest.SuiteVersion)
	}
	if got := readTestFile(t, root, "apps/editor/BASpineEditor/bin/launcher.exe"); got != "editor-app-new" {
		t.Fatalf("Editor bundle = %q", got)
	}
	if got := readTestFile(t, root, "apps/viewer/BASpineViewer/bin/launcher.exe"); got != "viewer-app-new" {
		t.Fatalf("Viewer bundle = %q", got)
	}
	if got := readTestFile(t, root, "data/authored-project.json"); got != "keep-this" {
		t.Fatalf("authored data changed to %q", got)
	}
	if got := readTestFile(t, root, "SuiteUpdater.exe"); got != "existing-updater" {
		t.Fatalf("running updater was replaced: %q", got)
	}
	if _, err := os.Lstat(filepath.Join(root, suiteUpdateLockName)); !os.IsNotExist(err) {
		t.Fatalf("update lock remains: %v", err)
	}
}

func TestStableSuiteVersionComparison(t *testing.T) {
	if !isNewerVersion("0.3.0", "0.2.0") || !isNewerVersion("0.10.0", "0.9.0") {
		t.Fatal("stable suite versions were not ordered numerically")
	}
	if isNewerVersion("0.3.0", "0.3.0") || isNewerVersion("0.2.0", "0.3.0") {
		t.Fatal("equal or older suite versions were accepted as updates")
	}
	if _, err := normalizeStableVersion("0.3.0-beta.1"); err == nil {
		t.Fatal("prerelease suite version was accepted as stable")
	}
}

func TestSuiteUpdateRejectsBadDigestAndTraversalBeforeChangingSuite(t *testing.T) {
	root := t.TempDir()
	writeTestSuite(t, root, "0.2.0", "old")
	archive := filepath.Join(root, ".ba-spine-update", "BA-Spine-Suite-0.3.0-win-x64.zip")
	digest := writeTestArchive(t, archive, "0.3.0", nil)
	if err := verifyArchiveDigest(archive, strings.Repeat("0", 64)); err == nil {
		t.Fatal("expected a bad checksum to be rejected")
	}
	if got := readTestFile(t, root, "Editor.exe"); got != "editor-root-old" {
		t.Fatalf("bad checksum changed suite files: %q", got)
	}
	if _, err := extractSuiteArchive(root, archive, "0.3.0"); err != nil {
		t.Fatal(err)
	}
	if digest == "" {
		t.Fatal("test archive digest is empty")
	}
	badArchive := filepath.Join(root, ".ba-spine-update", "bad.zip")
	writeTestArchive(t, badArchive, "0.3.0", map[string]string{"apps/../../outside.txt": "bad"})
	if _, err := extractSuiteArchive(root, badArchive, "0.3.0"); err == nil {
		t.Fatal("expected traversal path to be rejected")
	}
	if got := readTestFile(t, root, "Viewer.exe"); got != "viewer-root-old" {
		t.Fatalf("traversal archive changed suite files: %q", got)
	}
}

func TestSuiteUpdateRejectsPayloadsUnderData(t *testing.T) {
	root := t.TempDir()
	archive := filepath.Join(root, ".ba-spine-update", "BA-Spine-Suite-0.3.0-win-x64.zip")
	writeTestArchive(t, archive, "0.3.0", map[string]string{"data/authored-project.json": "must-not-install"})
	if _, err := extractSuiteArchive(root, archive, "0.3.0"); err == nil || !strings.Contains(err.Error(), "data directory content") {
		t.Fatalf("unexpected data payload error: %v", err)
	}
}

func TestInterruptedSuiteUpdateRollsBackFromBackup(t *testing.T) {
	root := t.TempDir()
	writeTestSuite(t, root, "0.2.0", "old")
	stage := filepath.Join(root, ".ba-spine-update-stage-recovery")
	backup := filepath.Join(root, ".ba-spine-update-backup-recovery")
	if err := os.MkdirAll(stage, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(backup, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(root, "Editor.exe"), filepath.Join(backup, "Editor.exe")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "Editor.exe"), []byte("partial-new"), 0644); err != nil {
		t.Fatal(err)
	}
	journal := updateJournal{PID: 999999, Version: "0.3.0", StageName: filepath.Base(stage), BackupName: filepath.Base(backup)}
	contents, err := json.Marshal(journal)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, suiteUpdateLockName), contents, 0600); err != nil {
		t.Fatal(err)
	}
	changed, err := recoverSuiteUpdate(root, func(int) bool { return false })
	if err != nil || !changed {
		t.Fatalf("recovery failed: changed=%v err=%v", changed, err)
	}
	if got := readTestFile(t, root, "Editor.exe"); got != "editor-root-old" {
		t.Fatalf("Editor launcher was not restored: %q", got)
	}
	if _, err := os.Lstat(filepath.Join(root, suiteUpdateLockName)); !os.IsNotExist(err) {
		t.Fatalf("recovery marker remains: %v", err)
	}
}

func TestSuiteUpdateArchivePathMustStayInItsGeneratedFolder(t *testing.T) {
	root := t.TempDir()
	updateDirectory := filepath.Join(root, ".ba-spine-update")
	if err := os.Mkdir(updateDirectory, 0755); err != nil {
		t.Fatal(err)
	}
	valid := filepath.Join(root, ".ba-spine-update", "BA-Spine-Suite-0.3.0-win-x64.zip")
	if err := os.WriteFile(valid, []byte("fixture"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := validateUpdateArchiveLocation(root, valid, "0.3.0"); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []string{
		filepath.Join(root, "data", "BA-Spine-Suite-0.3.0-win-x64.zip"),
		filepath.Join(root, ".ba-spine-update", "other.zip"),
		filepath.Join(root, ".ba-spine-update", "BA-Spine-Suite-0.2.0-win-x64.zip"),
	} {
		if err := validateUpdateArchiveLocation(root, invalid, "0.3.0"); err == nil {
			t.Errorf("expected invalid archive path to be rejected: %s", invalid)
		}
	}
}
