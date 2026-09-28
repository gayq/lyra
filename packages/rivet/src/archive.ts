import { negativeMessage } from "./messages";
import type { ChromeManifest } from "./types";

export interface ArchiveManifest {
  manifest: ChromeManifest;
  fileList: string[];
}

export type ArchiveReply =
  | ({ type: "manifest" } & ArchiveManifest)
  | { type: "files"; files: ArrayBuffer[] }
  | { type: "error" };

export class ExtensionArchive {
  private readonly worker: Worker;
  private failed = false;
  private pending: {
    resolve: (reply: ArchiveReply) => void;
    reject: (error: Error) => void;
  } | null = null;

  constructor() {
    try {
      this.worker = new Worker(
        new URL("./archive.worker.ts", import.meta.url),
        { type: "module" },
      );
    } catch {
      throw new Error(negativeMessage("extension package could not be unpacked"));
    }
    this.worker.onmessage = ({ data }: MessageEvent<ArchiveReply>) => {
      if (data.type === "error") {
        this.fail();
        return;
      }
      this.pending?.resolve(data);
      this.pending = null;
    };
    this.worker.onerror = this.worker.onmessageerror = () => this.fail();
  }

  private fail(): void {
    this.failed = true;
    this.pending?.reject(
      new Error(negativeMessage("extension package could not be unpacked")),
    );
    this.pending = null;
    this.worker.terminate();
  }

  private request(value: ArrayBuffer | string[]): Promise<ArchiveReply> {
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      if (this.failed) {
        this.fail();
        return;
      }
      try {
        this.worker.postMessage(value);
      } catch {
        this.fail();
      }
    });
  }

  async open(buffer: ArrayBuffer): Promise<ArchiveManifest> {
    const reply = await this.request(buffer);
    if (reply.type !== "manifest")
      throw new Error(negativeMessage("extension manifest is invalid"));
    return reply;
  }

  async readFiles(paths: string[]): Promise<ArrayBuffer[]> {
    const reply = await this.request(paths);
    if (reply.type !== "files")
      throw new Error(negativeMessage("extension files are unavailable"));
    return reply.files;
  }

  close(): void {
    this.worker.terminate();
  }
}
