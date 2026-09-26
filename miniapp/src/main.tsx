import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/lexend";
import "@fontsource/scheherazade-new/400.css";
import "./index.css";
import App from "./App.tsx";

const root = createRoot(document.getElementById("root")!);

// `?ui-preview` on the dev server shows the component gallery instead of the app.
// import.meta.env.DEV is statically false in production, so the gallery isn't bundled.
if (import.meta.env.DEV && new URLSearchParams(window.location.search).has("ui-preview")) {
  void import("./dev/UiPreview.tsx").then(({ default: UiPreview }) =>
    root.render(
      <StrictMode>
        <UiPreview />
      </StrictMode>
    )
  );
} else {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}
