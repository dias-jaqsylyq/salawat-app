import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/lexend";
import "@fontsource/scheherazade-new/400.css";
import "./index.css";
import App from "./App.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
