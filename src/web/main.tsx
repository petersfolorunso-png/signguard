import { createRoot } from "react-dom/client";
import { App } from "./App";
// Self-hosted fonts (latin): no third-party CSS that a blocked network could stall.
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";
import "@fontsource/space-grotesk/latin-600.css";
import "@fontsource/space-grotesk/latin-700.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<App />);
