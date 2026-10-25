import { useEffect, useRef, useState, lazy, Suspense } from "react";
import {
  Link,
  NavLink,
  Navigate,
  Outlet,
  Route,
  Routes,
  useNavigate,
  useParams,
} from "react-router-dom";
import { Brand } from "../ui/Brand";
import { Icon } from "../ui/Icon";
import { useAuth } from "../platform/auth-context";
import { useDemoChannels } from "./useDemoChannels";
import "./demo.css";
const Watch = lazy(() => import("../streaming/Watch"));
const Control = lazy(() => import("../control/Control"));

function DemoShell() {
  const auth = useAuth();
  return (
    <div className="three-app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="three-header">
        <Brand />
        <nav aria-label="Live navigation">
          <NavLink to="/" end>
            Discover
          </NavLink>
          <NavLink to="/live">Live channels</NavLink>
        </nav>
        <div className="three-header-end">
          <span className="three-guest">
            <i />
            {auth.guest?.name || "Guest viewing"}
          </span>
          {auth.user?.role === "administrator" && (
            <Link className="button secondary" to="/control/three-stream-demo">
              Open Control <Icon name="arrow" />
            </Link>
          )}
        </div>
      </header>
      <main id="main" className="three-content">
        <Outlet />
      </main>
      <footer className="three-footer">
        <Brand />
        <span>Independent channels. Shared moments.</span>
        <span>StreamShield Live</span>
      </footer>
    </div>
  );
}
function Signal({ status }: { status: string }) {
  return (
    <span className={"three-signal " + status}>
      <i />
      {status === "live"
        ? "LIVE"
        : status === "offline"
          ? "OFFLINE"
          : status === "starting"
            ? "CONNECTING"
            : "STATUS UNKNOWN"}
    </span>
  );
}
export function DemoHome() {
  const query = useDemoChannels(),
    [search, setSearch] = useState("");
  const channels =
    query.data?.channels.filter((c) =>
      (c.channelName + " " + c.title)
        .toLowerCase()
        .includes(search.toLowerCase()),
    ) || [];
  return (
    <div className="three-home">
      <section className="three-hero">
        <div>
          <p className="three-eyebrow">
            <span />
            THE WORLD, LIVE RIGHT NOW
          </p>
          <h1>
            Three perspectives.
            <br />
            <em>One live moment.</em>
          </h1>
          <p className="three-subtitle">
            Find your signal. Settle into a stream. Be part of the conversation.
          </p>
          <div className="three-hero-facts">
            <span>
              <b>03</b> independent channels
            </span>
            <span>
              <Icon name="chat" />
              Open conversation
            </span>
            <span>
              <Icon name="live" />
              Live as it happens
            </span>
          </div>
        </div>
        <div className="three-orbit" aria-hidden="true">
          <div className="three-orbit-ring" />
          <span className="three-orbit-core">
            <Icon name="play" />
          </span>
          <span className="three-orbit-label one">01 · PERSPECTIVE</span>
          <span className="three-orbit-label two">02 · CONNECTION</span>
          <span className="three-orbit-label three">03 · DISCOVERY</span>
        </div>
      </section>
      <section className="three-discovery">
        <div className="three-section-heading">
          <div>
            <p className="three-eyebrow">YOUR FRONT ROW</p>
            <h2>
              Choose your channel<span>03</span>
            </h2>
            <p>
              Every stream has its own story. Every conversation has its own
              room.
            </p>
          </div>
          <label className="three-search">
            <Icon name="search" />
            <input
              placeholder="Find a channel"
              aria-label="Find a channel"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              maxLength={80}
            />
          </label>
        </div>
        {query.isPending ? (
          <p role="status" className="three-notice">
            Finding the three channels…
          </p>
        ) : query.isError ? (
          <div role="alert" className="three-notice">
            Channel status is unavailable.{" "}
            <button onClick={() => void query.refetch()}>Try again</button>
          </div>
        ) : query.data?.channels.length !== 3 ? (
          <p className="three-notice">
            The broadcaster channels are being prepared. Check back in a moment.
          </p>
        ) : (
          <div className="three-card-grid">
            {channels.map((c) => (
              <article
                key={c.id}
                className={"three-channel-card tone-" + c.slot}
              >
                <Link
                  to={"/watch/streamer-" + c.slot}
                  className="three-poster"
                  aria-label={"Watch " + c.channelName}
                >
                  <div className="three-poster-top">
                    <Signal status={c.status} />
                    <span>CHANNEL {String(c.slot).padStart(2, "0")}</span>
                  </div>
                  <div className="three-poster-art" aria-hidden="true">
                    <div />
                    <span>{String(c.slot).padStart(2, "0")}</span>
                  </div>
                  <div className="three-poster-bottom">
                    <span>
                      {c.status === "live"
                        ? "The moment is happening"
                        : "The next moment awaits"}
                    </span>
                    <span className="three-play">
                      <Icon name="play" />
                    </span>
                  </div>
                </Link>
                <div className="three-card-details">
                  <div className="three-channel-identity">
                    <span className="three-avatar">S{c.slot}</span>
                    <div>
                      <h3>
                        <Link to={"/watch/streamer-" + c.slot}>
                          {c.channelName}
                        </Link>
                      </h3>
                      <p>{c.title}</p>
                    </div>
                    <Icon name="shield" />
                  </div>
                  <div className="three-card-foot">
                    <span>
                      {c.viewers === null
                        ? "Viewer estimate unavailable"
                        : `${c.viewers} active player ${c.viewers === 1 ? "identity" : "identities"}`}
                    </span>
                    <Link to={"/watch/streamer-" + c.slot}>
                      Watch Live <Icon name="arrow" />
                    </Link>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
        {query.data?.channels.length === 3 && !channels.length && (
          <p className="three-notice">No channel matches that search.</p>
        )}
      </section>
      <aside className="three-community">
        <span className="three-community-icon">
          <Icon name="chat" />
        </span>
        <div>
          <h2>A place in every conversation.</h2>
          <p>
            Pick a channel and say hello. Your temporary guest identity is ready
            when you are.
          </p>
        </div>
        <span className="three-community-tag">COME AS YOU ARE ↗</span>
      </aside>
    </div>
  );
}
function LocalAccess() {
  const { csrf, call, refresh } = useAuth(),
    navigate = useNavigate(),
    operation = useRef<Promise<unknown> | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    if (!csrf) return;
    let disposed = false;
    if (!operation.current) {
      const ticket =
        new URLSearchParams(window.location.hash.slice(1)).get("ticket") || "";
      window.history.replaceState(null, "", "/local-access");
      operation.current = call("/demo/local-access", {
        method: "POST",
        body: JSON.stringify({ ticket }),
      }).then(() => refresh());
    }
    void operation.current
      .then(() => {
        if (!disposed)
          navigate("/control/three-stream-demo", { replace: true });
      })
      .catch(() => {
        if (!disposed)
          setError(
            "This local access link is expired or already used. Issue a fresh one in the trusted terminal.",
          );
      });
    return () => {
      disposed = true;
    };
  }, [csrf, call, refresh, navigate]);
  return (
    <div className="three-access">
      <Brand product="Control" />
      <h1>
        {error
          ? "Local access unavailable"
          : "Opening your local operator session…"}
      </h1>
      <p>
        {error ||
          "Exchanging the one-use capability for a short-lived private session."}
      </p>
      <Link to="/">Return to live channels</Link>
    </div>
  );
}
function ChannelRedirect() {
  const { slug } = useParams();
  return (
    <Navigate
      to={/^streamer-[123]$/.test(slug || "") ? "/watch/" + slug : "/"}
      replace
    />
  );
}
export function DemoRoutes() {
  return (
    <Suspense
      fallback={<p className="loading-surface">Opening StreamShield…</p>}
    >
      <Routes>
        <Route path="/control/*" element={<Control />} />
        <Route path="/local-access" element={<LocalAccess />} />
        <Route element={<DemoShell />}>
          <Route index element={<DemoHome />} />
          <Route path="live" element={<DemoHome />} />
          <Route path="channels" element={<DemoHome />} />
          <Route path="channels/:slug" element={<ChannelRedirect />} />
          <Route path="watch/:id" element={<Watch />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
