import React, { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";

const Editor = lazy(() => import("@ba-spine/editor-feature").then(({ Editor }) => ({ default: Editor })));

const root = document.getElementById("root");
if (!root) throw new Error("Editor root element is missing.");

createRoot(root).render(
  <React.StrictMode>
    <Suspense fallback={<div role="status">Loading Spine editor…</div>}>
      <Editor />
    </Suspense>
  </React.StrictMode>,
);
