import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`${path}: ${(error as Error).message}`);
  }
}

// written beside the target and renamed over it, so a crash mid-write never leaves half a file
export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value));
  await rename(tmp, path);
}

// coalesces writes: a save asked while one runs is made once after it, with the newest value
export class Saver {
  private running?: Promise<void>;
  private again = false;
  private readonly path: string;
  private readonly value: () => unknown;
  private readonly onError: (error: Error) => void;

  constructor(path: string, value: () => unknown, onError: (error: Error) => void) {
    this.path = path;
    this.value = value;
    this.onError = onError;
  }

  save(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = writeJson(this.path, this.value())
      .catch((e: Error) => this.onError(e))
      .finally(() => {
        this.running = undefined;
        if (this.again) {
          this.again = false;
          this.save();
        }
      });
  }

  async flush(): Promise<void> {
    while (this.running) await this.running;
  }
}
