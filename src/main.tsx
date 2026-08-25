import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import StatusUsage from "./StatusUsage";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing React root element.");

const usageStatusPath = window.location.pathname === "/status/usage";
if (usageStatusPath) document.title = "Codex 用量状态";
const application = usageStatusPath ? <StatusUsage /> : <App />;

createRoot(root).render(
	<StrictMode>
		{application}
	</StrictMode>,
);
