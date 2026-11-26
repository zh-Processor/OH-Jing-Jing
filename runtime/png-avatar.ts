const prefix = "data:image/png;base64,";

export function readPngAvatar(value: unknown, label = "头像") {
  if (typeof value !== "string" || value.length > 96_000 ||
      !value.startsWith(prefix) || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.slice(prefix.length))) {
    throw new Error(`${label}必须为 96 KB 内的内嵌 PNG 数据。`);
  }
  const png = Buffer.from(value.slice(prefix.length), "base64");
  if (png.length < 33 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
      png.toString("ascii", 12, 16) !== "IHDR" || png.readUInt32BE(8) !== 13 ||
      [png.readUInt32BE(16), png.readUInt32BE(20)].some(size => size < 1 || size > 512)) {
    throw new Error(`${label} PNG 尺寸必须在 1 到 512 像素之间。`);
  }
  return prefix + png.toString("base64");
}
