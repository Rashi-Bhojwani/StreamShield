import { lazy, Suspense } from "react";
import { Link, Navigate, Route, Routes } from "react-router-dom";
import { LiveShell } from "./layout/LiveShell";
import { Discovery, Explore } from "./streaming/Discovery";
import { ConnectionStatus } from "./ui/ConnectionStatus";
import { Brand } from "./ui/Brand";
import { Icon } from "./ui/Icon";
const Watch = lazy(() => import("./streaming/Watch"));
function Diagnostics() {
  return (
    <div className="diagnostics-page">
      <Link className="text-link" to="/">
        ← Back to Live
      </Link>
      <div className="page-heading">
        <div>
          <p className="eyebrow">Connection details</p>
          <h1>A connection you can verify.</h1>
          <p className="page-subtitle">
            Application connectivity, separate from the video you’re watching.
          </p>
        </div>
      </div>
      <div className="panel diagnostics-panel">
        <ConnectionStatus />
      </div>
    </div>
  );
}
function About() {
  return (
    <div className="diagnostics-page">
      <Link className="text-link" to="/">
        ← Back to Live
      </Link>
      <div className="page-heading">
        <div>
          <p className="eyebrow">Developer information</p>
          <h1>The foundation behind the stream.</h1>
          <p className="page-subtitle">
            Implemented capabilities and the road ahead.
          </p>
        </div>
      </div>
      <section className="panel diagnostics-panel">
        <h2>Built so far</h2>
        <p>
          Phase 1 established validated contracts, API health, structured
          logging, Docker and automated checks. Phase 2 adds authenticated RTMP
          ingestion, MediaMTX HLS delivery and real browser playback.
        </p>
        <p>
          Media travels directly through the media delivery path. Express
          provides verified source metadata; browser playback measurements
          remain separate.
        </p>
        <Link className="button secondary" to="/diagnostics">
          Check application connection
        </Link>
      </section>
      <section className="panel diagnostics-panel">
        <h2>Planned, not operational</h2>
        <p>
          Accounts, broadcaster tools and chat come in later phases. Redundant
          origins, edges, incident timelines, failover and automated recovery
          require additional implementation and verification.
        </p>
        <p>
          StreamShield Control will be a separate authorized operations product.
          No capacity or infrastructure-healing guarantee is made by this build.
        </p>
      </section>
    </div>
  );
}
function Control() {
  return (
    <div className="control-app">
      <header>
        <Brand product="Control" />
        <Link className="button secondary" to="/">
          Back to Live
          <Icon name="arrow" />
        </Link>
      </header>
      <main id="main">
        <div className="control-intro">
          <span className="state-symbol">
            <Icon name="shield" />
          </span>
          <span className="soon-badge">Coming in a future update</span>
          <h1>A separate space for stream reliability.</h1>
          <p>
            StreamShield Control will be the authorized operations experience
            for monitoring, incidents and recovery. It is not available yet.
          </p>
          <p>
            No monitoring dashboard, administrative access or chaos controls are
            enabled here. Authorization must be implemented before those tools
            become available.
          </p>
          <Link className="button primary" to="/">
            Return to StreamShield Live
            <Icon name="arrow" />
          </Link>
        </div>
      </main>
    </div>
  );
}
export function App() {
  return (
    <Routes>
      <Route path="/control" element={<Control />} />
      <Route element={<LiveShell />}>
        <Route path="/" element={<Discovery />} />
        <Route path="/live" element={<Discovery view="live" />} />
        <Route path="/search" element={<Discovery view="search" />} />
        <Route path="/explore" element={<Explore />} />
        <Route path="/about" element={<About />} />
        <Route path="/diagnostics" element={<Diagnostics />} />
        <Route
          path="/foundation"
          element={<Navigate to="/diagnostics" replace />}
        />
        <Route
          path="/watch/:id"
          element={
            <Suspense
              fallback={
                <p className="loading-surface" role="status">
                  Loading the live player…
                </p>
              }
            >
              <Watch />
            </Suspense>
          }
        />
        <Route
          path="*"
          element={
            <div className="not-found">
              <span className="state-symbol">
                <Icon name="search" />
              </span>
              <h1>This page is off the air.</h1>
              <p>The page you’re looking for doesn’t exist.</p>
              <Link className="button primary" to="/">
                Back to Home
                <Icon name="arrow" />
              </Link>
            </div>
          }
        />
      </Route>
    </Routes>
  );
}
