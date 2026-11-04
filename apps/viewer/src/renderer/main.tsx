import React, { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "@ba-spine/app-ui/styles/tokens.css";
import "@ba-spine/app-ui/styles/controls.css";
import "@ba-spine/viewer-feature/styles.css";
import "./viewer.css";
import { initializeTheme } from "@ba-spine/viewer-feature/theme";

initializeTheme();

const Spine = lazy(() => import("@ba-spine/viewer-feature").then(({ Spine }) => ({ default: Spine })));

const root = document.getElementById("root");
if (!root) throw new Error("Viewer root element is missing.");

createRoot(root).render(
  <React.StrictMode>
    <Suspense fallback={<div className="app-loading" role="status">Loading Spine viewer…</div>}>
      <Spine />
    </Suspense>
  </React.StrictMode>,
);
