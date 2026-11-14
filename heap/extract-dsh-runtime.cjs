// Extract app.asar's /dsh subtree into a real directory.
//
// The patched host launches a bundled node.exe instead of Electron's
// process.execPath, and that node cannot read asar virtual files, so the
// runtime must exist as plain files. The launcher expects it at
// <resources>/<runtime-name> (default: resources/dsh-runtime).
//
//   node extract-dsh-runtime.cjs [--asar PATH] [--out PATH] [--force]
//
// Verifies each file's sha256 when the asar header carries one. Windows only.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const ASAR = path.resolve(argOf('--asar', 'D:/DeepSeek Harness/resources/app.asar'));
const UNPACKED = `${ASAR}.unpacked`;
const DEFAULT_OUT = path.join(path.dirname(ASAR), 'dsh-runtime');
const OUT = path.resolve(argOf('--out', DEFAULT_OUT));
const force = args.includes('--force');

if (!fs.existsSync(ASAR)) {
  console.error(`asar not found: ${ASAR}`);
  process.exit(1);
}
if (fs.existsSync(OUT) && !force) {
  console.error(`output already exists: ${OUT}\npass --force to replace it`);
  process.exit(1);
}

const fd = fs.openSync(ASAR, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const jsonSize = head.readUInt32LE(8);
const dataStart = 8 + head.readUInt32LE(4);
const buf = Buffer.alloc(jsonSize);
fs.readSync(fd, buf, 0, jsonSize, 16);
const text = buf.toString('utf8').replace(/\0+$/g, '').trimEnd();
let tree;
try {
  tree = JSON.parse(text);
} catch {
  tree = JSON.parse(text.slice(0, text.lastIndexOf('}') + 1));
}

if (!tree.files || !tree.files.dsh) {
  console.error('app.asar has no /dsh subtree (unexpected layout)');
  process.exit(1);
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

let files = 0;
let dirs = 0;
let bytes = 0;
let unpacked = 0;
let skipped = 0;
let hashOk = 0;
let hashBad = 0;
let noHash = 0;
const started = Date.now();

function walk(node, rel) {
  for (const [name, e] of Object.entries(node.files || {})) {
    const childRel = rel === '' ? name : `${rel}/${name}`;
    const dest = path.join(OUT, childRel);
    if (e.files) {
      dirs++;
      fs.mkdirSync(dest, { recursive: true });
      walk(e, childRel);
      continue;
    }
    if (e.link !== undefined) {
      skipped++;
      continue;
    }
    let data;
    if (e.unpacked) {
      unpacked++;
      data = fs.readFileSync(path.join(UNPACKED, 'dsh', childRel));
    } else {
      data = Buffer.alloc(e.size || 0);
      if (data.length) {
        let read = 0;
        while (read < data.length) {
          const n = fs.readSync(fd, data, read, data.length - read, dataStart + Number(e.offset) + read);
          if (n <= 0) throw new Error(`short read ${childRel}`);
          read += n;
        }
      }
    }
    const integrity = e.integrity && e.integrity.hash;
    if (integrity) {
      const h = crypto.createHash('sha256').update(data).digest('hex');
      if (h === integrity) hashOk++;
      else hashBad++;
    } else noHash++;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
    files++;
    bytes += data.length;
    if (files % 2000 === 0) console.log('...', files, 'files', (bytes / 1048576).toFixed(1), 'MB');
  }
}

walk(tree.files.dsh, '');
fs.closeSync(fd);
console.log(JSON.stringify({
  out: OUT,
  files,
  dirs,
  unpacked,
  skipped,
  bytes,
  mb: +(bytes / 1048576).toFixed(1),
  hashOk,
  hashBad,
  noHash,
  seconds: +((Date.now() - started) / 1000).toFixed(1),
}, null, 2));
if (hashBad > 0) {
  console.error(`integrity mismatch in ${hashBad} file(s)`);
  process.exitCode = 1;
}
