import { useCallback, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { authSchema } from "@streamshield/shared";
import { AuthContext, useAuth } from "./auth-context";
import { platformRequest, RequestError } from "./request";
export function AuthProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["account"],
    queryFn: async () => authSchema.parse(await platformRequest("/auth/me")),
    retry: false,
    staleTime: 0,
  });
  const token = query.data?.csrf || "";
  const call = useCallback(
    async <T,>(path: string, options: RequestInit = {}) => {
      try {
        return await platformRequest<T>(path, options, token);
      } catch (error) {
        if (error instanceof RequestError && error.status === 401)
          void client.invalidateQueries({ queryKey: ["account"] });
        throw error;
      }
    },
    [token, client],
  );
  return (
    <AuthContext.Provider
      value={{
        demoMode: query.data?.demoMode || false,
        guest: query.data?.guest || null,
        user: query.data?.user || null,
        csrf: token,
        loading: query.isPending,
        error: query.isError ? "Accounts are temporarily unavailable." : null,
        heartbeatMs: query.data?.presenceHeartbeatMs || 0,
        refresh: query.refetch,
        call,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
export function Protected({ children }: { children: ReactNode }) {
  const auth = useAuth(),
    location = useLocation();
  if (auth.loading)
    return <p className="loading-surface">Restoring your session…</p>;
  if (auth.error)
    return (
      <div className="quiet-state">
        <p>{auth.error}</p>
        <button
          className="button secondary"
          onClick={() => void auth.refresh()}
        >
          Retry connection
        </button>
      </div>
    );
  if (!auth.user && auth.demoMode)
    return (
      <div className="cc-access">
        <h1>Private operator access</h1>
        <p>
          Use the trusted local terminal to issue a short-lived administrator
          session.
        </p>
        <Link className="button secondary" to="/">
          Return to live channels
        </Link>
      </div>
    );
  if (!auth.user)
    return (
      <Navigate
        to={"/login?next=" + encodeURIComponent(location.pathname)}
        replace
      />
    );
  return children;
}
export function AuthPage({ signup = false }: { signup?: boolean }) {
  const auth = useAuth(),
    navigate = useNavigate(),
    location = useLocation();
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const requested =
    new URLSearchParams(location.search).get("next") || "/studio";
  const next =
    requested.startsWith("/") && !requested.startsWith("//")
      ? requested
      : "/studio";
  if (auth.user) return <Navigate to={next} replace />;
  return (
    <div className="auth-layout">
      <section className="auth-intro">
        <span className="eyebrow">Your next live moment</span>
        <h1>{signup ? "Make yourself at home." : "Welcome back to Live."}</h1>
        <p>
          Watch something unfold. Join the conversation. Or share a live moment
          of your own.
        </p>
        <div className="auth-orbit" aria-hidden="true">
          ◉
        </div>
        <p className="fine-print">
          One account for watching, chatting and broadcasting.
        </p>
      </section>
      <section className="panel auth-card">
        <span className="subtle-chip">StreamShield account</span>
        <h2>{signup ? "Create your account" : "Sign in"}</h2>
        <p className="muted">
          {signup
            ? "A place in the conversation starts here."
            : "Pick up where you left off."}
        </p>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError("");
            const form = new FormData(event.currentTarget);
            try {
              await auth.call(signup ? "/auth/register" : "/auth/login", {
                method: "POST",
                body: JSON.stringify(
                  signup
                    ? {
                        username: form.get("username"),
                        email: form.get("email"),
                        password: form.get("password"),
                      }
                    : {
                        identifier: form.get("identifier"),
                        password: form.get("password"),
                      },
                ),
              });
              await auth.refresh();
              navigate(next, { replace: true });
            } catch (e) {
              setError(e instanceof Error ? e.message : "Unable to sign in.");
            } finally {
              setBusy(false);
            }
          }}
        >
          {signup ? (
            <>
              <label>
                Username
                <input
                  name="username"
                  autoComplete="username"
                  required
                  minLength={3}
                  maxLength={24}
                  pattern="[a-zA-Z0-9_]+"
                  placeholder="your_name"
                />
              </label>
              <label>
                Email address
                <input
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  maxLength={254}
                  placeholder="you@example.com"
                />
              </label>
            </>
          ) : (
            <label>
              Email or username
              <input
                name="identifier"
                autoComplete="username"
                required
                maxLength={254}
              />
            </label>
          )}
          <label>
            Password
            <input
              name="password"
              type="password"
              required
              minLength={signup ? 12 : 1}
              maxLength={128}
              autoComplete={signup ? "new-password" : "current-password"}
            />
          </label>
          {signup && (
            <p className="fine-print">
              Use at least 12 characters. Usernames use letters, numbers and
              underscores.
            </p>
          )}
          {(error || auth.error) && (
            <p role="alert" className="form-error">
              {error || auth.error}
            </p>
          )}
          <button
            className="button primary"
            disabled={busy || auth.loading || !auth.csrf}
          >
            {busy ? "Please wait…" : signup ? "Create account" : "Sign in"}
          </button>
        </form>
        <p>
          {signup ? "Already have an account?" : "New to StreamShield?"}{" "}
          <Link
            className="inline-link"
            to={
              (signup ? "/login" : "/signup") +
              "?next=" +
              encodeURIComponent(next)
            }
          >
            {signup ? "Sign in" : "Create an account"}
          </Link>
        </p>
        {auth.error && (
          <button className="text-link" onClick={() => void auth.refresh()}>
            Retry account connection
          </button>
        )}
      </section>
    </div>
  );
}
export function AccountMenu() {
  const auth = useAuth(),
    navigate = useNavigate(),
    client = useQueryClient();
  const [error, setError] = useState("");
  if (!auth.user)
    return (
      <Link className="button secondary signin-link" to="/login">
        Sign in
      </Link>
    );
  return (
    <details className="account-menu">
      <summary aria-label="Account menu" role="button">
        <span className="avatar">
          {auth.user.username.slice(0, 1).toUpperCase()}
        </span>
        <span>{auth.user.username}</span>
      </summary>
      <div className="account-popover">
        <p className="fine-print">Signed in as {auth.user.username}</p>
        <Link to="/profile">Your profile</Link>
        <Link to="/studio">Broadcaster Studio</Link>
        <button
          onClick={async () => {
            try {
              await auth.call("/auth/logout", { method: "POST" });
              client.removeQueries({ queryKey: ["studio"] });
              await auth.refresh();
              navigate("/");
            } catch (e) {
              setError(e instanceof Error ? e.message : "Logout failed.");
            }
          }}
        >
          Sign out
        </button>
        {error && <p role="alert">{error}</p>}
      </div>
    </details>
  );
}
export function Profile() {
  const auth = useAuth(),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <Protected>
      <div className="profile-page">
        <div className="page-heading">
          <div>
            <p className="eyebrow">Your account</p>
            <h1>A little more you.</h1>
            <p className="page-subtitle">
              Your identity across StreamShield Live.
            </p>
          </div>
        </div>
        <section className="panel form-panel">
          <span className="avatar large">
            {auth.user?.username.slice(0, 1).toUpperCase()}
          </span>
          <h2>@{auth.user?.username}</h2>
          <p className="muted">{auth.user?.email}</p>
          <span className="subtle-chip">{auth.user?.role}</span>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await auth.call("/auth/profile", {
                  method: "PATCH",
                  body: JSON.stringify({
                    displayName: new FormData(e.currentTarget).get(
                      "displayName",
                    ),
                  }),
                });
                await auth.refresh();
                setNotice("Profile updated.");
              } catch (error) {
                setNotice(
                  error instanceof Error ? error.message : "Unable to save.",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              Display name
              <input
                name="displayName"
                required
                maxLength={100}
                defaultValue={auth.user?.displayName}
              />
            </label>
            <button className="button primary" disabled={busy}>
              Save profile
            </button>
            <p role="status">{notice}</p>
          </form>
        </section>
      </div>
    </Protected>
  );
}
