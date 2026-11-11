// Reading and writing a world folder from the host. The capture unit can write anything there (symlinks, FIFOs, huge files, escape sequences), so host tools treat it as hostile.
import { closeSync, constants, fstatSync, openSync, readSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

// A regular file's text (a Buffer with enc null), or null: no symlink is followed, a FIFO or device does not block, and a file over `max` bytes is refused.
// head or tail: read only the first or last that many bytes.
export function readHostile(f, max, { head = 0, tail = 0, enc = "utf8" } = {}) {
  let fd;
  try {
    fd = openSync(f, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max) return null;
    const len = Math.min(st.size, head || tail || st.size), b = Buffer.alloc(len);
    const n = readSync(fd, b, 0, len, head ? 0 : st.size - len);
    return enc ? b.subarray(0, n).toString(enc) : b.subarray(0, n);
  } catch { return null; } finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
}
// Text from a world folder made safe to print or embed: no control characters (newlines, escape sequences), at most n characters.
export const clean = (s, n = 80) => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, n);
export const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
// Writes `data` to a fresh temporary name (fails rather than follow a planted link there) and renames it over `out` (which replaces a link at `out` instead of writing through it).
export function writeFresh(out, data) {
  const tmp = `${out}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, data, { flag: "wx", mode: 0o644 });
  renameSync(tmp, out);
}
