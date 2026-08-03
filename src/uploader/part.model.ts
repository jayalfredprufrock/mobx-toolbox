import { action, computed, makeObservable, observable } from "mobx";
import { UploadError } from "./errors";
import type { FileModel } from "./file.model";
import type { PartConfig, PartStatus } from "./uploader.types";
import { retryDelayMs, xhrPutUpload } from "./uploader.util";

/**
 * One part of a multipart upload: a slice of the file plus the URL it was signed for.
 *
 * A part is a **single-attempt unit**. It does not loop over retries itself — a retryable failure
 * parks it in `WAITING`, releasing its concurrency slot for the duration of the backoff, and a timer
 * flips it back to `QUEUED` for the uploader's scheduler to pick up. The retry "loop" is therefore
 * the scheduler, which is what makes backoff free of concurrency cost and every intermediate state
 * inspectable. (The reference implementation slept inside `upload()` with the status still
 * `UPLOADING`, so a part waiting 3.3s held one of only four slots.)
 */
export class PartModel {
  readonly file: FileModel;
  readonly config: PartConfig;

  status: PartStatus = "QUEUED";
  /**
   * Bytes confirmed on the wire. Bytes rather than a percentage: with exact server-supplied part
   * sizes the parts are not equal-sized, so only a byte-weighted roll-up reports the file's real
   * progress.
   */
  loaded = 0;
  /** 1-based count of attempts started. */
  attempt = 0;
  error: UploadError | undefined = undefined;

  // Control flow only — nothing derives from these, so they stay out of the observable map.
  private controller: AbortController | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  get index(): number {
    return this.config.index;
  }

  get url(): string {
    return this.config.url;
  }

  get blob(): Blob {
    return this.config.blob;
  }

  get size(): number {
    return this.config.blob.size;
  }

  /** 0–100 for this part alone. Zero-guarded: a zero-byte part is 0% until it completes. */
  get progress(): number {
    if (this.status === "COMPLETED") return 100;
    if (!this.size) return 0;
    return Math.min(100, Math.floor((this.loaded / this.size) * 100));
  }

  constructor(file: FileModel, config: PartConfig) {
    this.file = file;
    this.config = config;

    makeObservable<this, "settle" | "wait" | "queue" | "setLoaded">(this, {
      status: observable,
      loaded: observable,
      attempt: observable,
      error: observable.ref,

      progress: computed,

      start: action,
      requeue: action,
      abort: action,
      dispose: action,
      settle: action,
      wait: action,
      queue: action,
      setLoaded: action,
    });
  }

  /**
   * @internal Scheduler entry point: `QUEUED` -> `UPLOADING`. Sets the status synchronously, before
   * the first await, so the scheduler's slot accounting is correct the moment this returns.
   */
  start(): void {
    if (this.status !== "QUEUED") return;
    this.status = "UPLOADING";
    this.attempt++;
    this.error = undefined;
    this.loaded = 0;
    const controller = new AbortController();
    this.controller = controller;
    void this.attemptUpload(controller);
  }

  /** @internal `FAILED` -> `QUEUED` with the attempt counter reset, for `file.retry()`. */
  requeue(): void {
    if (this.status !== "FAILED") return;
    this.status = "QUEUED";
    this.attempt = 0;
    this.error = undefined;
    this.loaded = 0;
  }

  /**
   * @internal Abandon the current attempt and become eligible again. Used when the file fails or the
   * uploader is parked. Object-store part PUTs are not range-resumable, so the part restarts from 0.
   */
  abort(): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.controller?.abort();
    this.controller = undefined;
    if (this.status === "UPLOADING" || this.status === "WAITING") {
      this.status = "QUEUED";
      this.loaded = 0;
    }
  }

  /** Release every resource. Leaves the part in a resumable status; pairs with the uploader's `activate`. */
  dispose(): void {
    this.abort();
  }

  /**
   * Exactly one attempt.
   *
   * `controller` is captured as a parameter rather than read off `this`: after a dispose/activate
   * cycle a newer attempt owns `this.controller`, and this continuation has to recognize itself as
   * stale instead of clobbering the new one's state.
   */
  private async attemptUpload(controller: AbortController): Promise<void> {
    const { config } = this.file.uploader;

    try {
      await (config.uploadPart ?? xhrPutUpload)(controller.signal, this, (loaded) => {
        if (!controller.signal.aborted) this.setLoaded(loaded);
      });
      // aborted mid-flight: abort() has already written a resumable status, so writing here would
      // race it and resurrect a part the scheduler has moved on from
      if (controller.signal.aborted) return;
      this.settle("COMPLETED");
    } catch (e: unknown) {
      if (controller.signal.aborted) return;

      const error =
        e instanceof UploadError
          ? e
          : new UploadError("PART", { cause: e, fileName: this.file.name });

      if (error.type === "ABORTED") return;

      const retryable = config.isRetryable
        ? config.isRetryable(error)
        : this.file.uploader.isRetryableError(error);

      if (!retryable || this.attempt >= this.file.uploader.maxPartAttempts) {
        this.settle("FAILED", error);
      } else {
        this.wait(error);
      }
    } finally {
      // whatever happened, slots may have freed up
      this.file.uploader.pump();
    }
  }

  /** `UPLOADING` -> `WAITING`. Releases the part slot; the timer re-queues. */
  private wait(error: UploadError): void {
    this.status = "WAITING";
    this.error = error;
    this.loaded = 0;
    this.controller = undefined;
    const { config } = this.file.uploader;
    const delay = retryDelayMs(this.attempt, {
      baseMs: config.retryBaseMs,
      capMs: config.retryCapMs,
      retryAfterMs: error.retryAfterMs,
    });
    this.retryTimer = setTimeout(() => this.queue(), delay);
  }

  /** `WAITING` -> `QUEUED`, from the backoff timer. */
  private queue(): void {
    this.retryTimer = undefined;
    if (this.status !== "WAITING") return;
    this.status = "QUEUED";
    this.file.uploader.pump();
  }

  private settle(status: "COMPLETED" | "FAILED", error?: UploadError): void {
    this.status = status;
    this.error = error;
    // progress events can under-report; a completed part is fully loaded by definition
    this.loaded = status === "COMPLETED" ? this.size : 0;
    this.controller = undefined;
  }

  private setLoaded(loaded: number): void {
    this.loaded = Math.min(loaded, this.size);
  }
}
