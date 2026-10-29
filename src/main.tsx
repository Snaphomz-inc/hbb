import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { build } from "./city";
import "./styles.css";

document.documentElement.dataset.build = build;
console.info(`Snaphomz neighborhoods build ${build}`);

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { message: string | null }> {
  state = { message: null as string | null };

  static getDerivedStateFromError(error: unknown) {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  render() {
    if (this.state.message) {
      return (
        <div className="splash">
          <div className="splash-mark">snaphomz</div>
          <p>Something broke: {this.state.message}</p>
          <p className="build">build {build}</p>
          <p>
            <a href="#/" onClick={() => window.location.reload()} style={{ color: "#DCF763" }}>
              Reload
            </a>
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
