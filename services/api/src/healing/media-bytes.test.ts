import { expect, it } from "vitest";
import { validHlsInit, validHlsSegment } from "./media-bytes.js";
const box = (type: string, size = 8) => {
  const b = Buffer.alloc(size);
  b.writeUInt32BE(size);
  b.write(type, 4, "ascii");
  return b;
};
it("requires actual ISO BMFF init boxes rather than HTML or an arbitrary nonempty response", () => {
  expect(validHlsInit(Buffer.from("<html>200 OK</html>"))).toBe(false);
  expect(validHlsInit(Buffer.concat([box("ftyp"), box("moov")]))).toBe(true);
  expect(validHlsInit(box("ftyp"))).toBe(false);
});
it("requires fragment and media-data boxes with consistent lengths", () => {
  expect(
    validHlsSegment(Buffer.concat([box("moof", 16), box("mdat", 16)]), true),
  ).toBe(true);
  expect(validHlsSegment(Buffer.from("#EXTM3U\n"), true)).toBe(false);
  expect(
    validHlsSegment(
      Buffer.concat([box("moof"), Buffer.from("not a media box")]),
      true,
    ),
  ).toBe(false);
  expect(validHlsSegment(box("moof"), true)).toBe(false);
});
it("rejects empty, truncated or malformed transport streams", () => {
  const good = Buffer.alloc(376);
  good[0] = 0x47;
  good[188] = 0x47;
  expect(validHlsSegment(good, false)).toBe(true);
  good[188] = 0;
  expect(validHlsSegment(good, false)).toBe(false);
  expect(validHlsSegment(Buffer.alloc(0), false)).toBe(false);
  expect(validHlsSegment(Buffer.from("healthy"), false)).toBe(false);
});
