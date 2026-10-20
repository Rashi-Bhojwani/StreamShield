import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { offlineList } from "./streaming/test-fixtures";
import { App } from "./App";
import { webConfigSchema } from "./config";
const metadata = {
  name: "StreamShield",
  version: "0.1.0",
  phase: 2,
  capabilities: ["API health probes"],
};
function mount(path = "/") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
afterEach(() => vi.unstubAllGlobals());
describe("application shell", () => {
  it("connects diagnostics using real response contracts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: string) =>
          new Response(
            JSON.stringify(
              url.includes("/streams")
                ? offlineList
                : url.endsWith("/system/info")
                  ? metadata
                  : { status: "ready", service: "streamshield-api" },
            ),
          ),
      ),
    );
    mount("/diagnostics");
    expect(
      screen.getByRole("heading", { name: "Checking API" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: "API connected" }),
    ).toBeInTheDocument();

    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/health/ready",
      expect.any(Object),
    );
  });
  it("shows unavailability and lets the user retry without claiming stale health", async () => {
    const mock = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", mock);
    mount("/foundation");
    expect(
      await screen.findByRole("heading", { name: "API unavailable" }),
    ).toBeInTheDocument();
    mock.mockImplementation(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.includes("/streams")
              ? offlineList
              : url.endsWith("/system/info")
                ? metadata
                : { status: "ready", service: "streamshield-api" },
          ),
        ),
    );
    await userEvent.click(screen.getByRole("button", { name: /Check again/ }));
    expect(
      await screen.findByRole("heading", { name: "API connected" }),
    ).toBeInTheDocument();
  });
  it("rejects malformed successful responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}")),
    );
    mount("/diagnostics");
    expect(
      await screen.findByRole("heading", { name: "API unavailable" }),
    ).toBeInTheDocument();
  });
  it("supports navigation and not-found pages", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    mount("/missing");
    expect(
      screen.getByRole("heading", { name: /This page is off the air/ }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: /Back to Home/ }));
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /A good place to tune in/ }),
      ).toBeInTheDocument(),
    );
  });
  it("rejects invalid browser configuration", () => {
    expect(
      webConfigSchema.safeParse({
        VITE_API_BASE_URL: "//evil.example",
        VITE_API_TIMEOUT_MS: 1,
        VITE_STATUS_POLL_MS: -1,
      }).success,
    ).toBe(false);
  });
});
