import { config } from "../config";
import { useAuth } from "../platform/auth-context";
import { AccountMenu } from "../platform/Auth";
import { useEffect, useRef, useState } from "react";
import {
  Link,
  NavLink,
  Outlet,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { Brand } from "../ui/Brand";
import { Icon, type IconName } from "../ui/Icon";
import { useStreams } from "../streaming/useStreams";

const navigation: { to: string; label: string; icon: IconName }[] = [
  { to: "/", label: "Home", icon: "home" },
  { to: "/live", label: "Live Streams", icon: "live" },
  { to: "/explore", label: "Explore Categories", icon: "grid" },
];
export function LiveShell() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const query = useStreams();
  const searchTerm = new URLSearchParams(location.search).get("q") || "";
  useEffect(() => {
    if (!open) return;
    const old = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    sidebar.current?.querySelector<HTMLAnchorElement>("a")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        toggle.current?.focus();
      }
      if (event.key === "Tab") {
        const items = sidebar.current?.querySelectorAll<HTMLElement>(
          "a[href],button:not([disabled])",
        );
        const first = items?.[0];
        const last = items?.[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.body.style.overflow = old;
      document.removeEventListener("keydown", keydown);
    };
  }, [open]);
  return (
    <div
      className={"live-app" + (config.VITE_DYNAMIC_MODE ? " dynamic-app" : "")}
    >
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <button
          ref={toggle}
          className="icon-button menu-toggle"
          aria-label={open ? "Close menu" : "Menu"}
          aria-expanded={open}
          aria-controls="sidebar"
          onClick={() => setOpen(!open)}
        >
          <Icon name={open ? "close" : "menu"} />
        </button>
        <Brand />
        <nav className="top-navigation" aria-label="Top navigation">
          <NavLink to="/" end>
            Home
          </NavLink>
          <NavLink to="/live">Live</NavLink>
          <NavLink to="/explore">Explore</NavLink>
          {config.VITE_DYNAMIC_MODE && (
            <NavLink className="mobile-go-live" to="/studio">
              Go Live
            </NavLink>
          )}
          {config.VITE_DYNAMIC_MODE && (
            <NavLink className="my-channel-nav" to="/my-channel">
              My Channel
            </NavLink>
          )}
        </nav>
        <form
          className="search-form"
          role="search"
          aria-label="Search streams"
          onSubmit={(event) => {
            event.preventDefault();
            const value = String(
              new FormData(event.currentTarget).get("q") || "",
            ).trim();
            navigate(
              "/search" + (value ? "?q=" + encodeURIComponent(value) : ""),
            );
          }}
        >
          <Icon name="search" />
          <input
            key={location.pathname + location.search}
            type="search"
            name="q"
            defaultValue={searchTerm}
            placeholder="Search streams"
            aria-label="Search streams"
            maxLength={120}
          />
          <button type="submit" aria-label="Search">
            <Icon name="arrow" />
          </button>
        </form>
        {config.VITE_DYNAMIC_MODE && (
          <Link className="button primary" to="/studio">
            <Icon name="studio" /> Go Live
          </Link>
        )}
        <AccountMenu />
      </header>
      {open && (
        <button
          className="nav-backdrop"
          tabIndex={-1}
          aria-label="Close navigation"
          onClick={() => {
            setOpen(false);
            toggle.current?.focus();
          }}
        />
      )}
      <aside
        id="sidebar"
        ref={sidebar}
        className={"sidebar " + (open ? "is-open" : "")}
        role={open ? "dialog" : undefined}
        aria-modal={open ? true : undefined}
        aria-label="Sidebar navigation"
      >
        <div className="sidebar-mobile-heading">
          <span>Navigation</span>
          <button
            className="icon-button"
            aria-label="Close menu"
            onClick={() => {
              setOpen(false);
              toggle.current?.focus();
            }}
          >
            <Icon name="close" />
          </button>
        </div>
        <nav className="sidebar-navigation" aria-label="Primary navigation">
          {navigation.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              onClick={() => setOpen(false)}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-divider" />
        <div className="sidebar-group">
          <p className="sidebar-label">Your space</p>
          {user?.role === "administrator" ? (
            <Link
              className="sidebar-future"
              to="/control"
              onClick={() => setOpen(false)}
            >
              <Icon name="shield" />
              <span>Control Center</span>
              <small>Admin</small>
            </Link>
          ) : (
            <button
              className="sidebar-future"
              disabled
              title="Administrator access required"
            >
              <Icon name="lock" />
              <span>Control Center</span>
              <small>Admin only</small>
            </button>
          )}
          <Link
            className="sidebar-future studio-link"
            to="/studio"
            onClick={() => setOpen(false)}
          >
            <Icon name="studio" />
            <span>Broadcaster Studio</span>
          </Link>
          <Link
            className="sidebar-future studio-link"
            to="/channels"
            onClick={() => setOpen(false)}
          >
            <Icon name="grid" />
            <span>Browse channels</span>
          </Link>
        </div>
        <div className="sidebar-divider" />
        <section className="sidebar-group channels">
          <div className="sidebar-group-heading">
            <h2>Available channels</h2>
            <Icon name="live" />
          </div>
          {query.isPending ? (
            <p className="sidebar-hint">Finding channels…</p>
          ) : query.isError ? (
            <p className="sidebar-hint">Channel status unavailable.</p>
          ) : query.data?.streams.length ? (
            query.data.streams.map((stream) => (
              <Link
                key={stream.id}
                className="sidebar-channel"
                to={"/watch/" + encodeURIComponent(stream.id)}
                onClick={() => setOpen(false)}
              >
                <span className="channel-symbol">
                  <Icon name="studio" />
                </span>
                <span className="channel-label">
                  <strong>{stream.title}</strong>
                  <small>
                    <span className={"channel-dot " + stream.status} />
                    {stream.status === "live"
                      ? "Source available"
                      : stream.status === "offline"
                        ? "Offline"
                        : stream.status === "starting"
                          ? "Connecting"
                          : "Status unavailable"}
                  </small>
                </span>
              </Link>
            ))
          ) : (
            <p className="sidebar-hint">No channels available yet.</p>
          )}
        </section>
        <div className="sidebar-bottom">
          <div className="sidebar-control">
            <Icon name="shield" />
            <div>
              <span>StreamShield Control</span>
              <small>Administrator operations</small>
            </div>
          </div>

          <Link
            className="connection-link"
            to="/diagnostics"
            onClick={() => setOpen(false)}
          >
            <Icon name="pulse" />
            Connection details
            <Icon name="chevron" />
          </Link>
          <p className="sidebar-footer">Made for live moments.</p>
        </div>
      </aside>
      <div className="app-workspace">
        <main id="main" tabIndex={-1}>
          <Outlet />
        </main>
        <footer className="app-footer">
          <span>StreamShield Live</span>
          <Link className="text-link" to="/about">
            About this build
          </Link>
        </footer>
      </div>
    </div>
  );
}
