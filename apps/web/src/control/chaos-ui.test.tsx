import { beforeAll, afterAll, expect, it, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { ChaosSnapshot, ChaosExperiment } from "@streamshield/shared";
import { primaryDemoIds } from "@streamshield/shared";
import { AuthContext, type Auth } from "../platform/auth-context";
import { RequestError } from "../platform/request";
import { scenarios } from "../../../../services/api/src/chaos/config";
import { ChaosLab, ChaosDemo } from "./Chaos";
import { Presentation } from "./Presentation";
vi.mock("../streaming/useStreams", () => ({
  useStreams: () => ({ data: { streams: [] } }),
}));
vi.mock("./useRecovery", () => ({
  useRecovery: () => ({ data: { attempts: [], available: true } }),
}));
vi.mock("./useEvidence", () => ({
  useTimeline: () => ({ data: undefined }),
  useImpact: () => ({ data: undefined }),
}));
const originalShow = HTMLDialogElement.prototype.showModal,
  originalClose = HTMLDialogElement.prototype.close;
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterAll(() => {
  HTMLDialogElement.prototype.showModal = originalShow;
  HTMLDialogElement.prototype.close = originalClose;
});
function fixture() {
  const stamp = new Date().toISOString();
  let state: ChaosSnapshot = {
    version: 1,
    available: true,
    enabled: true,
    databaseAvailable: true,
    observedAt: stamp,
    serverTime: stamp,
    staleAfterMs: 12000,
    activeId: null,
    observationWindowMs: 15000,
    faultDurationMs: 8000,
    timeoutMs: 180000,
    scenarios: scenarios.map((s) => ({
      ...s,
      available: s.supported,
      reason: s.supported ? null : s.reason,
    })),
    experiments: [],
  };
  const call = vi.fn(async (path: string, options?: RequestInit) => {
    if (options?.method === "POST") {
      const b = JSON.parse(options.body as string);
      const e: ChaosExperiment = {
        id: b.id,
        actor: crypto.randomUUID(),
        scenario: b.scenario,
        target: b.confirmation,
        state: "VALIDATING",
        createdAt: stamp,
        updatedAt: stamp,
        injectedAt: null,
        faultConfirmedAt: null,
        incidentDetectedAt: null,
        actionStartedAt: null,
        actionFinishedAt: null,
        verifiedAt: null,
        finishedAt: null,
        deadline: Date.now() + 180000,
        faultExpiresAt: null,
        incidentId: null,
        recoveryIds: [],
        priorRecoveryIds: [],
        reason: "Awaiting actual fault confirmation",
        mechanism: null,
        cleanup: "NOT_REQUIRED",
        cancelRequestedBy: null,
        databasePersisted: true,
        evidence: {},
        events: [],
        measurements: {
          detectionMs: null,
          healingStartMs: null,
          actionMs: null,
          restorationMs: null,
          playbackInterruptionMs: null,
        },
      };
      state = { ...state, activeId: e.id, experiments: [e] };
      return e;
    }
    return state;
  });
  const auth = {
    user: null,
    csrf: "test",
    loading: false,
    error: null,
    heartbeatMs: 3000,
    refresh: async () => {},
    call: call as Auth["call"],
  } satisfies Auth;
  const mount = (ui: React.ReactNode) =>
    render(
      <MemoryRouter>
        <QueryClientProvider
          client={
            new QueryClient({
              defaultOptions: { queries: { retry: false, gcTime: 0 } },
            })
          }
        >
          <AuthContext.Provider value={auth}>{ui}</AuthContext.Provider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  return {
    call,
    mount,
    get state() {
      return state;
    },
    set state(value: ChaosSnapshot) {
      state = value;
    },
  };
}
it("renders exactly the same four primary scenarios on Chaos, Demo and Presentation", async () => {
  for (const page of [
    <ChaosLab />,
    <ChaosDemo components={[]} stale={false} topology={null} />,
    <Presentation components={[]} stale={false} />,
  ]) {
    const f = fixture(),
      { container } = f.mount(page);
    await waitFor(() => expect(f.call).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        [...container.querySelectorAll("[data-scenario]")].map((n) =>
          n.getAttribute("data-scenario"),
        ),
      ).toEqual(primaryDemoIds),
    );
    expect(
      screen.getAllByRole("button", { name: "Run failure demonstration" }),
    ).toHaveLength(1);
    cleanup();
  }
});
it("shows expired authentication as its own disabled reason", async () => {
  const f = fixture();
  f.call.mockRejectedValue(new RequestError(401, "expired"));
  const { container } = f.mount(<ChaosLab />);
  await screen.findByRole("alert");
  expect(
    screen.getAllByText(/Authentication has expired/).length,
  ).toBeGreaterThan(0);
  expect(container.querySelector(".chaos-inject:not([disabled])")).toBeNull();
});
it("disables all Presentation buttons on stale data even when old scenario availability says true", async () => {
  const f = fixture();
  f.state = {
    ...f.state,
    observedAt: new Date(Date.now() - 20000).toISOString(),
  };
  const { container } = f.mount(<Presentation components={[]} stale={false} />);
  await waitFor(() =>
    expect(container.querySelectorAll("button[data-scenario]")).toHaveLength(4),
  );
  expect(
    screen.getByRole("button", { name: "Run failure demonstration" }),
  ).toBeDisabled();
  await waitFor(() =>
    expect(
      screen.getAllByText(/Monitoring data is stale/).length,
    ).toBeGreaterThan(0),
  );
});
async function configure() {
  const run = await screen.findByRole("button", {
    name: "Run failure demonstration",
  });
  await waitFor(() => expect(run).toBeEnabled());
  fireEvent.click(run);
  expect(screen.getByRole("dialog")).toBeVisible();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.change(screen.getByLabelText("Confirm target"), {
    target: { value: "api-1" },
  });
}
it("opens exact-target configuration and displays validating without claiming injection", async () => {
  const f = fixture();
  f.mount(<ChaosLab />);
  await configure();
  fireEvent.click(
    screen.getByRole("button", { name: "Inject controlled failure" }),
  );
  await waitFor(() =>
    expect(f.call.mock.calls.some(([, o]) => o?.method === "POST")).toBe(true),
  );
  await screen.findByText("Awaiting actual fault confirmation");
  expect(document.querySelector('[data-stage="1"]')).toHaveAttribute(
    "data-verified",
    "false",
  );
  expect(screen.queryByText("FAULT CONFIRMED")).not.toBeInTheDocument();
});
it("rechecks freshness when confirming an already-open dialog", async () => {
  const f = fixture();
  f.mount(<ChaosLab />);
  await configure();
  f.state = {
    ...f.state,
    observedAt: new Date(Date.now() - 20000).toISOString(),
  };
  fireEvent.click(
    screen.getByRole("button", { name: "Inject controlled failure" }),
  );
  await waitFor(() =>
    expect(
      screen.getAllByText(/Monitoring data is stale/).length,
    ).toBeGreaterThan(0),
  );
  expect(f.call.mock.calls.some(([, o]) => o?.method === "POST")).toBe(false);
});
it("retains a server denial and never creates a false injected state", async () => {
  const f = fixture();
  const original = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (p, o) => {
    if (o?.method === "POST")
      throw new RequestError(409, "Previous recovery is not verified");
    return original(p, o);
  });
  f.mount(<ChaosLab />);
  await configure();
  fireEvent.click(
    screen.getByRole("button", { name: "Inject controlled failure" }),
  );
  await screen.findByText("Previous recovery is not verified");
  expect(screen.queryByText("FAULT CONFIRMED")).not.toBeInTheDocument();
});

