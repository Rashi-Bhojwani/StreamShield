/** Container-format checks, not a claim of browser decoding. */
export function mp4Boxes(bytes: Uint8Array) {
  const data = Buffer.from(bytes),
    types: string[] = [];
  let offset = 0;
  while (offset < data.length) {
    if (offset + 8 > data.length) return [];
    const size = data.readUInt32BE(offset),
      type = data.toString("ascii", offset + 4, offset + 8);
    if (size < 8 || offset + size > data.length) return [];
    types.push(type);
    offset += size;
  }
  return types;
}
export function validHlsInit(bytes: Uint8Array) {
  const boxes = mp4Boxes(bytes);
  return boxes.includes("ftyp") && boxes.includes("moov");
}
export function validHlsSegment(bytes: Uint8Array, fragmented: boolean) {
  if (fragmented) {
    const boxes = mp4Boxes(bytes);
    return (
      bytes.length > 16 && boxes.includes("moof") && boxes.includes("mdat")
    );
  }
  if (bytes.length < 188 || bytes.length % 188 !== 0) return false;
  for (let offset = 0; offset < bytes.length; offset += 188)
    if (bytes[offset] !== 0x47) return false;
  return true;
}
