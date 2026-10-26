import { afterEach, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ExperienceStatus } from "./ExperienceStatus";
import { platformRequest, RequestError } from "../platform/request";
import type { Experience } from "@streamshield/shared";
vi.mock("../config", () => ({ config: { VITE_DYNAMIC_MODE: true } }));
vi.mock("../platform/auth-context", () => ({
  useAuth: () => ({ user: { id: "viewer" } }),
}));
vi.mock("../platform/request", async (original) => ({
  ...(await original<typeof import("../platform/request")>()),
  platformRequest: vi.fn(),
}));
const value = (): Experience => ({
  enabled: true,
  available: true,
  observedAt: new Date().toISOString(),
  state: "recovering",
  scenario: "network-timeout",
  message: "Recommendations are reconnecting. Video uses a separate path.",
  recommendations: { available: false, items: [], simulated: true },
});
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      <ExperienceStatus />
    </QueryClientProvider>,
  );
  return client;
}
afterEach(() => vi.clearAllMocks());
it("shows the affected dependency loading while explaining independent video delivery", async () => {
  vi.mocked(platformRequest).mockResolvedValue(value());
  mount();
  expect(await screen.findByText("Recovery in progress")).toBeVisible();
  expect(screen.getByTestId("recommendation-status")).toHaveAttribute(
    "data-state",
    "reconnecting",
  );
  expect(screen.getByText("Reconnecting recommendations…")).toBeVisible();
  expect(screen.getByText(/Video uses a separate path/)).toBeVisible();
});
it("shows verified restoration without leaving an artificial loading state", async () => {
  vi.mocked(platformRequest).mockResolvedValue({
    ...value(),
    state: "recovered",
    recommendations: {
      available: true,
      items: ["Discover a live channel"],
      simulated: true,
    },
  });
  mount();
  expect(await screen.findByText("Back in rhythm")).toBeVisible();
  expect(screen.getByTestId("recommendation-status")).toHaveAttribute(
    "data-state",
    "available",
  );
  expect(
    screen.queryByText("Reconnecting recommendations…"),
  ).not.toBeInTheDocument();
});
it("shows the actual serving API and recovering primary without claiming a video outage", async () => {
  vi.mocked(platformRequest).mockResolvedValue({
    ...value(),
    scenario: "crash-api",
    api: { primary: "recovering", backup: "healthy", servedBy: "api-2" },
  });
  mount();
  expect(await screen.findByTestId("api-continuity")).toHaveAttribute(
    "data-served-by",
    "api-2",
  );
  expect(screen.getByTestId("api-continuity")).toHaveTextContent(
    "API-1: recovering",
  );
  expect(screen.getByTestId("api-continuity")).toHaveTextContent(
    "Video delivery uses its own connection",
  );
});
it("does not show stale success when status requests fail", async () => {
  vi.mocked(platformRequest).mockRejectedValue(Error("Unavailable"));
  mount();
  expect(
    await screen.findByText("Connection status unavailable"),
  ).toBeVisible();
  expect(screen.getByTestId("live-service-impact")).toHaveAttribute(
    "data-state",
    "unavailable",
  );
});
it("clears a previously healthy recommendation result after a failed refresh", async () => {
  vi.mocked(platformRequest).mockResolvedValue({
    ...value(),
    state: "healthy",
    recommendations: {
      available: true,
      items: ["Discover a live channel"],
      simulated: true,
    },
  });
  const client = mount();
  await waitFor(() =>
    expect(screen.getByTestId("recommendation-status")).toHaveAttribute(
      "data-state",
      "available",
    ),
  );
  vi.mocked(platformRequest).mockRejectedValue(Error("Connection lost"));
  await act(async () => {
    await client.invalidateQueries();
  });
  await waitFor(() =>
    expect(screen.getByTestId("recommendation-status")).toHaveAttribute(
      "data-state",
      "unavailable",
    ),
  );
  expect(screen.getByText("Connection status unavailable")).toBeVisible();
});
it("hides the optional local feature when the production endpoint is absent", async () => {
  vi.mocked(platformRequest).mockRejectedValue(
    new RequestError(404, "Not found"),
  );
  mount();
  await waitFor(() => expect(platformRequest).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(screen.queryByTestId("live-service-impact")).not.toBeInTheDocument(),
  );
});
