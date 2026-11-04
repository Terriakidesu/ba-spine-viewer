package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const manifestLimit = 16 * 1024

var app = "editor"
var versionPattern = regexp.MustCompile(`^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$`)

type suiteManifest struct {
	SchemaVersion int               `json:"schemaVersion"`
	SuiteVersion  string            `json:"suiteVersion"`
	Platform      string            `json:"platform"`
	Apps          map[string]string `json:"apps"`
	DataDirectory string            `json:"dataDirectory"`
}

func validateRelativePath(value string) error {
	if value == "" || len(value) > 512 || strings.ContainsAny(value, `\\:`) || strings.HasPrefix(value, "/") {
		return fmt.Errorf("path must be a safe relative path")
	}
	for _, part := range strings.Split(value, "/") {
		if part == "" || part == "." || part == ".." {
			return fmt.Errorf("path contains an unsafe segment")
		}
	}
	for _, character := range value {
		if character < 0x20 || character == 0x7f {
			return fmt.Errorf("path contains a control character")
		}
	}
	if filepath.IsAbs(value) {
		return fmt.Errorf("path must be relative")
	}
	return nil
}

func parseManifest(root string) (suiteManifest, string, error) {
	manifestPath := filepath.Join(root, "suite.json")
	info, err := os.Lstat(manifestPath)
	if err != nil {
		return suiteManifest{}, "", fmt.Errorf("suite.json is missing: %w", err)
	}
	if !info.Mode().IsRegular() || info.Size() > manifestLimit {
		return suiteManifest{}, "", fmt.Errorf("suite.json must be a small regular file")
	}
	contents, err := os.ReadFile(manifestPath)
	if err != nil {
		return suiteManifest{}, "", fmt.Errorf("suite.json could not be read: %w", err)
	}
	decoder := json.NewDecoder(bytes.NewReader(contents))
	decoder.DisallowUnknownFields()
	var manifest suiteManifest
	if err := decoder.Decode(&manifest); err != nil {
		return suiteManifest{}, "", fmt.Errorf("suite.json is invalid: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return suiteManifest{}, "", fmt.Errorf("suite.json contains trailing data")
	}
	if manifest.SchemaVersion != 1 || !versionPattern.MatchString(manifest.SuiteVersion) || manifest.Platform != "windows-x64" {
		return suiteManifest{}, "", fmt.Errorf("suite.json has an unsupported version or platform")
	}
	if len(manifest.Apps) != 2 || manifest.Apps["editor"] == "" || manifest.Apps["viewer"] == "" {
		return suiteManifest{}, "", fmt.Errorf("suite.json must declare both app bundles")
	}
	for _, name := range []string{"editor", "viewer"} {
		path := manifest.Apps[name]
		if err := validateRelativePath(path); err != nil {
			return suiteManifest{}, "", fmt.Errorf("suite.json %s path is invalid: %w", name, err)
		}
		if !strings.HasSuffix(strings.ToLower(path), "/bin/launcher.exe") {
			return suiteManifest{}, "", fmt.Errorf("suite.json %s path must identify an Electrobun launcher", name)
		}
	}
	if err := validateRelativePath(manifest.DataDirectory); err != nil {
		return suiteManifest{}, "", fmt.Errorf("suite.json data path is invalid: %w", err)
	}
	dataPath, err := resolveContained(root, manifest.DataDirectory)
	if err != nil {
		return suiteManifest{}, "", fmt.Errorf("suite data path is invalid: %w", err)
	}
	if info, err := os.Lstat(dataPath); err == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return suiteManifest{}, "", fmt.Errorf("suite data path must be a regular directory")
		}
	} else if !os.IsNotExist(err) {
		return suiteManifest{}, "", fmt.Errorf("suite data path could not be checked: %w", err)
	}
	return manifest, dataPath, nil
}

func resolveContained(root, relativePath string) (string, error) {
	if err := validateRelativePath(relativePath); err != nil {
		return "", err
	}
	canonicalRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", err
	}
	candidate := filepath.Join(canonicalRoot, filepath.FromSlash(relativePath))
	relative, err := filepath.Rel(canonicalRoot, candidate)
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return "", fmt.Errorf("path escapes suite root")
	}
	return candidate, nil
}

func appExecutable(root string, manifest suiteManifest) (string, error) {
	path, ok := manifest.Apps[app]
	if !ok {
		return "", fmt.Errorf("launcher was built for an unsupported app")
	}
	candidate, err := resolveContained(root, path)
	if err != nil {
		return "", err
	}
	info, err := os.Lstat(candidate)
	if err != nil {
		return "", fmt.Errorf("%s bundle is missing: %w", app, err)
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("%s bundle launcher is not a regular file", app)
	}
	actual, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		return "", fmt.Errorf("%s bundle launcher is invalid: %w", app, err)
	}
	actualRelative, err := filepath.Rel(root, actual)
	if err != nil || actualRelative == ".." || strings.HasPrefix(actualRelative, ".."+string(filepath.Separator)) || filepath.IsAbs(actualRelative) {
		return "", fmt.Errorf("%s bundle launcher resolves outside the suite", app)
	}
	return actual, nil
}

func replaceEnvironment(values []string, key, value string) []string {
	prefix := key + "="
	result := make([]string, 0, len(values)+1)
	for _, item := range values {
		if !strings.HasPrefix(strings.ToUpper(item), strings.ToUpper(prefix)) {
			result = append(result, item)
		}
	}
	return append(result, prefix+value)
}
