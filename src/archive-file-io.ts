import type { FileHandle } from "node:fs/promises";
import type { ExtractionDeadline } from "./archive-deadline.js";

export async function writeFileHandleFully(params: {
  handle: FileHandle;
  buffer: Buffer;
  bytes: number;
  deadline: ExtractionDeadline;
}): Promise<void> {
  let offset = 0;
  while (offset < params.bytes) {
    params.deadline.check();
    const { bytesWritten } = await params.handle.write(
      params.buffer,
      offset,
      params.bytes - offset,
    );
    if (bytesWritten <= 0) {
      throw new Error("archive staging write made no progress");
    }
    offset += bytesWritten;
  }
}
