import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { UploadError } from "./errors";
import type { FileModel } from "./file.model";
import type { PartModel } from "./part.model";
import { UploaderModel } from "./uploader.model";
import type { UploaderConfig, UploadPart, UploadPartFn, UploadValue } from "./uploader.types";
import {
  getFileExtension,
  isRetryableStatus,
  MAX_RETRY_AFTER_MS,
  parseRetryAfter,
  retryDelayMs,
} from "./uploader.util";

const MiB = 1024 * 1024;

const makeFile = (name: string, size: number, type = "text/plain"): File =>
  new File([new Uint8Array(size)], name, { type });

/** Exact part sizes summing to `size`, the way a real backend supplies them. */
const partsFor = (size: number, partSize: number): UploadPart[] => {
  const parts: UploadPart[] = [];
  for (let offset = 0; offset < size; offset += partSize) {
    parts.push({
      url: `https://example.test/part-${parts.length}`,
      size: Math.min(partSize, size - offset),
    });
  }
  return parts;
};

interface TransportCall {
  part: PartModel;
  resolve: () => void;
  reject: (error: unknown) => void;
  onProgress: (loaded: number) => void;
  aborted: boolean;
}

/**
 * A transport whose every attempt is settled by the test. This is the seam that makes the scheduler,
 * the retry policy and cancellation testable with no XHR and no DOM.
 */
const makeTransport = (): { calls: TransportCall[]; uploadPart: UploadPartFn } => {
  const calls: TransportCall[] = [];
  const uploadPart: UploadPartFn = (signal, part, onProgress) =>
    new Promise<void>((resolve, reject) => {
      const call: TransportCall = { part, resolve, reject, onProgress, aborted: false };
      calls.push(call);
      signal.addEventListener(
        "abort",
        () => {
          call.aborted = true;
          reject(new UploadError("ABORTED", { fileName: part.file.name }));
        },
        { once: true },
      );
    });
  return { calls, uploadPart };
};

interface Harness {
  uploader: UploaderModel;
  calls: TransportCall[];
  requested: string[];
}

const makeUploader = (config: Partial<UploaderConfig> = {}, partSize = 64): Harness => {
  const { calls, uploadPart } = makeTransport();
  const requested: string[] = [];

  const uploader = new UploaderModel({
    uploadPart,
    requestUpload: (_signal, file) => {
      requested.push(file.name);
      return Promise.resolve({
        id: `id-${file.name}`,
        name: file.name,
        parts: partsFor(file.size, partSize),
      });
    },
    ...config,
  });
  uploader.activate();

  return { uploader, calls, requested };
};

/** Let every pending microtask and `setTimeout(0)` continuation run. */
const flush = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

const statuses = (uploader: UploaderModel): string[] =>
  uploader.uploads.map((upload) => upload.status);

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// util
// ---------------------------------------------------------------------------

describe("getFileExtension", () => {
  test("lowercases the extension", () => {
    expect(getFileExtension("Report.PDF")).toBe("pdf");
  });

  test("uses the last dot", () => {
    expect(getFileExtension("archive.tar.gz")).toBe("gz");
  });

  test("no extension yields an empty string", () => {
    expect(getFileExtension("README")).toBe("");
    expect(getFileExtension("trailing.")).toBe("");
    expect(getFileExtension(".hidden")).toBe("");
  });

  test("does not normalize jpeg to jpg — it reports what the name says", () => {
    expect(getFileExtension("photo.jpeg")).toBe("jpeg");
  });
});

describe("isRetryableStatus", () => {
  test("no response, 408, 429 and 5xx retry", () => {
    for (const status of [0, 408, 429, 500, 502, 503, 504]) {
      expect(isRetryableStatus(status)).toBe(true);
    }
  });

  test("403 is fatal — an expired presign fails identically forever", () => {
    expect(isRetryableStatus(403)).toBe(false);
  });

  test("other 4xx and 501 are fatal", () => {
    for (const status of [400, 401, 404, 412, 501]) {
      expect(isRetryableStatus(status)).toBe(false);
    }
  });
});

describe("retryDelayMs", () => {
  test("equal jitter keeps every delay in the upper half of the window", () => {
    for (const attempt of [1, 2, 3]) {
      const window = 500 * 2 ** (attempt - 1);
      for (let i = 0; i < 25; i++) {
        const delay = retryDelayMs(attempt);
        expect(delay).toBeGreaterThanOrEqual(window / 2);
        expect(delay).toBeLessThanOrEqual(window);
      }
    }
  });

  test("honors the cap", () => {
    expect(retryDelayMs(20, { capMs: 1000 })).toBeLessThanOrEqual(1000);
  });

  test("Retry-After wins, clamped", () => {
    expect(retryDelayMs(1, { retryAfterMs: 2000 })).toBe(2000);
    expect(retryDelayMs(1, { retryAfterMs: 10 * MAX_RETRY_AFTER_MS })).toBe(MAX_RETRY_AFTER_MS);
  });
});

