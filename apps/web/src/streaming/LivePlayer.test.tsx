import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { LivePlayer } from "./LivePlayer";
import Hls from "hls.js";
const mock = vi.hoisted(() => ({
  supported: true,
  handlers: new Map<string, (...args: unknown[]) => void>(),
  destroy: vi.fn(),
  loadSource: vi.fn(),
  attachMedia: vi.fn(),
}));
vi.mock("hls.js", () => ({
  default: class {
    static isSupported() {
      return mock.supported;
    }
    static Events = { MANIFEST_PARSED: "manifest", ERROR: "error" };
    static ErrorTypes = { MEDIA_ERROR: "media" };
    on(event: string, cb: (...args: unknown[]) => void) {
      mock.handlers.set(event, cb);
    }
    destroy = mock.destroy;
    loadSource = mock.loadSource;
    attachMedia = mock.attachMedia;
  },
}));
beforeEach(() => {
  vi.useFakeTimers();
  mock.supported = true;
  mock.handlers.clear();
  vi.clearAllMocks();
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe("live player", () => {
  it("requires actual progress rather than repeated waiting events to reset the stall deadline", async () => {
    render(<LivePlayer source="/media/live/index.m3u8" />);
    fireEvent.playing(screen.getByLabelText("Live stream video"));
    await act(() => vi.advanceTimersByTimeAsync(7500));
    fireEvent.waiting(screen.getByLabelText("Live stream video"));
    await act(() => vi.advanceTimersByTimeAsync(7500));
    expect(screen.getByTestId("playback-state")).toHaveTextContent(
      "reconnecting",
    );
  });

  it("uses media events for playback state and releases HLS on unmount", async () => {
    const { unmount } = render(<LivePlayer source="/media/live/index.m3u8" />);
    expect(mock.loadSource).toHaveBeenCalledWith("/media/live/index.m3u8");
    expect(screen.getByTestId("playback-state")).toHaveTextContent("loading");
    fireEvent.playing(screen.getByLabelText("Live stream video"));
    expect(screen.getByTestId("playback-state")).toHaveTextContent("playing");
    fireEvent.waiting(screen.getByLabelText("Live stream video"));
    expect(screen.getByTestId("playback-state")).toHaveTextContent("buffering");
    unmount();
    expect(mock.destroy).toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(60000));
    expect(mock.loadSource).toHaveBeenCalledTimes(1);
  });
  it("exhausts a bounded fatal-error retry budget and permits manual retry", async () => {
    render(<LivePlayer source="/media/live/index.m3u8" />);
    const fatal = () =>
      mock.handlers.get(Hls.Events.ERROR)?.("error", {
        fatal: true,
        type: "network",
      });
    act(fatal);
    expect(screen.getByTestId("playback-state")).toHaveTextContent(
      "reconnecting",
    );
    await act(() => vi.advanceTimersByTimeAsync(100));
    act(fatal);
    await act(() => vi.advanceTimersByTimeAsync(200));
    act(fatal);
    expect(screen.getByTestId("playback-state")).toHaveTextContent("error");
    await act(() => vi.advanceTimersByTimeAsync(60000));
    expect(mock.loadSource).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getByRole("button", { name: "Retry playback" }));
    expect(mock.loadSource).toHaveBeenCalledTimes(4);
  });
  it("handles autoplay rejection honestly", async () => {
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValue(
      new DOMException("blocked", "NotAllowedError"),
    );
    render(<LivePlayer source="/media/live/index.m3u8" />);
    await act(async () => {
      mock.handlers.get(Hls.Events.MANIFEST_PARSED)?.();
    });
    expect(screen.getByTestId("playback-state")).toHaveTextContent("blocked");
  });
  it("uses native HLS when MSE is unavailable and rejects unsupported browsers", () => {
    mock.supported = false;
    vi.mocked(HTMLMediaElement.prototype.canPlayType).mockReturnValue("maybe");
    const first = render(<LivePlayer source="/media/live/index.m3u8" />);
    expect(screen.getByLabelText("Live stream video")).toHaveAttribute(
      "src",
      "/media/live/index.m3u8",
    );
    first.unmount();
    vi.mocked(HTMLMediaElement.prototype.canPlayType).mockReturnValue("");
    render(<LivePlayer source="/media/live/index.m3u8" />);
    expect(screen.getByTestId("playback-state")).toHaveTextContent(
      "unsupported",
    );
  });
});
