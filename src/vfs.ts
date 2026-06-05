import { Buffer } from "node:buffer";
import path from "node:path";
import type { FsDirent, FsStat, Limits, VirtualFileSystem } from "./types.js";
import { defaultLimits } from "./types.js";

function parentOf(pathname: string): string {
  const parent = path.posix.dirname(pathname);
  return parent === "." ? "/" : parent;
}

function basename(pathname: string): string {
  return pathname === "/" ? "/" : path.posix.basename(pathname);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function isWithin(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

export class InMemoryFileSystem implements VirtualFileSystem {
  cwd: string;

  private readonly files = new Map<string, string>();
  private readonly dirs = new Set<string>(["/"]);
  private readonly limits: Limits;

  constructor(options: { cwd?: string; limits?: Partial<Limits> } = {}) {
    this.limits = { ...defaultLimits, ...options.limits };
    this.cwd = "/";
    this.mkdir(options.cwd ?? "/workspace", { recursive: true });
    this.cwd = this.normalize(options.cwd ?? "/workspace");
  }

  normalize(pathname: string, base = this.cwd): string {
    if (pathname.includes("\0")) {
      throw new Error("Path contains a NUL byte");
    }

    const raw = pathname.trim() === "" ? "." : pathname;
    const joined = raw.startsWith("/") ? raw : path.posix.join(base, raw);
    const normalized = path.posix.normalize(joined);
    if (normalized === ".") return "/";
    return normalized.startsWith("/") ? normalized : `/${normalized}`;
  }

  exists(pathname: string): boolean {
    const normalized = this.normalize(pathname);
    return this.files.has(normalized) || this.dirs.has(normalized);
  }

  stat(pathname: string): FsStat {
    const normalized = this.normalize(pathname);
    if (this.files.has(normalized)) {
      return { path: normalized, type: "file", size: byteLength(this.files.get(normalized) ?? "") };
    }
    if (this.dirs.has(normalized)) {
      return { path: normalized, type: "directory", size: 0 };
    }
    throw new Error(`No such file or directory: ${normalized}`);
  }

  readFile(pathname: string): string {
    const normalized = this.normalize(pathname);
    const value = this.files.get(normalized);
    if (value === undefined) {
      if (this.dirs.has(normalized)) throw new Error(`Is a directory: ${normalized}`);
      throw new Error(`No such file: ${normalized}`);
    }
    return value;
  }

  writeFile(pathname: string, contents: string): void {
    const normalized = this.normalize(pathname);
    if (this.dirs.has(normalized)) throw new Error(`Is a directory: ${normalized}`);
    const parent = parentOf(normalized);
    if (!this.dirs.has(parent)) throw new Error(`No such directory: ${parent}`);

    const nextSize = byteLength(contents);
    if (nextSize > this.limits.maxFileSizeBytes) {
      throw new Error(`File too large: ${normalized} (${nextSize} bytes > ${this.limits.maxFileSizeBytes})`);
    }

    const previous = this.files.get(normalized);
    const previousSize = previous === undefined ? 0 : byteLength(previous);
    const total = this.totalBytes() - previousSize + nextSize;
    if (total > this.limits.maxTotalFsBytes) {
      throw new Error(`Virtual filesystem is too large (${total} bytes > ${this.limits.maxTotalFsBytes})`);
    }

    this.files.set(normalized, contents);
  }

  mkdir(pathname: string, options: { recursive?: boolean } = {}): void {
    const normalized = this.normalize(pathname, "/");
    if (this.files.has(normalized)) throw new Error(`File exists: ${normalized}`);
    if (this.dirs.has(normalized)) return;

    const parent = parentOf(normalized);
    if (!this.dirs.has(parent)) {
      if (!options.recursive) throw new Error(`No such directory: ${parent}`);
      this.mkdir(parent, { recursive: true });
    }
    this.dirs.add(normalized);
  }

  readdir(pathname: string): FsDirent[] {
    const normalized = this.normalize(pathname);
    if (!this.dirs.has(normalized)) {
      if (this.files.has(normalized)) throw new Error(`Not a directory: ${normalized}`);
      throw new Error(`No such directory: ${normalized}`);
    }

    const children = new Map<string, FsDirent>();
    for (const dir of this.dirs) {
      if (dir === normalized) continue;
      if (parentOf(dir) === normalized) {
        children.set(basename(dir), { name: basename(dir), path: dir, type: "directory", size: 0 });
      }
    }
    for (const [file, contents] of this.files) {
      if (parentOf(file) === normalized) {
        children.set(basename(file), {
          name: basename(file),
          path: file,
          type: "file",
          size: byteLength(contents),
        });
      }
    }

    return [...children.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  rm(pathname: string, options: { recursive?: boolean; force?: boolean } = {}): void {
    const normalized = this.normalize(pathname);
    if (normalized === "/") throw new Error("Refusing to remove /");

    if (this.files.delete(normalized)) return;

    if (!this.dirs.has(normalized)) {
      if (options.force) return;
      throw new Error(`No such file or directory: ${normalized}`);
    }

    const descendants = [...this.dirs, ...this.files.keys()].filter((entry) => entry !== normalized && isWithin(entry, normalized));
    if (descendants.length > 0 && !options.recursive) {
      throw new Error(`Directory not empty: ${normalized}`);
    }

    for (const file of [...this.files.keys()]) {
      if (isWithin(file, normalized)) this.files.delete(file);
    }
    for (const dir of [...this.dirs].sort((a, b) => b.length - a.length)) {
      if (dir !== "/" && isWithin(dir, normalized)) this.dirs.delete(dir);
    }
  }

  rename(from: string, to: string): void {
    const normalizedFrom = this.normalize(from);
    const normalizedTo = this.normalize(to);
    if (normalizedFrom === "/") throw new Error("Refusing to move /");
    if (!this.exists(normalizedFrom)) throw new Error(`No such file or directory: ${normalizedFrom}`);
    if (isWithin(normalizedTo, normalizedFrom)) throw new Error("Cannot move a directory into itself");

    this.copy(normalizedFrom, normalizedTo, { recursive: true });
    this.rm(normalizedFrom, { recursive: true });
  }

  copy(from: string, to: string, options: { recursive?: boolean } = {}): void {
    const normalizedFrom = this.normalize(from);
    const normalizedTo = this.normalize(to);
    const fromStat = this.stat(normalizedFrom);

    if (fromStat.type === "file") {
      const target = this.dirs.has(normalizedTo) ? path.posix.join(normalizedTo, basename(normalizedFrom)) : normalizedTo;
      this.writeFile(target, this.readFile(normalizedFrom));
      return;
    }

    if (!options.recursive) throw new Error(`Omitting directory: ${normalizedFrom}`);
    const targetRoot = this.dirs.has(normalizedTo) ? path.posix.join(normalizedTo, basename(normalizedFrom)) : normalizedTo;
    this.mkdir(targetRoot, { recursive: true });

    for (const dir of [...this.dirs].sort()) {
      if (dir !== normalizedFrom && isWithin(dir, normalizedFrom)) {
        this.mkdir(path.posix.join(targetRoot, path.posix.relative(normalizedFrom, dir)), { recursive: true });
      }
    }
    for (const [file, contents] of [...this.files]) {
      if (isWithin(file, normalizedFrom)) {
        this.writeFile(path.posix.join(targetRoot, path.posix.relative(normalizedFrom, file)), contents);
      }
    }
  }

  walk(pathname: string): FsDirent[] {
    const root = this.normalize(pathname);
    const rootStat = this.stat(root);
    const entries: FsDirent[] = [{ ...rootStat, name: basename(root) }];
    if (rootStat.type === "file") return entries;

    for (const dir of [...this.dirs].sort()) {
      if (dir !== root && isWithin(dir, root)) {
        entries.push({ name: basename(dir), path: dir, type: "directory", size: 0 });
      }
    }
    for (const [file, contents] of [...this.files].sort(([a], [b]) => a.localeCompare(b))) {
      if (isWithin(file, root)) {
        entries.push({ name: basename(file), path: file, type: "file", size: byteLength(contents) });
      }
    }
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  }

  private totalBytes(): number {
    let total = 0;
    for (const contents of this.files.values()) total += byteLength(contents);
    return total;
  }
}
