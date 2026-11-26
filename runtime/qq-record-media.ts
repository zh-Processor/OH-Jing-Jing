import { maximumAudioBytes, pcmWav, readVoiceResponse } from "./qq-voice.js";

const silkHeader = "#!SILK_V3";
const speechSampleRate = 16_000;
const maxSpeechSeconds = 60;
const maxSilkPackets = maxSpeechSeconds * 50;
const mediaDomains = new Set(["multimedia.nt.qq.com.cn", "grouptalk.c2c.qq.com"]);

export function qqRecordUrl(input: unknown) {
  if (typeof input !== "string" || input.length > 4096) return;
  try {
    const url = new URL(input);
    return url.protocol === "https:" && mediaDomains.has(url.hostname) && !url.port && !url.username && !url.password && !url.hash ? url : undefined;
  } catch { return undefined; }
}

function boundedSilk(bytes: Buffer) {
  const start = bytes[0] === 2 ? 1 : 0;
  if (bytes.toString("ascii", start, start + silkHeader.length) !== silkHeader) return false;
  let offset = start + silkHeader.length;
  let packets = 0;
  while (offset + 2 <= bytes.length) {
    const length = bytes.readInt16LE(offset);
    offset += 2;
    if (length === -1 && offset === bytes.length) return packets > 0;
    if (length < 0 || length > 8192 || ++packets > maxSilkPackets || offset + length > bytes.length) return false;
    offset += length;
  }
  return packets > 0 && offset === bytes.length;
}

function monoWav(samples: Uint8Array) {
  const { byteLength } = samples;
  if (!byteLength || byteLength % 2 || byteLength > speechSampleRate * 2 * maxSpeechSeconds) return null;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(byteLength + 36, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(speechSampleRate, 24);
  header.writeUInt32LE(speechSampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(byteLength, 40);
  return Buffer.concat([header, samples]);
}

async function decodedVoice(bytes: Buffer, signal: AbortSignal) {
  const wav = pcmWav(bytes);
  if (wav) return wav;
  if (!boundedSilk(bytes)) return null;
  const { decode } = await import("silk-wasm");
  signal.throwIfAborted();
  return monoWav((await decode(bytes, speechSampleRate)).data);
}

export async function readQqRecord(url: URL, signal: AbortSignal, permitted: () => boolean) {
  try {
    if (!permitted()) return null;
    const response = await fetch(url, { redirect: "error", signal });
    const bytes = await readVoiceResponse(response, maximumAudioBytes);
    if (!bytes || !permitted()) return null;
    const audio = await decodedVoice(bytes, signal);
    return permitted() ? audio : null;
  } catch { return null; }
}
