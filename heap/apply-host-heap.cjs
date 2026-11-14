// DSH desktop host heap patch (Windows).
//
// Raises the Node host's V8 old-space ceiling by editing /lib/main.js inside
// app.asar in place. The edit is byte-for-byte: the file keeps its exact size
// (the length delta is trimmed from an inert JSDoc comment), so every other
// member's offset in the asar header stays valid, and the header's sha256
// (hash + blocks[0]) is rewritten to match.
//
//   node apply-host-heap.cjs [--asar PATH] [--heap-mb 16384]
//                             [--runtime-name dsh-runtime|dsh-node] [--dry-run]
//
// Idempotent: an already-patched main.js is detected and skipped.
// Windows only; needs write access to the install directory.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const ASAR = path.resolve(argOf('--asar', 'D:/DeepSeek Harness/resources/app.asar'));
const HEAP_MB = Number(argOf('--heap-mb', 16384));
const RUNTIME_NAME = argOf('--runtime-name', 'dsh-runtime');

if (!Number.isSafeInteger(HEAP_MB) || HEAP_MB < 1024) {
  console.error(`invalid --heap-mb ${String(argOf('--heap-mb', ''))} (expected an integer >= 1024)`);
  process.exit(1);
}

function log(message) {
  console.log(`${new Date().toISOString()} ${message}`);
}
function die(message) {
  console.error(`ABORT: ${message}`);
  process.exit(1);
}

function readAsar() {
  const fd = fs.openSync(ASAR, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const jsonSize = head.readUInt32LE(8);
  const dataStart = 8 + head.readUInt32LE(4);
  const raw = Buffer.alloc(jsonSize);
  fs.readSync(fd, raw, 0, jsonSize, 16);
  const text = raw.toString('utf8').replace(/\0+$/g, '').trimEnd();
  let tree;
  try {
    tree = JSON.parse(text);
  } catch {
    tree = JSON.parse(text.slice(0, text.lastIndexOf('}') + 1));
  }
  return { fd, dataStart, tree };
}

function findEntry(tree, wanted) {
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files || {})) {
      const full = `${prefix}/${name}`;
      if (entry.files) {
        const hit = walk(entry, full);
        if (hit) return hit;
      } else if (full === wanted) return entry;
    }
    return null;
  };
  return walk(tree, '');
}

// The three edits the host launcher needs. `from` anchors are the literal
// fragments shipped in DSH 0.2.2's /lib/main.js; drift aborts before writing.
const EDITS = [
  {
    name: 'host node',
    from: '\t\tnode: process.execPath,',
    to: '\t\tnode: join(process.resourcesPath, "runtime", "primary-runtime", "dependencies", "node", "bin", "node.exe"),',
  },
  {
    name: 'heap flag',
    from: '\t\t\t"--expose-internals",',
    to: `\t\t\t"--max-old-space-size=${HEAP_MB}",\n\t\t\t"--expose-internals",`,
  },
  {
    name: 'runtime dir',
    from: 'join(app.getAppPath(), "dsh")',
    to: `join(process.resourcesPath, "${RUNTIME_NAME}")`,
  },
];

const PATCHED_MARK = `--max-old-space-size=${HEAP_MB}`;
const RUNTIME_DIR_MARKS = ['resources/dsh-runtime', '"dsh-runtime"', 'resources/dsh-node', '"dsh-node"'];

function asarIsPatched(text) {
  return text.includes(PATCHED_MARK) && RUNTIME_DIR_MARKS.some((mark) => text.includes(mark));
}