it("prevents duplicate confirmation submissions with a single durable experiment ID", async () => {
  const f = fixture();
  f.mount(<ChaosLab />);
  await configure();
  const button = screen.getByRole("button", {
    name: "Inject controlled failure",
  });
  fireEvent.click(button);
  fireEvent.click(button);
  await waitFor(() =>
    expect(
      f.call.mock.calls.filter(([, o]) => o?.method === "POST"),
    ).toHaveLength(1),
  );
});
it("reconnects a refreshed view to the active experiment without opening a new fault", async () => {
  const f = fixture();
  const id = crypto.randomUUID();
  await f.call("/monitoring/chaos/experiments", {
    method: "POST",
    body: JSON.stringify({ id, scenario: "crash-api", confirmation: "api-1" }),
  });
  f.call.mockClear();
  f.mount(<ChaosLab />);
  await screen.findByText("Experiment " + id);
  expect(
    screen.getByRole("button", { name: "Run failure demonstration" }),
  ).toBeDisabled();
  expect(f.call.mock.calls.some(([, o]) => o?.method === "POST")).toBe(false);
});
it("keeps polling readiness without a WebSocket connection", async () => {
  const f = fixture();
  f.mount(<ChaosLab />);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Run failure demonstration" }),
    ).toBeEnabled(),
  );
  f.state = {
    ...f.state,
    available: false,
    unavailableReason: "Independent Healer is reconnecting",
  };
  await waitFor(
    () =>
      expect(
        screen.getByRole("button", { name: "Run failure demonstration" }),
      ).toBeDisabled(),
    { timeout: 4500 },
  );
  expect(
    f.call.mock.calls.filter(([path]) => path === "/monitoring/chaos").length,
  ).toBeGreaterThan(1);
});
it("keeps a safely closed failed demo failed while allowing a new verified-ready scenario", async () => {
  const f = fixture();
  await f.call("/monitoring/chaos/experiments", {
    method: "POST",
    body: JSON.stringify({
      id: crypto.randomUUID(),
      scenario: "crash-api",
      confirmation: "api-1",
    }),
  });
  const e = f.state.experiments[0]!,
    at = new Date().toISOString();
  e.state = "TIMED_OUT";
  e.injectedAt = at;
  e.finishedAt = at;
  e.evidence.terminalBaselineReverifiedAt = at;
  e.events.push({
    kind: "BASELINE_REVERIFIED",
    at,
    detail: "Independent safe baseline checks passed",
  });
  f.state = { ...f.state, activeId: null, experiments: [e] };
  f.mount(<ChaosLab />);
  await screen.findByRole("heading", {
    name: "Previous demo failed; safe baseline reverified",
  });
  expect(
    screen.getByRole("button", { name: "Run failure demonstration" }),
  ).toBeEnabled();
  expect(document.querySelector('[data-stage="6"]')).toHaveAttribute(
    "data-verified",
    "false",
  );
});
