import { Buffer } from "node:buffer";
import { Bash, unsafeBytesFromLatin1 } from "just-bash";
import type { IFileSystem } from "just-bash";
import type { BashInput, BashResult, Limits, VirtualFileSystem } from "./types.js";

export class JustBashRunner {
  private readonly fsAdapter: VfsJustBashFileSystem;
  private readonly bash: Bash;

  constructor(
    private readonly fs: VirtualFileSystem,
    private readonly limits: Limits,
  ) {
    this.fsAdapter = new VfsJustBashFileSystem(fs);
    this.bash = new Bash({
      fs: this.fsAdapter,
      cwd: fs.cwd,
      python: false,
      javascript: false,
      executionLimits: {
        maxOutputSize: limits.maxOutputBytes,
        maxStringLength: limits.maxFileSizeBytes,
        maxHeredocSize: limits.maxFileSizeBytes,
      },
    });
  }

  async run(input: BashInput): Promise<BashResult> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.limits.timeoutMs);

    try {
      const result = await this.bash.exec(input.command, {
        cwd: this.fs.cwd,
        rawScript: true,
        signal: controller.signal,
      });

      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        cwd: this.fs.cwd,
        timedOut,
      };
    } catch (error) {
      return {
        stdout: "",
        stderr: `${formatError(error)}\n`,
        exitCode: 1,
        cwd: this.fs.cwd,
        timedOut,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

class VfsJustBashFileSystem implements IFileSystem {
  constructor(private readonly fs: VirtualFileSystem) {}

  async readFile(pathname: string): Promise<string> {
    return this.fs.readFile(this.normalize(pathname));
  }

  async readFileBytes(pathname: string): Promise<ReturnType<typeof unsafeBytesFromLatin1>> {
    return unsafeBytesFromLatin1(Buffer.from(this.fs.readFile(this.normalize(pathname)), "utf8").toString("latin1"));
  }

  async readFileBuffer(pathname: string): Promise<Uint8Array> {
    return Buffer.from(this.fs.readFile(this.normalize(pathname)), "utf8");
  }

  async writeFile(pathname: string, content: string | Uint8Array): Promise<void> {
    this.fs.writeFile(this.normalize(pathname), contentToString(content));
  }

  async appendFile(pathname: string, content: string | Uint8Array): Promise<void> {
    const normalized = this.normalize(pathname);
    const previous = this.fs.exists(normalized) ? this.fs.readFile(normalized) : "";
    this.fs.writeFile(normalized, previous + contentToString(content));
  }

  async exists(pathname: string): Promise<boolean> {
    return this.fs.exists(this.normalize(pathname));
  }

  async stat(pathname: string): Promise<JustBashStat> {
    return toJustBashStat(this.fs.stat(this.normalize(pathname)));
  }

  async mkdir(pathname: string, options: { recursive?: boolean } = {}): Promise<void> {
    this.fs.mkdir(this.normalize(pathname), options);
  }

  async readdir(pathname: string): Promise<string[]> {
    return this.fs.readdir(this.normalize(pathname)).map((entry) => entry.name);
  }

  async readdirWithFileTypes(pathname: string): Promise<JustBashDirent[]> {
    return this.fs.readdir(this.normalize(pathname)).map((entry) => ({
      name: entry.name,
      isFile: entry.type === "file",
      isDirectory: entry.type === "directory",
      isSymbolicLink: false,
    }));
  }

  async rm(pathname: string, options: { recursive?: boolean; force?: boolean } = {}): Promise<void> {
    this.fs.rm(this.normalize(pathname), options);
  }

  async cp(src: string, dest: string, options: { recursive?: boolean } = {}): Promise<void> {
    this.fs.copy(this.normalize(src), this.normalize(dest), options);
  }

  async mv(src: string, dest: string): Promise<void> {
    this.fs.rename(this.normalize(src), this.normalize(dest));
  }

  resolvePath(base: string, pathname: string): string {
    return this.fs.normalize(pathname, this.fs.normalize(base));
  }

  getAllPaths(): string[] {
    return this.fs.walk("/").map((entry) => entry.path);
  }

  async chmod(pathname: string, _mode: number): Promise<void> {
    this.fs.stat(this.normalize(pathname));
  }

  async symlink(_target: string, _linkPath: string): Promise<void> {
    throw new Error("Symbolic links are not supported by the code-tools VFS adapter yet");
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    this.fs.copy(this.normalize(existingPath), this.normalize(newPath));
  }

  async readlink(_pathname: string): Promise<string> {
    throw new Error("Symbolic links are not supported by the code-tools VFS adapter yet");
  }

  async lstat(pathname: string): Promise<JustBashStat> {
    return this.stat(pathname);
  }

  async realpath(pathname: string): Promise<string> {
    const normalized = this.normalize(pathname);
    this.fs.stat(normalized);
    return normalized;
  }

  async utimes(pathname: string, _atime: Date, _mtime: Date): Promise<void> {
    this.fs.stat(this.normalize(pathname));
  }

  private normalize(pathname: string): string {
    return this.fs.normalize(pathname);
  }
}

interface JustBashStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  mode: number;
  size: number;
  mtime: Date;
}

interface JustBashDirent {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

function toJustBashStat(stat: { type: "file" | "directory"; size: number }): JustBashStat {
  return {
    isFile: stat.type === "file",
    isDirectory: stat.type === "directory",
    isSymbolicLink: false,
    mode: stat.type === "directory" ? 0o755 : 0o644,
    size: stat.size,
    mtime: new Date(0),
  };
}

function contentToString(content: string | Uint8Array): string {
  return typeof content === "string" ? content : Buffer.from(content).toString("utf8");
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}
