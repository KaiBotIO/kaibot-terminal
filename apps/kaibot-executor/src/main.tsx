import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ThemeProvider } from "./components/ThemeProvider";
import { isDesktop } from "./lib/utils";
import "./index.css";
import "./styles/tauri.css";

// data-tauri drives macOS vibrancy / drag regions. The whole app now follows
// the Gridline Tokyo canon, so the old desktop-only native-mode override is gone.
if (isDesktop()) {
  document.body.setAttribute('data-tauri', 'true');
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider defaultTheme="dark" storageKey="kaibot-executor-theme">
      <App />
    </ThemeProvider>
  </React.StrictMode>,
);
