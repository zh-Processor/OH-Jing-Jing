import { closeSync, createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Unzip, UnzipInflate } from "../dsh-runtime/node_modules/fflate/esm/index.mjs";

const marker = ".ohjingjing-managed";
const required = [
  "node_modules/@deepseek-ai/dsh-sdk-client/lib/index.js",
  "node_modules/@deepseek-ai/dsh/lib/bin.js",
];

function managed(directory) {
  const folder = lstatSync(directory, { throwIfNoEntry: false });
  return folder?.isDirectory() && lstatSync(join(directory, marker), { throwIfNoEntry: false })?.isFile();
}

async function unpack(archive, destination) {
  let descriptor;
  const unzip = new Unzip(file => {
    const parts = file.name.split("/");
    if (parts[0] !== "node_modules" || parts.length < 2 || file.size === undefined ||
        parts.some(part => !part || /[<>:"\\|?*\x00-\x1f]/u.test(part) || /[. ]$/u.test(part))) {
      throw new Error("Invalid desktop dependency entry.");
    }
    if (descriptor !== undefined) throw new Error("Overlapping desktop dependency entries.");
    const path = join(destination, ...parts);
    mkdirSync(dirname(path), { recursive: true });
    descriptor = openSync(path, "wx");
    file.ondata = (error, chunk, final) => {
      if (error) throw error;
      writeFileSync(descriptor, chunk);
      if (final) {
        closeSync(descriptor);
        descriptor = undefined;
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  try {
    for await (const chunk of createReadStream(archive)) unzip.push(chunk);
    unzip.push(new Uint8Array(), true);
    if (descriptor !== undefined) throw new Error("Incomplete desktop dependency archive.");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

async function install(root, archive) {
  const sdk = join(root, "dsh-sdk");
  const present = lstatSync(sdk, { throwIfNoEntry: false });
  if (present && !managed(sdk)) throw new Error("The desktop dependency directory is already in use.");
  const scratch = mkdtempSync(join(root, ".dsh-install-"));
  const staged = join(scratch, "payload");
  const previous = join(scratch, "previous");
  let preserveBackup = false;
  try {
    mkdirSync(staged);
    await unpack(archive, staged);
    if (!required.every(file => lstatSync(join(staged, file), { throwIfNoEntry: false })?.isFile())) {
      throw new Error("The desktop dependency archive is incomplete.");
    }
    writeFileSync(join(staged, marker), "", { flag: "wx" });
    if (present) renameSync(sdk, previous);
    try {
      renameSync(staged, sdk);
    } catch (error) {
      if (present) {
        preserveBackup = true;
        renameSync(previous, sdk);
        preserveBackup = false;
      }
      throw error;
    }
  } finally {
    if (!preserveBackup) rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
  }
}

const [operation, inputPath, outputPath] = process.argv.slice(2);
if (operation === "install" && inputPath && outputPath) {
  const root = resolve(inputPath);
  if (!existsSync(join(root, "ohjingjing.exe"))) throw new Error("Install the desktop program before its dependencies.");
  await install(root, resolve(outputPath));
} else if (operation === "uninstall" && inputPath) {
  const sdk = join(resolve(inputPath), "dsh-sdk");
  if (managed(sdk)) rmSync(sdk, { recursive: true, force: true, maxRetries: 3 });
} else {
  throw new Error("Specify install or uninstall and the required desktop package paths.");
}
