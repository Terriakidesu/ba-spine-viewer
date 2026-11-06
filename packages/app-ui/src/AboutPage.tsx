import { useEffect, useRef } from "react";
import { IconChevronLeft, IconExternal, IconSync, IconCheck } from "./icons";
import { compareSemanticVersions, RELEASES_URL, RELEASE_REPOSITORY, type ReleaseUpdateState } from "./releaseUpdates";
import "./AboutPage.css";

export interface AboutPageProps {
  appName: string;
  version: string;
  update: ReleaseUpdateState;
  automaticChecks: boolean;
  onAutomaticChecksChange: (enabled: boolean) => void;
  onCheckNow: () => void;
  onSkipLatest: () => void;
  onShowSkipped: () => void;
  onBack: () => void;
  ffmpegNotice?: boolean;
}

export function AboutPage({
  appName,
  version,
  update,
  automaticChecks,
  onAutomaticChecksChange,
  onCheckNow,
  onSkipLatest,
  onShowSkipped,
  onBack,
  ffmpegNotice = false,
}: AboutPageProps) {
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const latest = update.latestRelease;
  const hasUpdate = Boolean(latest && compareSemanticVersions(latest.version, version) > 0);
  const skipped = update.status === "skipped";
  const windowsPortableAsset = latest?.assets.find((asset) => /^BA-Spine-Suite-.*-win-x64\.zip$/i.test(asset.name));

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    backButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onBack();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previousFocusRef.current?.focus();
    };
  }, [onBack]);

  const statusMessage = update.status === "checking"
    ? "Checking GitHub Releases…"
    : skipped && latest
      ? `Version ${latest.version} is skipped.`
      : hasUpdate && latest
        ? `Version ${latest.version} is available.`
        : latest
          ? `You’re up to date. Latest release: ${latest.version}.`
          : update.status === "error"
            ? "Could not check GitHub Releases."
            : "Release status has not been checked yet.";

  return <main className="suite-about-page" aria-labelledby="suite-about-title">
    <header className="suite-about-header">
      <button ref={backButtonRef} type="button" className="suite-about-back" onClick={onBack}>
        <IconChevronLeft /> Back to {appName}
      </button>
      <a href={RELEASES_URL} target="_blank" rel="noreferrer" className="suite-about-header-link">
        GitHub Releases <IconExternal />
      </a>
    </header>

    <div className="suite-about-content">
      <span className="suite-about-eyebrow">BA SPINE SUITE</span>
      <h1 id="suite-about-title">About {appName}</h1>
      <p className="suite-about-intro">A local-first toolkit for browsing and authoring Blue Archive Spine projects.</p>

      <section className="suite-about-card suite-about-version-card" aria-label="Application version">
        <div>
          <span className="suite-about-label">Installed version</span>
          <strong className="suite-about-version">{version}</strong>
        </div>
        <span className="suite-about-version-mark"><IconCheck /> Stable</span>
      </section>

      <section className="suite-about-card suite-about-updates" aria-labelledby="suite-about-update-title">
        <div className="suite-about-section-heading">
          <div>
            <span className="suite-about-label">RELEASES</span>
            <h2 id="suite-about-update-title">Updates</h2>
          </div>
          <button type="button" className="suite-about-secondary" onClick={onCheckNow} disabled={update.status === "checking"}>
            <IconSync /> Check now
          </button>
        </div>

        <p className={`suite-about-update-status${hasUpdate && !skipped ? " is-available" : ""}`} role="status">
          {statusMessage}
        </p>
        {update.checkedAt !== null && <p className="suite-about-check-time">Last checked {new Date(update.checkedAt).toLocaleString()}.</p>}
        {update.error && <p className="suite-about-error" role="alert">{update.error}</p>}

        <label className="suite-about-auto-check">
          <input type="checkbox" checked={automaticChecks} onChange={(event) => onAutomaticChecksChange(event.target.checked)} />
          <span>Check for stable releases automatically (at most once a day)</span>
        </label>

        {latest && <div className="suite-about-release">
          <div className="suite-about-release-heading">
            <div>
              <span className="suite-about-label">LATEST STABLE RELEASE</span>
              <h3>{latest.name}</h3>
              <small>{latest.version}{latest.publishedAt ? ` · ${new Date(latest.publishedAt).toLocaleDateString()}` : ""}</small>
            </div>
            {hasUpdate && <span className={`suite-about-release-badge${skipped ? " is-skipped" : ""}`}>{skipped ? "Skipped" : "Update available"}</span>}
          </div>

          <div className="suite-about-release-actions">
            <a className="suite-about-primary" href={windowsPortableAsset?.downloadUrl ?? latest.url} target="_blank" rel="noreferrer">
              {windowsPortableAsset ? "Download portable release" : "View release & downloads"}
              <IconExternal />
            </a>
            {hasUpdate && !skipped && <button type="button" className="suite-about-secondary" onClick={onSkipLatest}>Skip this version</button>}
            {skipped && <button type="button" className="suite-about-secondary" onClick={onShowSkipped}>Show update again</button>}
          </div>

          {latest.notes && <details className="suite-about-release-notes">
            <summary>Release notes</summary>
            <pre>{latest.notes}</pre>
          </details>}
        </div>}

        <p className="suite-about-update-note">Downloads open GitHub Releases. Updates are not installed automatically.</p>
      </section>

      <section className="suite-about-card suite-about-credits" aria-labelledby="suite-about-credits-title">
        <h2 id="suite-about-credits-title">Project information</h2>
        <div className="suite-about-links">
          <a href={`https://github.com/${RELEASE_REPOSITORY}`} target="_blank" rel="noreferrer">Source code <IconExternal /></a>
          <a href="https://github.com/Terriakidesu/ba-spine-viewer/blob/main/LICENSE" target="_blank" rel="noreferrer">MIT License <IconExternal /></a>
          {ffmpegNotice && <a href="https://ffmpeg.org/legal.html" target="_blank" rel="noreferrer">FFmpeg licensing notice <IconExternal /></a>}
        </div>
        {ffmpegNotice && <p className="suite-about-legal-note">Viewer video recording may use FFmpeg, which is distributed under GPLv3. See the bundled release notices for details.</p>}
      </section>
    </div>
  </main>;
}