function patchMainJs(original) {
  let src = original;
  for (const edit of EDITS) {
    const count = src.split(edit.from).length - 1;
    if (count !== 1) die(`anchor "${edit.name}" found ${count} times (app layout changed)`);
    src = src.replace(edit.from, edit.to);
  }
  const byteDelta = Buffer.byteLength(src, 'utf8') - Buffer.byteLength(original, 'utf8');
  if (byteDelta <= 0) die(`unexpected byte delta ${byteDelta}`);

  // Keep the file length identical: trim `byteDelta` ASCII bytes from a JSDoc
  // comment body (comments are inert; archive offsets stay valid).
  const re = /\/\*\*([\s\S]*?)\*\//g;
  let match;
  let chosen = null;
  while ((match = re.exec(src)) !== null) {
    const body = match[1];
    if (/^[\x00-\x7F]*$/.test(body) && Buffer.byteLength(body, 'utf8') >= byteDelta + 24) {
      chosen = { start: match.index + 3, length: body.length };
      break;
    }
  }
  if (!chosen) die('no ASCII comment large enough to absorb the length delta');
  src = src.slice(0, chosen.start + chosen.length - byteDelta) + src.slice(chosen.start + chosen.length);
  if (Buffer.byteLength(src, 'utf8') !== Buffer.byteLength(original, 'utf8')) die('length mismatch after trim');
  if (!asarIsPatched(src)) die('patched source missing markers');
  return src;
}

function checkEsm(source, label) {
  const tmp = path.join(os.tmpdir(), `dsh-heap-${process.pid}-${label}.mjs`);
  fs.writeFileSync(tmp, source, 'utf8');
  const result = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
  fs.unlinkSync(tmp);
  if (result.status !== 0) die(`${label} does not parse: ${(result.stderr || result.stdout || '').trim()}`);
}

function applyAsarPatch() {
  if (!fs.existsSync(ASAR)) die(`asar not found: ${ASAR}`);
  log(`asar: ${ASAR}`);
  const { fd, dataStart, tree } = readAsar();
  try {
    const entry = findEntry(tree, '/lib/main.js');
    if (!entry) die('app.asar has no /lib/main.js');
    const size = entry.size;
    const offset = dataStart + Number(entry.offset);
    const current = Buffer.alloc(size);
    fs.readSync(fd, current, 0, size, offset);
    const currentHash = crypto.createHash('sha256').update(current).digest('hex');
    const text = current.toString('utf8');

    if (asarIsPatched(text)) {
      log('asar: already patched, skipping');
      return false;
    }

    log(`asar: patching /lib/main.js (byte-equal, heap ${HEAP_MB} MB)`);
    const patchedText = patchMainJs(text);
    checkEsm(patchedText, 'main');
    const patchedBytes = Buffer.from(patchedText, 'utf8');
    if (patchedBytes.length !== size) die('patched main.js size changed');

    const newHash = crypto.createHash('sha256').update(patchedBytes).digest('hex');
    if (dryRun) {
      log(`asar: DRY RUN would write ${size} bytes at ${offset}, hash ${currentHash} -> ${newHash}`);
      return true;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backup = `${ASAR}.bak-${stamp}`;
    fs.closeSync(fd);
    fs.copyFileSync(ASAR, backup);
    log(`asar: backup ${backup}`);

    const fd2 = fs.openSync(ASAR, 'r+');
    try {
      fs.writeSync(fd2, patchedBytes, 0, patchedBytes.length, offset);
      // The header carries the file hash twice (hash + blocks[0]); replace both
      // in place (same length) so asar integrity, if enabled later, still holds.
      const headerLen = dataStart;
      const header = Buffer.alloc(headerLen);
      fs.readSync(fd2, header, 0, headerLen, 0);
      const headerText = header.toString('latin1');
      let count = 0;
      let index = 0;
      while ((index = headerText.indexOf(currentHash, index)) >= 0) {
        fs.writeSync(fd2, Buffer.from(newHash, 'latin1'), 0, 64, index);
        count += 1;
        index += 64;
      }
      if (count < 1) die('current main.js hash not present in the asar header');
      log(`asar: header hash replaced ${count}x`);
    } finally {
      fs.closeSync(fd2);
    }

    const verifyFd = fs.openSync(ASAR, 'r');
    try {
      const verify = Buffer.alloc(size);
      fs.readSync(verifyFd, verify, 0, size, offset);
      const verifyHash = crypto.createHash('sha256').update(verify).digest('hex');
      if (verifyHash !== newHash) die('verify failed after write');
    } finally {
      fs.closeSync(verifyFd);
    }
    log('asar: verified');
    return true;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {}
  }
}

applyAsarPatch();
log(dryRun ? 'dry run complete' : 'done (restart DSH)');
