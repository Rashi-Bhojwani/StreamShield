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
import type { PlaybackObservation } from "@streamshield/shared";
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
    static Events = {
      MANIFEST_PARSED: "manifest",
      MANIFEST_LOADED: "loaded",
      ERROR: "error",
    };
    static ErrorDetails = {
      MANIFEST_LOAD_ERROR: "manifestLoadError",
      MANIFEST_LOAD_TIMEOUT: "manifestLoadTimeOut",
      MANIFEST_PARSING_ERROR: "manifestParsingError",
      LEVEL_LOAD_ERROR: "levelLoadError",
      LEVEL_LOAD_TIMEOUT: "levelLoadTimeOut",
      FRAG_LOAD_ERROR: "fragLoadError",
      FRAG_LOAD_TIMEOUT: "fragLoadTimeOut",
      FRAG_PARSING_ERROR: "fragParsingError",
    };
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
        details: "manifestLoadError",
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
  it("reports real HLS failures and progress, preserves callbacks without reattaching, and starts fresh on source changes", () => {
    const first = vi.fn<(sample: PlaybackObservation) => void>();
    const second = vi.fn<(sample: PlaybackObservation) => void>();
    const rendered = render(
      <LivePlayer
        source="/media/a/index.m3u8"
        sourceId="a"
        onObservation={first}
      />,
    );
    act(() => mock.handlers.get(Hls.Events.MANIFEST_LOADED)?.());
    expect(first.mock.lastCall?.[0].event.kind).toBe("manifest_loaded");
    expect(first.mock.lastCall?.[0].metrics.startupMs).toBeNull();
    rendered.rerender(
      <LivePlayer
        source="/media/a/index.m3u8"
        sourceId="a"
        onObservation={second}
      />,
    );
    expect(mock.loadSource).toHaveBeenCalledTimes(1);
    act(() =>
      mock.handlers.get(Hls.Events.ERROR)?.("error", {
        fatal: false,
        type: "network",
        details: "fragLoadError",
        response: { code: 404 },
      }),
    );
    const events = second.mock.calls.map(
      ([sample]: [PlaybackObservation]) => sample.event.kind,
    );
    expect(events).toEqual(["segment_failure", "source_unavailable"]);
    const video = screen.getByLabelText(
      "Live stream video",
    ) as HTMLVideoElement;
    Object.defineProperty(video, "paused", {
      configurable: true,
      value: false,
    });
    video.currentTime = 1;
    fireEvent.timeUpdate(video);
    expect(second.mock.lastCall?.[0].event.kind).toBe("playback_started");
    rendered.rerender(
      <LivePlayer
        source="/media/b/index.m3u8"
        sourceId="b"
        onObservation={second}
      />,
    );
    expect(mock.destroy).toHaveBeenCalled();
    expect(second.mock.lastCall?.[0]).toMatchObject({
      event: { kind: "player_initialized", sourceId: "b" },
      metrics: { startupMs: null, stallCount: 0, lastError: null },
    });
  });
  it("reports native readiness without claiming HLS manifest inspection and removes native listeners", () => {
    mock.supported = false;
    vi.mocked(HTMLMediaElement.prototype.canPlayType).mockReturnValue("maybe");
    const onObservation = vi.fn<(sample: PlaybackObservation) => void>();
    const rendered = render(
      <LivePlayer
        source="/media/live/index.m3u8"
        sourceId="live"
        onObservation={onObservation}
      />,
    );
    const video = screen.getByLabelText("Live stream video");
    fireEvent.loadedMetadata(video);
    expect(onObservation.mock.lastCall?.[0].event.kind).toBe(
      "native_media_ready",
    );
    expect(
      onObservation.mock.calls.some(
        ([sample]: [PlaybackObservation]) =>
          sample.event.kind === "manifest_loaded",
      ),
    ).toBe(false);
    rendered.unmount();
    const calls = onObservation.mock.calls.length;
    fireEvent.loadedMetadata(video);
    fireEvent.ended(video);
    expect(onObservation).toHaveBeenCalledTimes(calls);
  });
});
