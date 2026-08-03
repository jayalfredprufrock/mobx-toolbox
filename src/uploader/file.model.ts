import { action, computed, makeObservable, observable } from "mobx";
import { toUploadError, UploadError } from "./errors";
import { PartModel } from "./part.model";
import type { UploaderModel } from "./uploader.model";
import type {
  FileConfig,
  FileStatus,
  UploadLike,
  UploadRequestResult,
  UploadValue,
} from "./uploader.types";
import { getFileExtension, nextUploadKey } from "./uploader.util";

/**
 * One local `File` being uploaded: its server identity, its parts, and its phase.
 *
 * `status` is **explicit observable state**, not a derivation from the parts. `PENDING` and
 * `REQUESTING` both have zero parts, `COMPLETING` and `COMPLETED` both have all parts complete, and
 * `COMPLETED` has to be sticky because it is what gets emitted into the consumer's form value — a
 * derivation would un-complete a file the moment any part model was touched. Parts still *drive* the
 * status, but through the uploader's scheduler rather than through a getter.
 */
export class FileModel implements UploadLike {
  readonly uploader: UploaderModel;
  readonly config: FileConfig;
  /** Stable client identity for React keys; distinct from the server's `uploadId`. */
  readonly key: string = nextUploadKey();

  status: FileStatus = "PENDING";
  parts: PartModel[] = [];
  uploadId: string | undefined = undefined;
  error: UploadError | undefined = undefined;

  /** The server's canonical name, once known. Falls back to the local `File.name`. */
  private serverName: string | undefined = undefined;

  // Control flow only — nothing derives from these.
  private controller: AbortController | undefined;
  private completeRequested = false;
  private objectUrlValue: string | undefined;

  get file(): File {
    return this.config.file;
  }

  get size(): number {
    return this.config.file.size;
  }

  get type(): string {
    return this.config.file.type;
  }

  get isImage(): boolean {
    return this.type.startsWith("image/");
  }

  get isVideo(): boolean {
    return this.type.startsWith("video/");
  }

  get previewable(): boolean {
    return this.isImage || this.isVideo;
  }

  /**
   * A blob URL for previewing the file, minted on first read and revoked by `dispose`.
   *
   * Deliberately **not** a `computed`. A computed's body must be pure, and `URL.createObjectURL`
   * allocates a document-scoped handle; worse, computeds suspend when unobserved and recompute on
   * the next read, so a computed here mints a fresh blob URL every time a preview unmounts and
   * remounts and leaks the previous one for the page's lifetime. This is a plain getter over
   * readonly, non-observable state memoized into a plain field, so it can never invalidate: it mints
   * at most once per activate/dispose cycle and `dispose` revokes exactly what was minted.
   *
   * `undefined` rather than `""` for non-previewable files, so consumers don't render `<img src="">`
   * (which requests the current page).
   */
  get objectUrl(): string | undefined {
    if (!this.previewable) return undefined;
    this.objectUrlValue ??= URL.createObjectURL(this.config.file);
    return this.objectUrlValue;
  }

  get name(): string {
    return this.serverName ?? this.config.file.name;
  }

  get extension(): string {
    return getFileExtension(this.name);
  }

  get value(): UploadValue | undefined {
    if (this.status !== "COMPLETED" || this.uploadId === undefined) return undefined;
    return { id: this.uploadId, name: this.name };
  }

  get queuedParts(): PartModel[] {
    return this.parts.filter((part) => part.status === "QUEUED");
  }

  get activeParts(): PartModel[] {
    return this.parts.filter((part) => part.status === "UPLOADING");
  }

  get waitingParts(): PartModel[] {
    return this.parts.filter((part) => part.status === "WAITING");
  }

  get completedParts(): PartModel[] {
    return this.parts.filter((part) => part.status === "COMPLETED");
  }

  get failedParts(): PartModel[] {
    return this.parts.filter((part) => part.status === "FAILED");
  }

  /** Vacuously true for a zero-part file, which is how a zero-byte upload completes. */
  get partsComplete(): boolean {
    return this.parts.every((part) => part.status === "COMPLETED");
  }

  /** Bytes confirmed on the wire across every part. */
  get loaded(): number {
    return this.parts.reduce((sum, part) => sum + part.loaded, 0);
  }

  /**
   * 0–100, weighted by **bytes** rather than by part count — with exact server-supplied sizes the
   * parts are unequal, so averaging their percentages misreports. Zero-guarded: the reference
   * divided by `parts.length` and rendered `NaN` for the entire pre-signing phase.
   */
  get progress(): number {
    if (this.status === "COMPLETED") return 100;
    if (!this.size) return 0;
    return Math.min(100, Math.floor((this.loaded / this.size) * 100));
  }

  /** Whether this file has reached a terminal status. */
  get settled(): boolean {
    return this.status === "COMPLETED" || this.status === "FAILED";
  }

  constructor(uploader: UploaderModel, config: FileConfig) {
    this.uploader = uploader;
    this.config = config;

    makeObservable<this, "serverName" | "applyRequestResult">(this, {
      status: observable,
      // shallow: PartModels are observable in their own right, and the array is replaced wholesale
      // exactly once (applyRequestResult) rather than mutated in place
      parts: observable.shallow,
      uploadId: observable.ref,
      serverName: observable.ref,
      error: observable.ref,

      name: computed,
      extension: computed,
      value: computed,
      queuedParts: computed,
      activeParts: computed,
      waitingParts: computed,
      completedParts: computed,
      failedParts: computed,
      partsComplete: computed,
      loaded: computed,
      progress: computed,
      settled: computed,

      startRequest: action,
      startComplete: action,
      complete: action,
      fail: action,
      applyRequestResult: action,

      retry: action.bound,
      remove: action.bound,
      activate: action.bound,
      dispose: action.bound,
    });
  }

