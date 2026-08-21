#!/usr/bin/env node
/**
 * Copies the tesseract.js worker and its wasm cores into public/tesseract/.
 *
 * tesseract.js defaults both `workerPath` and `corePath` to cdn.jsdelivr.net.
 * Bundling only the language data (public/tessdata) is not enough: without
 * these files OCR needs the network on every cold start, which breaks the
 * offline promise and leaks usage to a third party on every capture.
 *
 * Only the LSTM cores are copied. createWorker() is called with the default
 * OEM (LSTM_ONLY), so the legacy cores would never be selected.
 */
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "public", "tesseract");

const files = [
  [join(root, "node_modules", "tesseract.js", "dist", "worker.min.js"), "worker.min.js"],
  // worker.min.js opens with "For license information please see
  // worker.min.js.LICENSE.txt", so the sidecar has to travel with it or the
  // shipped bundle points at a file that is not there.
  [
    join(root, "node_modules", "tesseract.js", "dist", "worker.min.js.LICENSE.txt"),
    "worker.min.js.LICENSE.txt",
  ],
  ...[
    "tesseract-core-relaxedsimd-lstm.wasm.js",
    "tesseract-core-simd-lstm.wasm.js",
    "tesseract-core-lstm.wasm.js",
  ].map((name) => [join(root, "node_modules", "tesseract.js-core", name), name]),
];

mkdirSync(outDir, { recursive: true });

let copied = 0;
for (const [from, name] of files) {
  if (!existsSync(from)) {
    console.error(`missing: ${from}`);
    process.exit(1);
  }

  copyFileSync(from, join(outDir, name));
  copied += 1;
}

console.log(`vendored ${copied} tesseract files into public/tesseract/`);
