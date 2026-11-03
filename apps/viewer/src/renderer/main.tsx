import React, { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "@ba-spine/viewer-feature/styles.css";
import "./viewer.css";

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