  /**
   * @internal Scheduler entry point: `PENDING` -> `REQUESTING`. Sets the status synchronously,
   * before the first await, so the scheduler's slot accounting is correct the moment this returns.
   */
  startRequest(): void {
    if (this.status !== "PENDING") return;
    this.status = "REQUESTING";
    this.error = undefined;
    const controller = new AbortController();
    this.controller = controller;
    void this.runRequest(controller);
  }

  /** @internal Scheduler entry point: `UPLOADING` -> `COMPLETING`. Fires `completeUpload` once. */
  startComplete(): void {
    if (this.status !== "UPLOADING" || this.completeRequested) return;
    this.status = "COMPLETING";
    this.completeRequested = true;
    const controller = new AbortController();
    this.controller = controller;
    void this.runComplete(controller);
  }

  /** @internal Terminal success. */
  complete(): void {
    this.status = "COMPLETED";
    this.error = undefined;
    this.controller = undefined;
  }

  /** @internal Terminal failure. */
  fail(error: UploadError): void {
    this.status = "FAILED";
    this.error = error;
    this.controller?.abort();
    this.controller = undefined;
    for (const part of this.parts) part.abort();
    if (error.dev) {
      // a broken integration contract, not a runtime condition — make it impossible to miss
      console.error(error);
    }
    this.uploader.reportError(error, this);
  }

  /**
   * Try a failed upload again. Re-signs when no id was ever obtained, re-issues just the completion
   * call when that is what failed, and otherwise re-queues the failed parts.
   */
  retry(): void {
    if (this.status !== "FAILED") return;
    this.error = undefined;

    if (this.uploadId === undefined) {
      this.parts = [];
      this.completeRequested = false;
      this.status = "PENDING";
    } else if (this.completeRequested) {
      // the parts all landed; only finalization failed
      this.completeRequested = false;
      this.status = "UPLOADING";
    } else {
      for (const part of this.parts) part.requeue();
      this.status = "UPLOADING";
    }

    this.uploader.pump();
  }

  /** Remove this upload from the uploader, cancelling it server-side if it started. */
  remove(): void {
    this.uploader.removeUpload(this);
  }

  /** Re-arm anything `dispose` released. Transient phases are re-issued from the top. */
  activate(): void {
    if (this.status === "REQUESTING") {
      this.status = "PENDING";
    } else if (this.status === "COMPLETING") {
      // completeUpload must be idempotent: an aborted request gives no evidence about whether the
      // server processed it, and re-issuing beats silently dropping the upload
      this.completeRequested = false;
      this.status = "UPLOADING";
    }
  }

  /**
   * Release every resource and park the work: the in-flight request is aborted, parts are aborted,
   * and the preview URL is revoked. Transient phases are rolled back to resumable ones rather than
   * failed, so `activate` can pick the upload back up.
   */
  dispose(): void {
    this.controller?.abort();
    this.controller = undefined;
    for (const part of this.parts) part.dispose();
    if (this.objectUrlValue) {
      URL.revokeObjectURL(this.objectUrlValue);
      this.objectUrlValue = undefined;
    }
  }

  private async runRequest(controller: AbortController): Promise<void> {
    try {
      const result = await this.uploader.config.requestUpload(controller.signal, this);
      // cancelled during signing: the file may already be gone from the collection, and creating
      // parts now would upload a file the user removed (a live bug in the reference)
      if (controller.signal.aborted) return;
      this.applyRequestResult(result);
    } catch (e: unknown) {
      if (controller.signal.aborted) return;
      this.fail(toUploadError(e, "REQUEST", { fileName: this.name }));
    } finally {
      this.uploader.pump();
    }
  }

  private async runComplete(controller: AbortController): Promise<void> {
    try {
      await this.uploader.config.completeUpload?.(controller.signal, this);
      if (controller.signal.aborted) return;
      this.complete();
    } catch (e: unknown) {
      if (controller.signal.aborted) return;
      this.fail(toUploadError(e, "COMPLETE", { fileName: this.name }));
    } finally {
      this.uploader.pump();
    }
  }

  /** `REQUESTING` -> `UPLOADING`, slicing the file against the server's exact part sizes. */
  private applyRequestResult(result: UploadRequestResult): void {
    const total = result.parts.reduce((sum, part) => sum + part.size, 0);
    const badSize = result.parts.some((part) => !Number.isSafeInteger(part.size) || part.size <= 0);

    if (total !== this.size || badSize) {
      this.fail(
        new UploadError("PART_SIZES", {
          fileName: result.name || this.name,
          message:
            `requestUpload returned ${result.parts.length} part size(s) summing to ${total} ` +
            `bytes for a ${this.size}-byte file. Every part's \`size\` must be the exact byte ` +
            `length the server signed that URL for: the browser derives Content-Length from the ` +
            `blob and cannot override it (it is a forbidden header), so a mismatch means the part ` +
            `upload is rejected with 403 SignatureDoesNotMatch.`,
        }),
      );
      return;
    }

    this.uploadId = result.id;
    this.serverName = result.name || undefined;

    // A running offset, not `i * partSize`: the sizes are the server's, they are not necessarily
    // equal, and an even split silently corrupts every part boundary after the first.
    let offset = 0;
    this.parts = result.parts.map((part, index) => {
      const model = new PartModel(this, {
        index,
        url: part.url,
        blob: this.config.file.slice(offset, offset + part.size),
      });
      offset += part.size;
      return model;
    });

    this.status = "UPLOADING";
  }
}
