import { AuthProvider, AuthPage, Profile, Protected } from "./platform/Auth";

import { ChannelPage, Channels } from "./platform/Channels";
import { lazy, Suspense } from "react";
import { Link, Navigate, Route, Routes } from "react-router-dom";
import { LiveShell } from "./layout/LiveShell";
import { Discovery, Explore } from "./streaming/Discovery";
import { ConnectionStatus } from "./ui/ConnectionStatus";

import { Icon } from "./ui/Icon";
const Control = lazy(() => import("./control/Control"));
const Studio = lazy(() =>
  import("./platform/Studio").then((module) => ({ default: module.Studio })),
);
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
          ingestion, MediaMTX HLS delivery and real browser playback. Phase 3
          adds owned channels, broadcaster Studio, authenticated sessions,
          durable chat and approximate active-player estimates. Phase 4 adds
          redundant APIs, media origins and edges. Phase 5 adds
          administrator-only observability and durable incidents.
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
          Following, categories and uploaded profile assets come in later
          phases. Autonomous recovery and interactive chaos controls remain
          future work.
        </p>
        <p>
          StreamShield Control is a separate authorized operations product. No
          capacity or infrastructure-healing guarantee is made by this build.
        </p>
      </section>
    </div>
  );
}
export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route
          path="/control/*"
          element={
            <Suspense
              fallback={<p className="loading-surface">Loading Control…</p>}
            >
              <Control />
            </Suspense>
          }
        />
        <Route element={<LiveShell />}>
          <Route path="/login" element={<AuthPage />} />
          <Route path="/signup" element={<AuthPage signup />} />
          <Route path="/profile" element={<Profile />} />
          <Route
            path="/studio"
            element={
              <Protected>
                <Suspense
                  fallback={<p className="loading-surface">Loading Studio…</p>}
                >
                  <Studio />
                </Suspense>
              </Protected>
            }
          />
          <Route path="/channels" element={<Channels />} />
          <Route path="/channels/:slug" element={<ChannelPage />} />
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
    </AuthProvider>
  );
}
