import { useState, type ReactNode } from "react";
import { Link, NavLink, Route, Routes } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { fetchFoundation } from "./api";
import { config } from "./config";

function Shield({ small = false }: { small?: boolean }) {
  return (
    <svg
      className={small ? "shield small" : "shield"}
      viewBox="0 0 32 36"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M16 2 29 7v10c0 8-7 13-13 17C10 30 3 25 3 17V7L16 2Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="m10 17 4 4 8-9"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function Arrow() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M4 12 12 4M4 4h8v8"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function Panel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <section className={`panel ${className}`}>{children}</section>;
}
function StatusCard() {
  const query = useQuery({
    queryKey: ["foundation"],
    queryFn: ({ signal }) => fetchFoundation(signal),
    refetchInterval: config.VITE_STATUS_POLL_MS,
  });
  const state = query.isPending
    ? "Checking API"
    : query.isError
      ? "API unavailable"
      : "API connected";
  return (
    <Panel className="connection">
      <div className="panel-heading">
        <span className="eyebrow">FOUNDATION STATUS</span>
        <span className="tag">REAL-TIME CHECK</span>
      </div>
      <div className="connection-title">
        <span
          className={`status-dot ${query.isPending ? "pending" : query.isError ? "error" : "ready"}`}
        />
        <h3>{state}</h3>
      </div>
      <p role="status">
        {query.isPending
          ? "Requesting readiness and system metadata…"
          : query.isError
            ? "Could not verify API readiness. Check the backend and your connection."
            : `Readiness verified · ${query.data.info.name} v${query.data.info.version}`}
      </p>
      <div className="connection-bottom">
        <span>
          {query.isError
            ? "No cached status shown as healthy"
            : query.dataUpdatedAt
              ? `Checked ${new Date(query.dataUpdatedAt).toLocaleTimeString()}`
              : "Waiting for response"}
        </span>
        <button
          className="text-button"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
        >
          {query.isFetching ? "Checking…" : "Check again"}{" "}
          <span aria-hidden="true">↻</span>
        </button>
      </div>
    </Panel>
  );
}
function Home() {
  return (
    <>
      <div className="page-heading">
        <span className="eyebrow">THE STREAMSHIELD PLATFORM</span>
        <span className="phase-note">
          <span /> PHASE 01 / FOUNDATION
        </span>
      </div>
      <section className="hero">
        <div className="hero-copy">
          <div className="release-label">
            <span className="tiny-mark">✦</span> RESILIENT BY DESIGN
          </div>
          <h1>
            Every stream.
            <br />A stronger <span>foundation.</span>
          </h1>
          <p>
            A home for live experiences that keep people connected. Built with
            reliability at the core, one verified step at a time.
          </p>
          <div className="hero-actions">
            <Link className="button primary" to="/foundation">
              Explore the foundation <Arrow />
            </Link>
            <a className="button secondary" href="#roadmap">
              View the roadmap <span aria-hidden="true">↓</span>
            </a>
          </div>
          <div className="hero-footnote">
            <span className="line-icon">◈</span> Designed for live. Engineered
            for resilience.
          </div>
        </div>
        <div
          className="hero-art"
          aria-label="Conceptual StreamShield architecture illustration, not live telemetry"
          role="img"
        >
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <div className="art-grid" />
          <div className="art-core">
            <Shield />
            <span>STREAMSHIELD</span>
            <small>THE FOUNDATION</small>
          </div>
          <div className="art-node node-one">
            <span>◇</span> SOURCE <small>PLANNED</small>
          </div>
          <div className="art-node node-two">
            <span>⌁</span> DELIVERY <small>PLANNED</small>
          </div>
          <div className="art-node node-three">
            <span>◎</span> AUDIENCE <small>PLANNED</small>
          </div>
          <span className="art-caption">
            ARCHITECTURE CONCEPT · NOT LIVE TELEMETRY
          </span>
        </div>
      </section>
      <div className="section-heading">
        <div>
          <span className="eyebrow">A CLEAR STARTING POINT</span>
          <h2>The platform, taking shape.</h2>
        </div>
        <span className="muted section-note">
          Real foundations. No simulated activity.
        </span>
      </div>
      <div className="overview-grid">
        <Panel className="empty-streams">
          <div className="empty-icon" aria-hidden="true">
            ▷
          </div>
          <div>
            <span className="eyebrow">LIVE DISCOVERY</span>
            <h3>Your next live experience starts here.</h3>
            <p>
              No streams yet. Real broadcasting and video playback arrive in
              Phase 2.
            </p>
            <span className="subtle-label">
              COMING IN PHASE 02 <span aria-hidden="true">↗</span>
            </span>
          </div>
        </Panel>
        <StatusCard />
      </div>
      <section id="roadmap" className="roadmap">
        <div className="section-heading">
          <div>
            <span className="eyebrow">BUILT WITH INTENTION</span>
            <h2>From foundation to resilience.</h2>
          </div>
          <span className="tag">THE ROAD AHEAD</span>
        </div>
        <div className="milestones">
          <Milestone
            number="01"
            title="The foundation"
            label="CURRENT PHASE"
            active
          >
            Application shell, typed API contracts and verifiable service
            readiness.
          </Milestone>
          <Milestone number="02" title="Go genuinely live" label="PLANNED">
            OBS broadcasting, real video ingestion and HLS playback.
          </Milestone>
          <Milestone number="03–04" title="Connect & scale" label="PLANNED">
            Accounts, chat and explicit redundancy across the delivery path.
          </Milestone>
          <Milestone
            number="05–10"
            title="Observe. Recover. Prove."
            label="PLANNED"
          >
            Measured health, bounded recovery and real resilience experiments.
          </Milestone>
        </div>
      </section>
      <div className="principle">
        <Shield small />
        <p>
          Trust is built on evidence.
          <span>
            {" "}
            No fictional streams, no fabricated metrics, no unverified recovery.
          </span>
        </p>
        <span className="eyebrow">THE STREAMSHIELD PRINCIPLE</span>
      </div>
    </>
  );
}
function Milestone({
  number,
  title,
  label,
  active = false,
  children,
}: {
  number: string;
  title: string;
  label: string;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <article className={`milestone ${active ? "active" : ""}`}>
      <div className="milestone-top">
        <span className="step-number">{number}</span>
        <span className="eyebrow">{label}</span>
      </div>
      <h3>{title}</h3>
      <p>{children}</p>
    </article>
  );
}
function Foundation() {
  return (
    <>
      <div className="page-heading">
        <span className="eyebrow">SYSTEM / FOUNDATION</span>
        <span className="tag">PHASE 01</span>
      </div>
      <div className="intro">
        <h1>
          A foundation you
          <br />
          can <span>verify.</span>
        </h1>
        <p>
          Live requests establish API readiness. This check does not measure
          video delivery, infrastructure redundancy or self-healing.
        </p>
      </div>
      <div className="foundation-grid">
        <StatusCard />
        <Panel className="scope">
          <span className="eyebrow">IMPLEMENTED TODAY</span>
          <h2>Small scope. Clear signals.</h2>
          <ul>
            <li>Process liveness and application readiness</li>
            <li>Validated environment configuration</li>
            <li>Typed system metadata and request IDs</li>
            <li>Structured logs and graceful API shutdown</li>
          </ul>
        </Panel>
      </div>
      <Panel className="planned">
        <span className="tag">FUTURE PHASES</span>
        <h2>The Control Center comes later.</h2>
        <p>
          Media health, incidents, recovery actions and chaos controls will
          appear only when connected to real, observable behavior. No monitoring
          or recovery is running today.
        </p>
        <Link className="text-button" to="/">
          Return to platform overview <Arrow />
        </Link>
      </Panel>
    </>
  );
}
export function App() {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <div className="nav-inner">
          <Link className="brand" to="/" aria-label="StreamShield home">
            <Shield small />
            <span>
              Stream<span>Shield</span>
            </span>
          </Link>
          <button
            className="menu-toggle"
            aria-expanded={menuOpen}
            aria-controls="primary-nav"
            onClick={() => setMenuOpen(!menuOpen)}
          >
            Menu <span aria-hidden="true">☰</span>
          </button>
          <nav
            id="primary-nav"
            aria-label="Main navigation"
            className={menuOpen ? "open" : ""}
            onClick={() => setMenuOpen(false)}
          >
            <NavLink to="/" end>
              Overview
            </NavLink>
            <NavLink to="/foundation">Foundation</NavLink>
            <a href="/#roadmap">Roadmap</a>
          </nav>
          <div className="header-label">
            <span className="mini-grid" aria-hidden="true">
              ▦
            </span>{" "}
            DEVELOPMENT BUILD
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/foundation" element={<Foundation />} />
          <Route
            path="*"
            element={
              <div className="intro">
                <span className="eyebrow">404 / PAGE NOT FOUND</span>
                <h1>
                  Off the <span>signal path.</span>
                </h1>
                <p>This page does not exist.</p>
                <Link className="button primary" to="/">
                  Back to overview <Arrow />
                </Link>
              </div>
            }
          />
        </Routes>
      </main>
      <footer>
        <Link className="brand footer-brand" to="/">
          <Shield small />
          <span>StreamShield</span>
        </Link>
        <span>Built for connection. Designed for continuity.</span>
        <span className="footer-phase">FOUNDATION RELEASE · 0.1.0</span>
      </footer>
    </>
  );
}
