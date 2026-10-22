import type { Publishing } from "@streamshield/shared";

export function whipResource(
  location: string,
  endpoint: string,
  origin = window.location.origin,
) {
  const base = new URL(endpoint, origin);
  const url = new URL(location, base);
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.startsWith(base.pathname + "/")
  )
    throw new Error(
      "The publishing service returned an invalid session address.",
    );
  return url.toString();
}

export async function publishWhip(
  stream: MediaStream,
  publishing: Publishing,
  onState: (state: RTCPeerConnectionState) => void,
) {
  if (!publishing.whipUrl)
    throw new Error(
      "Browser publishing is unavailable in this deployment. Use OBS.",
    );
  const pc = new RTCPeerConnection({ iceServers: [] });
  let resource: string | undefined;
  const auth = "Basic " + btoa(publishing.user + ":" + publishing.key);
  const close = async () => {
    pc.close();
    if (resource) {
      const url = resource;
      resource = undefined;
      await fetch(url, {
        method: "DELETE",
        headers: { Authorization: auth },
        credentials: "omit",
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      }).catch(() => {});
    }
  };
  try {
    pc.onconnectionstatechange = () => onState(pc.connectionState);
    for (const track of stream.getTracks()) {
      const transceiver = pc.addTransceiver(track, {
        direction: "sendonly",
        streams: [stream],
      });
      const capabilities = RTCRtpSender.getCapabilities(track.kind);
      const codecs =
        capabilities?.codecs.filter(
          (c) =>
            c.mimeType.toLowerCase() ===
            (track.kind === "video" ? "video/h264" : "audio/opus"),
        ) || [];
      if (!codecs.length)
        throw new Error(
          `This browser cannot publish ${track.kind === "video" ? "H.264 video" : "Opus audio"}. Use a compatible Chrome/Edge browser or OBS.`,
        );
      transceiver.setCodecPreferences(codecs);
    }
    await pc.setLocalDescription(await pc.createOffer());
    if (pc.iceGatheringState !== "complete")
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          pc.removeEventListener("icegatheringstatechange", check);
          reject(
            new Error("ICE candidate gathering timed out. Check your network."),
          );
        }, 10000);
        function check() {
          if (pc.iceGatheringState === "complete") {
            clearTimeout(timer);
            pc.removeEventListener("icegatheringstatechange", check);
            resolve();
          }
        }
        pc.addEventListener("icegatheringstatechange", check);
        check();
      });
    const response = await fetch(publishing.whipUrl, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/sdp" },
      body: pc.localDescription!.sdp,
      credentials: "omit",
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
    if (response.status !== 201)
      throw new Error(
        `Publishing negotiation failed (${response.status}). Check the stream key and service health.`,
      );
    const location = response.headers.get("Location");
    if (!location) throw new Error("Publishing session address is missing.");
    resource = whipResource(location, publishing.whipUrl);
    await pc.setRemoteDescription({
      type: "answer",
      sdp: await response.text(),
    });
    return { close, stats: () => pc.getStats() };
  } catch (e) {
    await close();
    throw e;
  }
}
