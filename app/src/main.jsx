import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import { setupTelegram } from "./tg.js";
import "./tokens.css";

setupTelegram();
createRoot(document.getElementById("root")).render(<App />);