describe("parseRetryAfter", () => {
  test("delta-seconds", () => {
    expect(parseRetryAfter("3")).toBe(3000);
  });

  test("an HTTP-date", () => {
    const future = new Date(Date.now() + 5000).toUTCString();
    const parsed = parseRetryAfter(future) ?? 0;
    expect(parsed).toBeGreaterThan(3000);
    expect(parsed).toBeLessThanOrEqual(6000);
  });

  test("absent or unparseable", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("  ")).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// part slicing — the silent large-file breakage
// ---------------------------------------------------------------------------

describe("part slicing", () => {
  test("slices at the server's exact sizes with contiguous offsets", async () => {
    const { uploader, calls } = makeUploader({
      concurrency: 10,
      requestUpload: (_signal, file) =>
        Promise.resolve({
          id: "upload-1",
          name: file.name,
          parts: [
            { url: "https://example.test/a", size: 64 * MiB },
            { url: "https://example.test/b", size: 36 * MiB },
          ],
        }),
    });

    uploader.addFiles([makeFile("big.bin", 100 * MiB)]);
    await flush();

    const [file] = uploader.files;
    expect(file?.parts.map((part) => part.size)).toEqual([64 * MiB, 36 * MiB]);
    // every part reached the transport, so the offsets covered the whole file exactly once
    expect(calls).toHaveLength(2);
    expect(calls.reduce((sum, call) => sum + call.part.size, 0)).toBe(100 * MiB);
  });

  test("uneven sizes stay contiguous byte-for-byte", async () => {
    // distinguishable content, so a wrong offset shows up as wrong bytes rather than a wrong length
    const bytes = new Uint8Array(100);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i;

    const { uploader } = makeUploader({
      concurrency: 10,
      requestUpload: (_signal, file) =>
        Promise.resolve({
          id: "upload-1",
          name: file.name,
          parts: [
            { url: "https://example.test/a", size: 7 },
            { url: "https://example.test/b", size: 64 },
            { url: "https://example.test/c", size: 29 },
          ],
        }),
    });

    uploader.addFiles([new File([bytes], "uneven.bin")]);
    await flush();

    const parts = uploader.files[0]?.parts ?? [];
    expect(parts.map((part) => part.size)).toEqual([7, 64, 29]);

    const seen = new Uint8Array(100);
    let offset = 0;
    for (const part of parts) {
      const buffer = new Uint8Array(await part.blob.arrayBuffer());
      seen.set(buffer, offset);
      offset += buffer.length;
    }
    expect(offset).toBe(100);
    expect([...seen]).toEqual([...bytes]);
  });

  test("a zero-byte file completes with no parts and no network", async () => {
    const { uploader, calls } = makeUploader();

    uploader.addFiles([makeFile("empty.txt", 0)]);
    await flush();

    expect(calls).toHaveLength(0);
    expect(uploader.files[0]?.parts).toHaveLength(0);
    expect(uploader.files[0]?.status).toBe("COMPLETED");
  });

  test("sizes that do not sum to the file size fail loudly and build no parts", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const onError = vi.fn();
    const { uploader, calls } = makeUploader({
      onError,
      // an even split, which is exactly what the reference implementation derived
      requestUpload: (_signal, file) =>
        Promise.resolve({
          id: "upload-1",
          name: file.name,
          parts: [
            { url: "https://example.test/a", size: 50 },
            { url: "https://example.test/b", size: 50 },
          ],
        }),
    });

    uploader.addFiles([makeFile("mismatch.bin", 120)]);
    await flush();

    const file = uploader.files[0];
    expect(file?.status).toBe("FAILED");
    expect(file?.parts).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(file?.error?.type).toBe("PART_SIZES");
    expect(file?.error?.dev).toBe(true);
    // a broken integration contract is logged unconditionally, not just surfaced
    expect(error).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test("a non-positive or fractional part size is rejected too", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { uploader } = makeUploader({
      requestUpload: (_signal, file) =>
        Promise.resolve({
          id: "upload-1",
          name: file.name,
          parts: [
            { url: "https://example.test/a", size: 60.5 },
            { url: "https://example.test/b", size: 39.5 },
          ],
        }),
    });

    uploader.addFiles([makeFile("fractional.bin", 100)]);
    await flush();

    expect(uploader.files[0]?.error?.type).toBe("PART_SIZES");
  });
});

// ---------------------------------------------------------------------------
// scheduler
// ---------------------------------------------------------------------------

describe("scheduler", () => {
  test("nothing starts before activate()", async () => {
    const { calls, uploadPart } = makeTransport();
    const uploader = new UploaderModel({
      uploadPart,
      requestUpload: (_signal, file) =>
        Promise.resolve({ id: "x", name: file.name, parts: partsFor(file.size, 64) }),
    });

    uploader.addFiles([makeFile("a.txt", 10)]);
    await flush();

    expect(uploader.files[0]?.status).toBe("PENDING");
    expect(calls).toHaveLength(0);

    uploader.activate();
    await flush();
    expect(calls).toHaveLength(1);
  });

  test("concurrency bounds parts in flight across files", async () => {
    const { uploader, calls } = makeUploader({ concurrency: 4, multiple: true });

    uploader.addFiles(Array.from({ length: 6 }, (_, i) => makeFile(`f${i}.txt`, 10)));
    await flush();

    expect(uploader.activeParts).toHaveLength(4);
    expect(calls).toHaveLength(4);
    expect(statuses(uploader).filter((s) => s === "PENDING")).toHaveLength(2);
  });

  test("signing is throttled too — a hundred files do not all sign on the first tick", () => {
    const { uploader, requested } = makeUploader({ concurrency: 4, multiple: true });

    uploader.addFiles(Array.from({ length: 100 }, (_, i) => makeFile(`f${i}.txt`, 10)));

    // synchronous assertion: pump() needs no reaction flush at all
    expect(requested).toHaveLength(4);
    expect(uploader.requestingFiles).toHaveLength(4);
  });

  test("a full part pipeline stops further signing", async () => {
    const { uploader, requested } = makeUploader({ concurrency: 4, multiple: true }, 10);

    uploader.addFiles([makeFile("big.bin", 100)]);
    await flush();

    // one file already yields more queued work than the pipeline can use
    expect(requested).toEqual(["big.bin"]);
    expect(uploader.activeParts.length + uploader.queuedParts.length).toBe(10);

    uploader.addFiles([makeFile("next.bin", 100)]);
    await flush();

    expect(requested).toEqual(["big.bin"]);
    expect(uploader.files[1]?.status).toBe("PENDING");
    expect(uploader.activeParts).toHaveLength(4);
  });

  test("before any parts exist, signing looks ahead up to concurrency files", () => {
    const { uploader, requested } = makeUploader({ concurrency: 4, multiple: true }, 10);

    // none of these has produced a part yet, so the pipeline depth is unknowable and the scheduler
    // pipelines up to `concurrency` requests — the `requestingFiles` term is what bounds it
    uploader.addFiles(Array.from({ length: 10 }, (_, i) => makeFile(`f${i}.bin`, 100)));

    expect(requested).toHaveLength(4);
  });

  test("parts drain file-by-file rather than interleaving", async () => {
    const { uploader, calls } = makeUploader({ concurrency: 2, multiple: true }, 10);

    uploader.addFiles([makeFile("a.bin", 40), makeFile("b.bin", 40)]);
    await flush();

    // both parts in flight belong to the first file
    expect(calls.map((call) => call.part.file.name)).toEqual(["a.bin", "a.bin"]);
    expect(calls.map((call) => call.part.index)).toEqual([0, 1]);
  });

  test("maxPendingUploads is a hard cap, not an approximation", async () => {
    const { uploader, requested } = makeUploader({
      concurrency: 8,
      multiple: true,
      maxPendingUploads: 2,
      completeUpload: () => new Promise<void>(() => {}),
    });

    uploader.addFiles(Array.from({ length: 6 }, (_, i) => makeFile(`f${i}.txt`, 10)));
    await flush();

    expect(requested).toHaveLength(2);
    expect(uploader.pendingUploads).toHaveLength(2);

    // still capped after the requests resolve, while the uploads remain unfinished
    await flush();
    expect(requested).toHaveLength(2);
  });

  test("a freed slot is refilled", async () => {
    const { uploader, calls } = makeUploader({ concurrency: 2 }, 10);

    uploader.addFiles([makeFile("a.bin", 50)]);
    await flush();
    expect(calls).toHaveLength(2);

    calls[0]?.resolve();
    await flush();

    expect(calls).toHaveLength(3);
    expect(uploader.activeParts).toHaveLength(2);
  });

  test("a whole multi-part file completes and reports 100%", async () => {
    const { uploader, calls } = makeUploader({ concurrency: 2 }, 10);

    uploader.addFiles([makeFile("a.bin", 35)]);
    await flush();

    for (let guard = 0; guard < 20 && uploader.uploading; guard++) {
      // resolving is async, so no new call is appended before the await below
      for (const call of calls) call.resolve();
      await flush();
    }

    const file = uploader.files[0];
    expect(file?.parts.map((part) => part.size)).toEqual([10, 10, 10, 5]);
    expect(file?.status).toBe("COMPLETED");
    expect(file?.progress).toBe(100);
    expect(uploader.progress).toBe(100);
    expect(uploader.uploading).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cancellation — the reference deadlocked here
// ---------------------------------------------------------------------------

describe("cancellation", () => {
  test("removing a file with a part in flight frees its slot", async () => {
    const { uploader, calls } = makeUploader({ concurrency: 1, multiple: true }, 10);

    uploader.addFiles([makeFile("a.bin", 10), makeFile("b.bin", 10)]);
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.part.file.name).toBe("a.bin");

    uploader.files[0]?.remove();
    await flush();

    // in the reference the aborted part stayed UPLOADING and held the only slot forever
    expect(calls).toHaveLength(2);
    expect(calls[1]?.part.file.name).toBe("b.bin");
    expect(uploader.activeParts).toHaveLength(1);
  });

  test("an aborted attempt settles rather than hanging, and the part stays resumable", async () => {
    const { uploader, calls } = makeUploader({ concurrency: 1 }, 10);

    uploader.addFiles([makeFile("a.bin", 20)]);
    await flush();
    const part = calls[0]?.part;
    expect(part?.status).toBe("UPLOADING");

    uploader.dispose();
    await flush();

    expect(calls[0]?.aborted).toBe(true);
    expect(part?.status).toBe("QUEUED");
    expect(part?.loaded).toBe(0);

    uploader.activate();
    await flush();

    expect(calls).toHaveLength(2);
    expect(part?.status).toBe("UPLOADING");
  });

  test("dispose parks the uploads instead of destroying them", async () => {
    const { uploader } = makeUploader({ concurrency: 2 }, 10);

    uploader.addFiles([makeFile("a.bin", 20)]);
    await flush();

    uploader.dispose();
    expect(uploader.uploads).toHaveLength(1);
    expect(uploader.files[0]?.status).toBe("UPLOADING");
  });

  test("a file aborted while signing never builds parts", async () => {
    let release: (() => void) | undefined;
    const { uploader, calls } = makeUploader({
      requestUpload: (_signal, file) =>
        new Promise((resolve) => {
          release = () => resolve({ id: "x", name: file.name, parts: partsFor(file.size, 10) });
        }),
    });

    uploader.addFiles([makeFile("a.bin", 20)]);
    const file = uploader.files[0] as FileModel;
    expect(file.status).toBe("REQUESTING");

    file.remove();
    release?.();
    await flush();

    // the continuation recognised itself as stale — the reference uploaded a file the user removed
    expect(file.parts).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(uploader.uploads).toHaveLength(0);
  });

  test("cancelUpload runs only for a started, unfinished upload", async () => {
    const cancelUpload = vi.fn();
    const { uploader, calls } = makeUploader({ cancelUpload, concurrency: 1 }, 10);

    // never signed: nothing exists server-side to cancel
    uploader.addFiles([makeFile("a.bin", 10)]);
    uploader.files[0]?.remove();
    expect(cancelUpload).not.toHaveBeenCalled();

    // signed and in flight: cancel it
    uploader.addFiles([makeFile("b.bin", 10)]);
    await flush();
    uploader.files[0]?.remove();
    expect(cancelUpload).toHaveBeenCalledTimes(1);

    // completed: nothing to abort, it is a removal instead
    const onRemove = vi.fn();
    Object.assign(uploader.config, { onRemove });
    uploader.addFiles([makeFile("c.bin", 10)]);
    await flush();
    calls[calls.length - 1]?.resolve();
    await flush();
    expect(uploader.files[0]?.status).toBe("COMPLETED");

    uploader.files[0]?.remove();
    expect(cancelUpload).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// retry policy
// ---------------------------------------------------------------------------

describe("retry", () => {
  test("a retryable failure backs off, holds no slot, then retries", async () => {
    vi.useFakeTimers();
    const { uploader, calls } = makeUploader({ concurrency: 1 }, 10);

    uploader.addFiles([makeFile("a.bin", 10)]);
    await vi.advanceTimersByTimeAsync(0);

    const part = calls[0]?.part;
    calls[0]?.reject(new UploadError("PART", { status: 500 }));
    await vi.advanceTimersByTimeAsync(0);

    // parked in backoff, and crucially not occupying a concurrency slot
    expect(part?.status).toBe("WAITING");
    expect(uploader.activeParts).toHaveLength(0);
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(2);
    expect(part?.status).toBe("UPLOADING");
    expect(part?.attempt).toBe(2);
  });

  test("attempts are capped and FAILED is written with no trailing sleep", async () => {
    vi.useFakeTimers();
    const { uploader, calls } = makeUploader({ concurrency: 1, maxPartAttempts: 4 }, 10);

    uploader.addFiles([makeFile("a.bin", 10)]);
    await vi.advanceTimersByTimeAsync(0);

    for (let attempt = 0; attempt < 4; attempt++) {
      calls[calls.length - 1]?.reject(new UploadError("PART", { status: 503 }));
      // enough to clear the largest backoff window
      await vi.advanceTimersByTimeAsync(10_000);
    }

    expect(calls).toHaveLength(4);
    expect(calls[0]?.part.status).toBe("FAILED");
    // the file failed the moment the last attempt did, not ~50s later
    expect(uploader.files[0]?.status).toBe("FAILED");
    expect(uploader.files[0]?.error?.type).toBe("PART");
  });

  test("a fatal status fails immediately without retrying", async () => {
    const { uploader, calls } = makeUploader({ concurrency: 1 }, 10);

    uploader.addFiles([makeFile("a.bin", 10)]);
    await flush();

    calls[0]?.reject(new UploadError("PART", { status: 403 }));
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.part.attempt).toBe(1);
    expect(uploader.files[0]?.status).toBe("FAILED");
  });

  test("isRetryable can override the policy", async () => {
    vi.useFakeTimers();
    const { uploader, calls } = makeUploader(
      {
        concurrency: 1,
        isRetryable: () => true,
      },
      10,
    );

    uploader.addFiles([makeFile("a.bin", 10)]);
    await vi.advanceTimersByTimeAsync(0);

    calls[0]?.reject(new UploadError("PART", { status: 403 }));
    await vi.advanceTimersByTimeAsync(1000);

    expect(calls).toHaveLength(2);
  });

  test("retry() re-queues the failed parts of a failed file", async () => {
    const { uploader, calls } = makeUploader({ concurrency: 1 }, 10);

    uploader.addFiles([makeFile("a.bin", 20)]);
    await flush();

    calls[0]?.resolve();
    await flush();
    calls[1]?.reject(new UploadError("PART", { status: 403 }));
    await flush();

    const file = uploader.files[0] as FileModel;
    expect(file.status).toBe("FAILED");

    file.retry();
    await flush();

    // the completed part is untouched; only the failed one runs again
    expect(file.status).toBe("UPLOADING");
    expect(file.completedParts).toHaveLength(1);
    expect(calls).toHaveLength(3);
    expect(calls[2]?.part.index).toBe(1);
  });

  test("retry() re-signs when signing itself failed", async () => {
    let attempt = 0;
    const { uploader } = makeUploader({
      requestUpload: (_signal, file) => {
        attempt++;
        if (attempt === 1) return Promise.reject(new Error("gateway down"));
        return Promise.resolve({ id: "x", name: file.name, parts: partsFor(file.size, 10) });
      },
    });

    uploader.addFiles([makeFile("a.bin", 10)]);
    await flush();

    const file = uploader.files[0] as FileModel;
    expect(file.status).toBe("FAILED");
    expect(file.error?.type).toBe("REQUEST");
    // a thrown Error's own message survives — it is the only useful part
    expect(file.error?.message).toBe("gateway down");

    file.retry();
    await flush();

    expect(file.status).toBe("UPLOADING");
    expect(attempt).toBe(2);
  });

  test("requestUpload is not auto-retried", async () => {
    let attempt = 0;
    const { uploader } = makeUploader({
      requestUpload: () => {
        attempt++;
        return Promise.reject(new Error("nope"));
      },
    });

    uploader.addFiles([makeFile("a.bin", 10)]);
    await flush();

    expect(attempt).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// completion
// ---------------------------------------------------------------------------

describe("completeUpload", () => {
  test("the file sits in COMPLETING and the value is not emitted until it resolves", async () => {
    let release: (() => void) | undefined;
    const onChange = vi.fn();
    const { uploader, calls } = makeUploader({
      concurrency: 2,
      onChange,
      completeUpload: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });

    uploader.addFiles([makeFile("a.bin", 10)]);
    await flush();
    calls[0]?.resolve();
    await flush();

    const file = uploader.files[0] as FileModel;
    expect(file.status).toBe("COMPLETING");
    expect(uploader.values).toEqual([]);
    expect(onChange).not.toHaveBeenCalled();
    expect(uploader.invalid).toBe(true);

    release?.();
    await flush();

    expect(file.status).toBe("COMPLETED");
    expect(uploader.values).toEqual([{ id: "id-a.bin", name: "a.bin" }]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test("it fires exactly once even across extra pumps", async () => {
    const completeUpload = vi.fn(() => Promise.resolve());
    const { uploader, calls } = makeUploader({ concurrency: 2, completeUpload });

    uploader.addFiles([makeFile("a.bin", 10)]);
    await flush();
    calls[0]?.resolve();
    await flush();

    uploader.pump();
    uploader.pump();
    await flush();

    expect(completeUpload).toHaveBeenCalledTimes(1);
  });

  test("a failure fails the file and never emits the id", async () => {
    const onChange = vi.fn();
    const { uploader, calls } = makeUploader({
      concurrency: 2,
      onChange,
      completeUpload: () => Promise.reject(new Error("could not finalize")),
    });

    uploader.addFiles([makeFile("a.bin", 10)]);
    await flush();
    calls[0]?.resolve();
    await flush();

    const file = uploader.files[0] as FileModel;
    expect(file.status).toBe("FAILED");
    expect(file.error?.type).toBe("COMPLETE");
    expect(uploader.values).toEqual([]);
    expect(onChange).not.toHaveBeenCalled();
  });

  test("retry() re-issues only the completion call", async () => {
    let attempt = 0;
    const { uploader, calls } = makeUploader({
      concurrency: 2,
      completeUpload: () => {
        attempt++;
        return attempt === 1 ? Promise.reject(new Error("flaky")) : Promise.resolve();
      },
    });

    uploader.addFiles([makeFile("a.bin", 10)]);
    await flush();
    calls[0]?.resolve();
    await flush();
    expect(uploader.files[0]?.status).toBe("FAILED");

    uploader.files[0]?.retry();
    await flush();

    expect(attempt).toBe(2);
    // no part was re-uploaded
    expect(calls).toHaveLength(1);
    expect(uploader.files[0]?.status).toBe("COMPLETED");
  });
});

// ---------------------------------------------------------------------------
// controlled value
// ---------------------------------------------------------------------------

describe("controlled value", () => {
  test("initial value rehydrates without firing onChange", () => {
    const onChange = vi.fn();
    const { uploader } = makeUploader({
      onChange,
      value: [{ id: "a", name: "alpha.pdf" }],
    });

    expect(uploader.uploads).toHaveLength(1);
    expect(uploader.uploads[0]?.name).toBe("alpha.pdf");
    expect(uploader.uploads[0]?.extension).toBe("pdf");
    expect(uploader.uploads[0]?.status).toBe("COMPLETED");
    expect(uploader.uploads[0]?.progress).toBe(100);
    expect(onChange).not.toHaveBeenCalled();
  });

  test("the name is carried, never inferred from the id", () => {
    const { uploader } = makeUploader({
      value: [{ id: "3f2b9c14-0000-4000-8000-000000000000", name: "contract.pdf" }],
    });

    // the reference derived the name from the identifier, which renders a bare uuid here
    expect(uploader.uploads[0]?.name).toBe("contract.pdf");
    expect(uploader.uploads[0]?.extension).toBe("pdf");
  });

  test("applyValue is idempotent", () => {
    const onChange = vi.fn();
    const { uploader } = makeUploader({ onChange });

    const value: UploadValue[] = [
      { id: "a", name: "a.pdf" },
      { id: "b", name: "b.pdf" },
    ];
    uploader.applyValue(value);
    const keys = uploader.uploads.map((upload) => upload.key);

    // a fresh array of fresh objects with the same contents is not a change
    uploader.applyValue([
      { id: "a", name: "a.pdf" },
      { id: "b", name: "b.pdf" },
    ]);

    expect(uploader.uploads.map((upload) => upload.key)).toEqual(keys);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test("dropping an id removes it; adding one rehydrates it", () => {
    const { uploader } = makeUploader({ value: [{ id: "a", name: "a.pdf" }] });

    uploader.applyValue([{ id: "b", name: "b.pdf" }]);
    expect(uploader.ids).toEqual(["b"]);

    uploader.applyValue([
      { id: "b", name: "b.pdf" },
      { id: "c", name: "c.pdf" },
    ]);
    expect(uploader.ids).toEqual(["b", "c"]);
  });

  test("a renamed rehydrated upload picks up the new name", () => {
    const { uploader } = makeUploader({ value: [{ id: "a", name: "old.pdf" }] });

    uploader.applyValue([{ id: "a", name: "new.pdf" }]);

    expect(uploader.uploads).toHaveLength(1);
    expect(uploader.uploads[0]?.name).toBe("new.pdf");
  });

  test("an in-flight upload is invisible to the diff", async () => {
    const { uploader } = makeUploader({ concurrency: 1 }, 10);

    uploader.addFiles([makeFile("a.bin", 20)]);
    await flush();
    expect(uploader.files[0]?.status).toBe("UPLOADING");

    // the parent echoes back an empty value, which must not cancel work in progress
    uploader.applyValue([]);

    expect(uploader.uploads).toHaveLength(1);
    expect(uploader.files[0]?.status).toBe("UPLOADING");
  });

  test("onChange is structurally deduped and reports the completed set", async () => {
    const onChange = vi.fn();
    const { uploader, calls } = makeUploader({ concurrency: 2, onChange });

    uploader.addFiles([makeFile("a.bin", 10)]);
    await flush();
    calls[0]?.resolve();
    await flush();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).toEqual([{ id: "id-a.bin", name: "a.bin" }]);

    // unrelated churn does not echo
    uploader.pump();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test("dispose drops the onChange reaction", async () => {
    const onChange = vi.fn();
    const { uploader, calls } = makeUploader({ concurrency: 2, onChange });

    uploader.addFiles([makeFile("a.bin", 10)]);
    await flush();
    uploader.dispose();

    calls[0]?.resolve();
    await flush();

    expect(onChange).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

describe("validate", () => {
  test("a rejected file never enters uploads and never becomes a failed row", () => {
    const onError = vi.fn();
    const { uploader, requested } = makeUploader({
      multiple: true,
      onError,
      validate: (file) => (file.size > 100 ? "Too big." : undefined),
    });

    uploader.addFiles([makeFile("small.bin", 10), makeFile("huge.bin", 500)]);

    expect(uploader.uploads).toHaveLength(1);
    expect(uploader.uploads[0]?.name).toBe("small.bin");
    expect(requested).toEqual(["small.bin"]);

    const error = onError.mock.calls[0]?.[0] as UploadError;
    expect(error.type).toBe("REJECTED");
    expect(error.message).toBe("Too big.");
    expect(error.fileName).toBe("huge.bin");
    // no model to hang it on, which is exactly why onError exists
    expect(onError.mock.calls[0]?.[1]).toBeUndefined();
  });

  test("a count rule sees earlier files in the same batch", () => {
    const { uploader } = makeUploader({
      multiple: true,
      validate: (_file, model) => (model.uploads.length >= 2 ? "Max 2." : undefined),
    });

    uploader.addFiles([
      makeFile("a.bin", 10),
      makeFile("b.bin", 10),
      makeFile("c.bin", 10),
      makeFile("d.bin", 10),
    ]);

    expect(uploader.uploads.map((upload) => upload.name)).toEqual(["a.bin", "b.bin"]);
  });
});

// ---------------------------------------------------------------------------
// collection
// ---------------------------------------------------------------------------

describe("collection", () => {
  test("single-file mode replaces uploads of either kind", async () => {
    const { uploader } = makeUploader({ value: [{ id: "old", name: "old.pdf" }] }, 10);

    uploader.addFiles([makeFile("new.pdf", 10)]);
    await flush();

    // the reference cancelled only the in-flight files, so the rehydrated one survived
    expect(uploader.uploads).toHaveLength(1);
    expect(uploader.uploads[0]?.name).toBe("new.pdf");
  });

  test("multiple mode accumulates", () => {
    const { uploader } = makeUploader({ multiple: true });

    uploader.addFiles([makeFile("a.bin", 10)]);
    uploader.addFiles([makeFile("b.bin", 10)]);

    expect(uploader.uploads).toHaveLength(2);
  });

  test("clear removes both kinds", async () => {
    const { uploader } = makeUploader({ multiple: true, value: [{ id: "old", name: "o.pdf" }] });

    uploader.addFiles([makeFile("a.bin", 10)]);
    await flush();
    uploader.clear();

    expect(uploader.uploads).toHaveLength(0);
  });

  test("maxFiles caps additions and reports the refusal", () => {
    const onError = vi.fn();
    const { uploader } = makeUploader({ multiple: true, maxFiles: 2, onError });

    uploader.addFiles([makeFile("a.bin", 10), makeFile("b.bin", 10), makeFile("c.bin", 10)]);

    expect(uploader.uploads.map((upload) => upload.name)).toEqual(["a.bin", "b.bin"]);
    expect(uploader.full).toBe(true);
    expect(uploader.remainingSlots).toBe(0);
    const error = onError.mock.calls[0]?.[0] as UploadError;
    expect(error.type).toBe("REJECTED");
    expect(error.message).toContain("No more than 2");
  });

  test("maxFiles counts rehydrated uploads, which a design system's own cap cannot", () => {
    const onError = vi.fn();
    const { uploader, requested } = makeUploader({
      multiple: true,
      maxFiles: 1,
      onError,
      value: [{ id: "old", name: "old.pdf" }],
    });

    expect(uploader.full).toBe(true);

    uploader.addFiles([makeFile("new.bin", 10)]);

    // the whole point: one already-uploaded file fills a single-file field
    expect(uploader.uploads.map((upload) => upload.name)).toEqual(["old.pdf"]);
    expect(requested).toEqual([]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test("removing an upload frees a slot", async () => {
    const { uploader } = makeUploader({ multiple: true, maxFiles: 1 }, 10);

    uploader.addFiles([makeFile("a.bin", 10)]);
    await flush();
    expect(uploader.remainingSlots).toBe(0);

    uploader.uploads[0]?.remove();
    expect(uploader.remainingSlots).toBe(1);

    uploader.addFiles([makeFile("b.bin", 10)]);
    expect(uploader.uploads.map((upload) => upload.name)).toEqual(["b.bin"]);
  });

  test("maxFiles defaults from multiple", () => {
    expect(makeUploader().uploader.maxFiles).toBe(1);
    expect(makeUploader({ multiple: true }).uploader.maxFiles).toBe(Number.POSITIVE_INFINITY);
    expect(makeUploader({ multiple: true }).uploader.remainingSlots).toBe(Number.POSITIVE_INFINITY);
  });

  test("the cap governs picking, not rehydration", () => {
    // a controlled value is authoritative — truncating it would silently drop persisted uploads
    const { uploader } = makeUploader({
      multiple: true,
      maxFiles: 1,
      value: [
        { id: "a", name: "a.pdf" },
        { id: "b", name: "b.pdf" },
      ],
    });

    expect(uploader.ids).toEqual(["a", "b"]);
  });

  test("setFiles respects the cap, counting removals first", async () => {
    const { uploader } = makeUploader({ multiple: true, maxFiles: 2 }, 10);
    const a = makeFile("a.bin", 10);
    const b = makeFile("b.bin", 10);

    uploader.setFiles([a, b]);
    await flush();
    expect(uploader.uploads).toHaveLength(2);

    // a drops out in the same call that c arrives, so the slot it frees is available to c
    const c = makeFile("c.bin", 10);
    uploader.setFiles([b, c]);

    expect(uploader.uploads.map((upload) => upload.name)).toEqual(["b.bin", "c.bin"]);
  });

  test("addFiles skips a file already in the list and says why", () => {
    const onError = vi.fn();
    const { uploader, requested } = makeUploader({ multiple: true, onError });
    const a = makeFile("a.bin", 10);

    uploader.addFiles([a]);
    uploader.addFiles([a]);
    // a distinct File object with the same name/size/type counts as the same selection
    uploader.addFiles([makeFile("a.bin", 10)]);

    expect(uploader.uploads).toHaveLength(1);
    expect(requested).toEqual(["a.bin"]);
    expect(onError).toHaveBeenCalledTimes(2);
    const error = onError.mock.calls[0]?.[0] as UploadError;
    expect(error.type).toBe("REJECTED");
    expect(error.message).toContain("already been added");
  });

  test("addFiles dedupes within a single batch", () => {
    const { uploader } = makeUploader({ multiple: true });
    const a = makeFile("a.bin", 10);

    uploader.addFiles([a, a, makeFile("b.bin", 10)]);

    expect(uploader.uploads.map((upload) => upload.name)).toEqual(["a.bin", "b.bin"]);
  });

  test("addFiles still allows genuinely different files", () => {
    const { uploader } = makeUploader({ multiple: true });

    // same name, different size — not the same selection
    uploader.addFiles([makeFile("a.bin", 10)]);
    uploader.addFiles([makeFile("a.bin", 20)]);

    expect(uploader.uploads).toHaveLength(2);
  });

  test("single-file mode replaces rather than reporting a duplicate", () => {
    const onError = vi.fn();
    const { uploader } = makeUploader({ onError });
    const a = makeFile("a.bin", 10);

    uploader.addFiles([a]);
    uploader.addFiles([a]);

    // the first was cleared, so there is nothing to collide with
    expect(uploader.uploads).toHaveLength(1);
    expect(onError).not.toHaveBeenCalled();
  });

  test("setFiles reconciles instead of accumulating", () => {
    const { uploader } = makeUploader({ multiple: true });
    const a = makeFile("a.bin", 10);
    const b = makeFile("b.bin", 10);

    // this is the shape Chakra/Ark hand back: the whole accepted list on every change
    uploader.setFiles([a]);
    uploader.setFiles([a, b]);

    expect(uploader.uploads.map((upload) => upload.name)).toEqual(["a.bin", "b.bin"]);
  });

  test("setFiles keeps a matched upload's identity and in-flight state", async () => {
    const { uploader, calls } = makeUploader({ multiple: true, concurrency: 4 }, 10);
    const a = makeFile("a.bin", 20);

    uploader.setFiles([a]);
    await flush();
    const first = uploader.files[0] as FileModel;
    expect(first.status).toBe("UPLOADING");
    const callCount = calls.length;

    uploader.setFiles([a, makeFile("b.bin", 10)]);
    await flush();

    // the running upload is untouched — same model, not restarted
    expect(uploader.files[0]).toBe(first);
    expect(first.key).toBe(uploader.files[0]?.key);
    expect(calls.filter((call) => call.part.file === first)).toHaveLength(callCount);
  });

  test("setFiles matches structurally, as the design system does", () => {
    const { uploader } = makeUploader({ multiple: true });

    uploader.setFiles([makeFile("a.bin", 10)]);
    const first = uploader.files[0];

    // a distinct File object with the same name/size/type — what a transformFiles step produces
    uploader.setFiles([makeFile("a.bin", 10)]);

    expect(uploader.uploads).toHaveLength(1);
    expect(uploader.files[0]).toBe(first);
  });

  test("setFiles removes dropped files and cancels started ones", async () => {
    const cancelUpload = vi.fn();
    const { uploader } = makeUploader({ multiple: true, cancelUpload, concurrency: 4 }, 10);
    const a = makeFile("a.bin", 10);
    const b = makeFile("b.bin", 10);

    uploader.setFiles([a, b]);
    await flush();
    expect(uploader.uploads).toHaveLength(2);

    // this is also what Chakra's ItemDeleteTrigger produces — a shorter list, not a delta
    uploader.setFiles([b]);

    expect(uploader.uploads.map((upload) => upload.name)).toEqual(["b.bin"]);
    expect(cancelUpload).toHaveBeenCalledTimes(1);
  });

  test("setFiles leaves rehydrated completed uploads alone", async () => {
    const { uploader } = makeUploader(
      { multiple: true, value: [{ id: "old", name: "old.pdf" }] },
      10,
    );

    uploader.setFiles([makeFile("new.bin", 10)]);
    await flush();
    expect(uploader.uploads).toHaveLength(2);

    // clearing the picker must not discard something that already exists server-side
    uploader.setFiles([]);

    expect(uploader.uploads.map((upload) => upload.name)).toEqual(["old.pdf"]);
    expect(uploader.ids).toEqual(["old"]);
  });

  test("setFiles applies validate to new files only", () => {
    const onError = vi.fn();
    const { uploader } = makeUploader({
      multiple: true,
      onError,
      validate: (file) => (file.size > 100 ? "Too big." : undefined),
    });
    const ok = makeFile("ok.bin", 10);

    uploader.setFiles([ok, makeFile("huge.bin", 500)]);
    expect(uploader.uploads.map((upload) => upload.name)).toEqual(["ok.bin"]);
    expect(onError).toHaveBeenCalledTimes(1);

    // the retained file is not re-validated
    uploader.setFiles([ok]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(uploader.uploads).toHaveLength(1);
  });

  test("setFiles keeps the last file in single mode", () => {
    const { uploader } = makeUploader();

    uploader.setFiles([makeFile("a.bin", 10), makeFile("b.bin", 10)]);

    expect(uploader.uploads.map((upload) => upload.name)).toEqual(["b.bin"]);
  });

  test("keys are unique across uploads and across uploaders", () => {
    const first = makeUploader({ multiple: true });
    const second = makeUploader({ multiple: true });

    first.uploader.addFiles([makeFile("a.bin", 10), makeFile("b.bin", 10)]);
    second.uploader.addFiles([makeFile("c.bin", 10)]);
    second.uploader.addCompletedUpload({ id: "d", name: "d.pdf" });

    const keys = [...first.uploader.uploads, ...second.uploader.uploads].map((u) => u.key);
    expect(new Set(keys).size).toBe(4);
  });

  test("keys are stable and distinct from the server id", async () => {
    const { uploader, calls } = makeUploader({ concurrency: 2 });

    uploader.addFiles([makeFile("a.bin", 10)]);
    const file = uploader.files[0] as FileModel;
    const key = file.key;

    expect(file.uploadId).toBeUndefined();
    await flush();
    calls[0]?.resolve();
    await flush();

    expect(file.uploadId).toBe("id-a.bin");
    expect(file.key).toBe(key);
    expect(file.key).not.toBe(file.uploadId);
  });
});

// ---------------------------------------------------------------------------
// progress
// ---------------------------------------------------------------------------

describe("progress", () => {
  test("is 0 rather than NaN with nothing to upload", () => {
    const { uploader } = makeUploader();
    expect(uploader.progress).toBe(0);
  });

  test("is 0 rather than NaN while a file has no parts yet", () => {
    const { uploader } = makeUploader();
    uploader.addFiles([makeFile("a.bin", 100)]);

    const file = uploader.files[0] as FileModel;
    expect(file.parts).toHaveLength(0);
    expect(file.progress).toBe(0);
    expect(Number.isNaN(file.progress)).toBe(false);
    expect(Number.isNaN(uploader.progress)).toBe(false);
  });

  test("is weighted by bytes across unequal parts", async () => {
    const { uploader, calls } = makeUploader({
      concurrency: 4,
      requestUpload: (_signal, file) =>
        Promise.resolve({
          id: "x",
          name: file.name,
          parts: [
            { url: "https://example.test/a", size: 90 },
            { url: "https://example.test/b", size: 10 },
          ],
        }),
    });

    uploader.addFiles([makeFile("a.bin", 100)]);
    await flush();

    // finish the small part only: by part count that is 50%, by bytes it is 10%
    const small = calls.find((call) => call.part.size === 10);
    small?.resolve();
    await flush();

    expect(uploader.files[0]?.progress).toBe(10);
  });

  test("reports in-flight bytes from progress events", async () => {
    const { uploader, calls } = makeUploader({ concurrency: 4 }, 100);

    uploader.addFiles([makeFile("a.bin", 100)]);
    await flush();

    calls[0]?.onProgress(25);
    expect(uploader.files[0]?.progress).toBe(25);
    expect(uploader.files[0]?.loaded).toBe(25);

    // an over-reporting transport cannot push a part past its own size
    calls[0]?.onProgress(500);
    expect(uploader.files[0]?.progress).toBe(100);
  });

  test("a failed file is excluded from the aggregate", async () => {
    const { uploader, calls } = makeUploader({ multiple: true, concurrency: 4 }, 100);

    uploader.addFiles([makeFile("a.bin", 100), makeFile("b.bin", 100)]);
    await flush();

    calls[0]?.reject(new UploadError("PART", { status: 403 }));
    await flush();
    calls[1]?.resolve();
    await flush();

    expect(uploader.files[0]?.status).toBe("FAILED");
    expect(uploader.failed).toBe(true);
    expect(uploader.progress).toBe(100);
  });
});
