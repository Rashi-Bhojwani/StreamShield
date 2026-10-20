# Phase 2 official references reviewed

The documentation websites were denied by this cloud's initial egress policy. Equivalent official source documentation was read from the repositories through the existing Git/GitHub proxy. The required documentation domains and `api.github.com` were added to the cloud draft; saving the draft alone does not update the running network.

- [MediaMTX v1.21.2 installation / pinned image variants](https://github.com/bluenviron/mediamtx/blob/v1.21.2/docs/1-kickoff/2-install.md)
- [Configuration and environment overrides](https://github.com/bluenviron/mediamtx/blob/v1.21.2/docs/2-features/05-configuration.md), [full pinned configuration](https://github.com/bluenviron/mediamtx/blob/v1.21.2/mediamtx.yml)
- [Authentication / RTMP username and password queries](https://github.com/bluenviron/mediamtx/blob/v1.21.2/docs/2-features/06-authentication.md)
- [RTMP publishing](https://github.com/bluenviron/mediamtx/blob/v1.21.2/docs/3-publish/09-rtmp-clients.md), [FFmpeg](https://github.com/bluenviron/mediamtx/blob/v1.21.2/docs/3-publish/17-ffmpeg.md), [OBS](https://github.com/bluenviron/mediamtx/blob/v1.21.2/docs/3-publish/19-obs-studio.md)
- [HLS delivery](https://github.com/bluenviron/mediamtx/blob/v1.21.2/docs/4-read/06-hls.md), [browser playback](https://github.com/bluenviron/mediamtx/blob/v1.21.2/docs/4-read/07-web-browsers.md)
- [Subfolder reverse proxy request and Location rewriting](https://github.com/bluenviron/mediamtx/blob/v1.21.2/docs/2-features/16-expose-the-server-in-a-subfolder.md)
- [MediaMTX v3 Control API schemas](https://github.com/bluenviron/mediamtx/blob/v1.21.2/api/openapi.yaml): `online` / `available` are current source observations; deprecated `tracks` remains supported by the pinned release.
- [hls.js integration / feature detection](https://github.com/video-dev/hls.js/blob/master/README.md), [API events, load policies, fatal errors and cleanup](https://github.com/video-dev/hls.js/blob/master/docs/API.md). npm package tooling verified stable hls.js 1.7.3 before installation; the lockfile records integrity.
- [MDN autoplay guide official source](https://github.com/mdn/content/blob/main/files/en-us/web/media/guides/autoplay/index.md): muted playback, `playsinline`, rejected `play()` promises and user interaction.
- [MDN video codec guide official source](https://github.com/mdn/content/blob/main/files/en-us/web/media/guides/formats/video_codecs/index.md): H.264 with AAC offers broad compatibility, not a guarantee on every installed browser build.
- [FFmpeg RTMP protocol reference](https://github.com/FFmpeg/FFmpeg/blob/master/doc/protocols.texi), [lavfi testsrc2/sine filters](https://github.com/FFmpeg/FFmpeg/blob/master/doc/filters.texi): bounded real-time synthetic sources and standard FLV/RTMP output.

Implementation consequences: MediaMTX remuxes rather than transcodes; choose compatible publishing codecs. HLS availability is distinct from browser decoding. Prefer hls.js when MSE is supported, with native HLS fallback. Do not continuously reset retry budgets on a transient successful event. Autoplay begins muted and rejection remains visible. Destroy HLS instances and timers on unmount. MediaMTX's HLS cookie-check redirect requires explicit handling at the configured subfolder proxy.

## Combined delivery review, 19 October 2026

Re-read the current official hls.js API (manifest-loaded/error details, fragment failures and destruction) and MDN autoplay/codec sources, plus pinned MediaMTX RTMP, HLS and configuration sources through GitHub. The implementation also checks the installed hls.js 1.7.3 declarations. Actual error details drive typed manifest/segment classifications; HTTP 404/410 is labelled source delivery unavailable rather than publisher offline. `loadedmetadata` is native readiness, not evidence of a separately inspected HLS manifest. Startup and recovery events require progressing media time.
