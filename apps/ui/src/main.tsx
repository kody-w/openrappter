import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { BridgeClient, DisconnectedClient } from "./client";
import "./styles.css";

class WorkspaceBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <main className="fatal-error"><h1>RAPP Work needs a refresh</h1><p role="alert">The workspace could not be displayed. No execution result has been inferred.</p><button className="button primary" onClick={() => window.location.reload()}>Reload workspace</button></main> : this.props.children;
  }
}
const client = window.rappWork ? new BridgeClient(window.rappWork) : new DisconnectedClient();
createRoot(document.getElementById("root")!).render(<StrictMode><WorkspaceBoundary><App client={client} /></WorkspaceBoundary></StrictMode>);
