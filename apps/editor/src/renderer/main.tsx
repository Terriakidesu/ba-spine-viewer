import React, { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "@ba-spine/app-ui/styles/tokens.css";
import "@ba-spine/app-ui/styles/controls.css";

const waveformProfile = import.meta.env.DEV && new URLSearchParams(window.location.search).get("profile") === "waveforms";
const App = waveformProfile
  ? lazy(() => import("./waveformProfile").then(({ WaveformProfile }) => ({ default: WaveformProfile })))
  : lazy(() => import("@ba-spine/editor-feature").then(({ Editor }) => ({ default: Editor })));

const root = document.getElementById("root");
if (!root) throw new Error("Editor root element is missing.");

createRoot(root).render(waveformProfile
  ? <Suspense fallback={<div role="status">Loading waveform profile…</div>}><App /></Suspense>
  : <React.StrictMode><Suspense fallback={<div role="status">Loading Spine editor…</div>}><App /></Suspense></React.StrictMode>);
