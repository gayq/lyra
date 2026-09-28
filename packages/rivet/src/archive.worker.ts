import JSZip from "jszip";
import { crxToZip } from "./crx";
import type { ArchiveReply } from "./archive";

let zip: JSZip;

self.onmessage = async ({ data }: MessageEvent<ArrayBuffer | string[]>) => {
  try {
    if (data instanceof ArrayBuffer) {
      zip = await JSZip.loadAsync(crxToZip(data));
      const manifestFile = zip.file("manifest.json");
      if (!manifestFile) {
        self.postMessage({ type: "error" } satisfies ArchiveReply);
        return;
      }
      const manifest = JSON.parse(await manifestFile.async("text"));
      if (!manifest || typeof manifest.name !== "string") {
        self.postMessage({ type: "error" } satisfies ArchiveReply);
        return;
      }
      const fileList: string[] = [];
      zip.forEach((path, file) => {
        if (!file.dir) fileList.push(path);
      });
      self.postMessage({
        type: "manifest", manifest, fileList,
      } satisfies ArchiveReply);
    } else {
      const files = await Promise.all(
        data.map((path) => zip.file(path)!.async("arraybuffer")),
      );
      self.postMessage({ type: "files", files } satisfies ArchiveReply, {
        transfer: files,
      });
    }
  } catch {
    self.postMessage({ type: "error" } satisfies ArchiveReply);
  }
};
