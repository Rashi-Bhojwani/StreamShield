// Explicit offline fixture; production discovery always uses the API.
export const offlineList = {
  streams: [
    {
      id: "live",
      title: "Test channel",
      status: "offline",
      publisher: "offline",
      hls: "not_checked",
      reason: "publisher_absent",
      checkedAt: "2026-01-01T00:00:00.000Z",
      playbackUrl: "/media/live/index.m3u8",
      tracks: [],
    },
  ],
};
