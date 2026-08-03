import {
  action,
  comparer,
  computed,
  type IReactionDisposer,
  makeObservable,
  observable,
  reaction,
  runInAction,
} from "mobx";
import { CompletedUploadModel } from "./completed-upload.model";
import { toUploadError, UploadError } from "./errors";
import { FileModel } from "./file.model";
import type { PartModel } from "./part.model";
import type { Upload, UploaderConfig, UploadValue } from "./uploader.types";
import { isRetryableStatus, isSameFile, STALL_TIMEOUT_MS } from "./uploader.util";

/**
 * Owns the list of uploads and the scheduling of all network work.
 *
 * Scheduling is an explicit, synchronous, idempotent `pump()` action rather than a reaction. The
 * reference implementation used a self-triggering `autorun` that read the part queues and mutated
 * part status, which is a category error — a reaction's contract is "state to outside world", not
 * "state to state" — and it made the number of reaction passes an emergent property of the code
 * (O(N) passes to dispatch N parts, each recomputing every queue), untestable without leaning on
 * MobX's scheduler, and unable to express two concurrency budgets at once. `pump()` is called from
 * every transition point, so no free slot ever goes unfilled.
 */
export class UploaderModel {
  readonly config: UploaderConfig;

  /** Every upload, in display order: files being uploaded plus rehydrated completed uploads. */
  uploads: Upload[] = [];

  // Scheduling is a command, not a derivation: these gate and serialize `pump` and are deliberately
  // NOT observable — nothing derives from them, and observing them would invalidate every
  // scheduling computed on each pass.
  private active = false;
  private pumping = false;
  private pumpQueued = false;
  private changeReactionDisposer: IReactionDisposer | undefined;

  // Defaults live in getters, never merged into a defaults object. Plain getters over
  // non-observable readonly config, so they are not annotated.
  get concurrency(): number {
    return this.config.concurrency ?? 4;
  }

  get maxPendingUploads(): number {
    return this.config.maxPendingUploads ?? Number.POSITIVE_INFINITY;
  }

  /**
   * How many uploads the field holds at once, counting rehydrated ones. Defaults from `multiple`:
   * unlimited when it is set, `1` when it isn't.
   */
  get maxFiles(): number {
    return this.config.maxFiles ?? (this.config.multiple ? Number.POSITIVE_INFINITY : 1);
  }

  get maxPartAttempts(): number {
    return this.config.maxPartAttempts ?? 4;
  }

  get stallTimeoutMs(): number {
    return this.config.stallTimeoutMs ?? STALL_TIMEOUT_MS;
  }

  /** Only the uploads that have a local `File` behind them. */
  get files(): FileModel[] {
    return this.uploads.flatMap((upload) => (upload instanceof FileModel ? upload : []));
  }

  /** Every upload that has reached `COMPLETED`, in display order. */
  get completedUploads(): Upload[] {
    return this.uploads.filter((upload) => upload.status === "COMPLETED");
  }

  /** The form value: one `{ id, name }` per completed upload. */
  get values(): UploadValue[] {
    return this.uploads.flatMap((upload) => upload.value ?? []);
  }

  /** Just the ids, for consumers whose field stores bare identifiers. */
  get ids(): string[] {
    return this.values.map((value) => value.id);
  }

  get activeParts(): PartModel[] {
    return this.files.flatMap((file) => file.activeParts);
  }

  get queuedParts(): PartModel[] {
    return this.files.flatMap((file) => file.queuedParts);
  }

  /** Files whose signing request is in flight; each is a prospective part the pipeline can't see yet. */
  get requestingFiles(): FileModel[] {
    return this.files.filter((file) => file.status === "REQUESTING");
  }

  /**
   * Uploads that exist server-side but are not finished — the count a backend's pending-upload limit
   * applies to.
   *
   * `REQUESTING` files count even though they have no id yet: the request that is in flight is what
   * *creates* the server-side pending upload, so excluding them would let successive pumps sign past
   * `maxPendingUploads` while the first requests were still resolving.
   */
  get pendingUploads(): FileModel[] {
    return this.files.filter(
      (file) =>
        file.status !== "COMPLETED" &&
        (file.uploadId !== undefined || file.status === "REQUESTING"),
    );
  }

  /**
   * Whether the field is at `maxFiles`. Gate your browse control on this rather than keeping your own
   * count — it is the same number the model refuses additions with, and it counts both kinds of upload.
   */
  get full(): boolean {
    return this.uploads.length >= this.maxFiles;
  }

  /** How many more uploads will be accepted. `Infinity` when unlimited. */
  get remainingSlots(): number {
    return Math.max(0, this.maxFiles - this.uploads.length);
  }

  /** Whether any upload is still working. Use this instead of peeking at part counts. */
  get uploading(): boolean {
    return this.files.some((file) => !file.settled);
  }

  /** Whether any upload has failed. */
  get failed(): boolean {
    return this.uploads.some((upload) => upload.status === "FAILED");
  }

  /** Whether anything is not yet completed — the "block submit" flag. */
  get invalid(): boolean {
    return this.uploads.some((upload) => upload.status !== "COMPLETED");
  }

  /** Every error currently attached to an upload. */
  get errors(): UploadError[] {
    return this.uploads.flatMap((upload) => upload.error ?? []);
  }

  /** Total bytes across every file being uploaded. */
  get size(): number {
    return this.files.reduce((sum, file) => sum + file.size, 0);
  }

  /** Bytes confirmed on the wire across every file. */
  get loaded(): number {
    return this.files.reduce((sum, file) => sum + file.loaded, 0);
  }

  /**
   * 0–100 across every non-failed file, weighted by bytes so a 1 GB file doesn't count the same as a
   * 1 KB one. Zero-guarded — the reference computed `Math.floor(0 / 0)` and returned `NaN` whenever
   * there was nothing to upload.
   */
  get progress(): number {
    const valid = this.files.filter((file) => file.status !== "FAILED");
    if (!valid.length) return 0;
    const total = valid.reduce((sum, file) => sum + file.size, 0);
    if (!total) return valid.every((file) => file.status === "COMPLETED") ? 100 : 0;
    const loaded = valid.reduce((sum, file) => sum + file.loaded, 0);
    return Math.min(100, Math.floor((loaded / total) * 100));
  }

  constructor(config: UploaderConfig) {
    this.config = config;

    makeObservable<
      this,
      "pumpOnce" | "settleFiles" | "startPendingFiles" | "startQueuedParts" | "addFile"
    >(this, {
      // shallow: the entries are models that manage their own observability, so only the array's
      // membership needs tracking. `ref` would be wrong — addFile and removeUpload mutate in place.
      uploads: observable.shallow,

      files: computed,
      completedUploads: computed,
      values: computed,
      ids: computed,
      activeParts: computed,
      queuedParts: computed,
      requestingFiles: computed,
      pendingUploads: computed,
      full: computed,
      remainingSlots: computed,
      uploading: computed,
      failed: computed,
      invalid: computed,
      errors: computed,
      size: computed,
      loaded: computed,
      progress: computed,

      addFile: action,
      addFiles: action.bound,
      setFiles: action.bound,
      addCompletedUpload: action.bound,
      applyValue: action.bound,
      removeUpload: action.bound,
      clear: action.bound,
      retryAll: action.bound,
      // pump mutates status across many models; as an action the whole pass lands as one
      // transaction, so observers never see a half-scheduled state and onChange fires once per batch
      pump: action.bound,
      pumpOnce: action,
      settleFiles: action,
      startPendingFiles: action,
      startQueuedParts: action,
    });

    if (config.value) this.applyValue(config.value);
  }

  /**
   * (Re)arm the `onChange` reaction and resume scheduling. Idempotent. Pairs with `dispose` —
   * `useUploader` calls both across effect cycles, so a StrictMode dev remount (mount, cleanup,
   * mount against the same model) resumes rather than leaving the uploader parked.
   */
  activate(): void {
    this.active = true;

    if (!this.changeReactionDisposer) {
      this.changeReactionDisposer = reaction(
        () => this.values,
        (values) => this.config.onChange?.(values, this),
        // structural, so a fresh array of fresh objects with the same contents is not a change.
        // onChange is read off config at fire time, so an inline consumer lambda never re-subscribes.
        { equals: comparer.structural },
      );
    }

    runInAction(() => {
      for (const upload of this.uploads) upload.activate();
    });
    this.pump();
  }

  /**
   * Release every resource and park the work: in-flight requests and part uploads are aborted, retry
   * and stall timers cleared, preview URLs revoked, the `onChange` reaction dropped, and nothing new
   * is scheduled.
   *
   * Uploads are left in the collection with resumable statuses — call `activate` to pick them back
   * up, or `clear` to abandon them. A destructive dispose would abort every in-flight upload on a
   * StrictMode dev remount.
   */
  dispose(): void {
    this.active = false;
    this.changeReactionDisposer?.();
    this.changeReactionDisposer = undefined;
    runInAction(() => {
      for (const upload of this.uploads) upload.dispose();
    });
  }

  /**
   * **Add** files to whatever is already here. Accepts a `FileList` (from an `<input>`'s change event),
   * an array, or any iterable of `File`.
   *
   * Each file goes through `config.validate` in order, after earlier files in the batch have been
   * added — so a count rule sees them.
   *
   * A file already in the list is skipped rather than uploaded twice, matched by {@link isSameFile}
   * — so `setFiles` and `addFiles` agree about identity, and re-picking the same file can't produce
   * two uploads of the same bytes, two server-side pending uploads and two entries in the form value.
   * Skips are reported through `onError` as `UploadError("REJECTED")` rather than dropped silently.
   *
   * This is the *delta* API, for a selection layer that reports only what was newly picked — which is
   * what an `<input type="file">` change event gives you (and what `<Uploader.Root>` uses). If your
   * selection layer owns the list and hands back the whole thing on every change, use
   * {@link UploaderModel.setFiles} instead: that also removes files the layer dropped, which this
   * cannot see.
   */
  addFiles(files: FileList | Iterable<File>): void {
    const list = Array.from(files);
    if (!list.length) return;

    if (!this.config.multiple) {
      // single-file mode replaces rather than accumulates: keep only the last pick and drop whatever
      // was there, of either kind. `clear` is what makes this uniform — the reference called a
      // `cancel()` that iterated only the in-flight files, so a rehydrated upload survived the
      // replacement and a single-file uploader ended up holding two. No dedupe check is needed: there
      // is never anything left to collide with.
      const last = list[list.length - 1];
      this.clear();
      if (last) this.addFile(last);
    } else {
      for (const file of list) {
        if (this.files.some((upload) => isSameFile(upload.file, file))) {
          this.reportError(
            new UploadError("REJECTED", {
              fileName: file.name,
              message: `'${file.name}' has already been added.`,
            }),
          );
          continue;
        }
        this.addFile(file);
      }
    }

    this.pump();
  }

  /**
   * **Reconcile** the picked files to exactly this set — additions and removals both.
   *
   * This is the API for a selection layer that owns the file list and reports the whole thing on every
   * change rather than a delta. Chakra UI's and Ark UI's `FileUpload` work this way: `onFileAccept`
   * fires from the machine's `acceptedFiles` binding, so it receives the complete accepted list — and
   * it fires on deletions too, not just additions. Passing that to `addFiles` would duplicate every
   * file already present.
   *
   * Files are matched to existing uploads by reference, then by name + size + type (see
   * {@link isSameFile}) — the same identity `@zag-js/file-utils` uses, so both layers agree about what
   * "the same file" is. Matched uploads keep their position and their in-flight state, so a
   * reconciliation never restarts an upload that is already running. Uploads whose file is absent are
   * removed, cancelling them server-side if they had started. New files are appended through
   * `config.validate`.
   *
   * Rehydrated completed uploads are left alone: they have no `File`, they aren't part of the selection
   * layer's list, and they are owned by the controlled `value`. So `setFiles([])` clears the picked
   * files without discarding uploads that already exist server-side.
   */
  setFiles(files: FileList | Iterable<File>): void {
    const incoming = Array.from(files);
    // single-file mode keeps the last pick, matching addFiles
    const wanted = this.config.multiple ? incoming : incoming.slice(-1);

    const existing = this.files;
    const matched = new Set<FileModel>();
    const additions: File[] = [];

    for (const file of wanted) {
      // `matched` guards against one incoming file claiming two existing uploads; the selection layer
      // normally dedupes, so this only matters for a hand-built list
      const match = existing.find(
        (upload) => !matched.has(upload) && isSameFile(upload.file, file),
      );
      if (match) {
        matched.add(match);
      } else {
        additions.push(file);
      }
    }

    for (const upload of existing) {
      if (!matched.has(upload)) this.removeUpload(upload);
    }

    for (const file of additions) {
      this.addFile(file);
    }

    this.pump();
  }

  /** Add a rehydrated upload that already exists server-side. */
  addCompletedUpload(value: UploadValue): CompletedUploadModel {
    const upload = new CompletedUploadModel(this, value);
    this.uploads.push(upload);
    return upload;
  }

  /**
   * Reconcile the controlled value, matching **by `id` only**.
   *
   * Only `COMPLETED` uploads take part in the removal diff. `values` contains nothing else, so an
   * upload still in flight was never in the parent's value and cannot be something the parent
   * "dropped" — which is what keeps a `value` echo from cancelling work in progress, even after the
   * upload has been signed and therefore has an `uploadId`.
   *
   * Being a single action means the diff cannot emit a half-applied list — the reference's bare
   * `addCompletedUpload` loop ended a MobX batch per push, so `onChange` could fire mid-reconciliation.
   */
  applyValue(value: UploadValue[]): void {
    const byId = new Map(value.map((entry) => [entry.id, entry.name] as const));

    // completed uploads the parent dropped are removed; anything still working is left alone.
    // `slice()` because removeUpload splices the array we are iterating.
    for (const upload of this.uploads.slice()) {
      if (upload.status !== "COMPLETED" || upload.uploadId === undefined) continue;
      if (!byId.has(upload.uploadId)) this.removeUpload(upload);
    }

    // a rehydrated upload's name belongs to the parent; a picked File's name belongs to the File
    for (const upload of this.uploads) {
      if (!(upload instanceof CompletedUploadModel)) continue;
      const name = byId.get(upload.uploadId);
      if (name !== undefined && name !== upload.name) upload.setName(name);
    }

    const present = new Set(this.uploads.flatMap((upload) => upload.uploadId ?? []));
    for (const [id, name] of byId) {
      if (!present.has(id)) this.addCompletedUpload({ id, name });
    }

    this.pump();
  }

  /**
   * Remove an upload. A file that started server-side but never completed is cancelled through
   * `config.cancelUpload`; a completed one is reported to `config.onRemove`.
   */
  removeUpload(upload: Upload): void {
    const index = this.uploads.indexOf(upload);
    if (index === -1) return;
    this.uploads.splice(index, 1);

    const value = upload.value;
    upload.dispose();

    if (
      upload instanceof FileModel &&
      upload.uploadId !== undefined &&
      upload.status !== "COMPLETED"
    ) {
      // only when there is actually something server-side to abort — the reference called this
      // unconditionally, including for files that never got an id
      try {
        const result = this.config.cancelUpload?.(upload);
        void Promise.resolve(result).catch((e: unknown) => {
          this.reportError(toUploadError(e, "REQUEST", { fileName: upload.name }), upload);
        });
      } catch (e: unknown) {
        this.reportError(toUploadError(e, "REQUEST", { fileName: upload.name }), upload);
      }
    } else if (value) {
      this.config.onRemove?.(value, this);
    }

    this.pump();
  }

  /** Remove every upload, of either kind, through the one `removeUpload` path. */
  clear(): void {
    // slice() because removeUpload splices the array we are iterating
    for (const upload of this.uploads.slice()) {
      this.removeUpload(upload);
    }
  }

  /** Retry every failed upload. */
  retryAll(): void {
    for (const file of this.files) {
      if (file.status === "FAILED") file.retry();
    }
  }

  /** @internal Surface an error to `config.onError`. */
  reportError(error: UploadError, file?: FileModel): void {
    this.config.onError?.(error, file, this);
  }

  /** @internal The default retryable-status policy, overridable via `config.isRetryable`. */
  isRetryableError(error: UploadError): boolean {
    if (error.dev) return false;
    return isRetryableStatus(error.status ?? 0);
  }

  /**
   * The module's only scheduling primitive: inspect the current state, fill whatever concurrency
   * slots are free, return. Synchronous, idempotent, and safe to call at any time — nothing else in
   * the module starts network work.
   */
  pump(): void {
    // Re-entrancy is impossible through the normal async settle paths, but a synchronous throw out of
    // a consumer callback could produce one. Coalesce rather than drop.
    if (this.pumping) {
      this.pumpQueued = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpQueued = false;
        this.pumpOnce();
      } while (this.pumpQueued);
    } finally {
      this.pumping = false;
    }
  }

  private addFile(file: File): void {
    // The cap is checked before `validate` because it is structural rather than a policy about this
    // particular file: once the field is full the file is refused whatever else is true of it.
    if (this.full) {
      this.reportError(
        new UploadError("REJECTED", {
          fileName: file.name,
          message:
            this.maxFiles === 1
              ? `Only one file can be uploaded.`
              : `No more than ${this.maxFiles} files can be uploaded.`,
        }),
        undefined,
      );
      return;
    }

    const rejection = this.config.validate?.(file, this);
    if (rejection) {
      // a refused file never enters `uploads`, so it can't show up as a failed row. onError is the
      // only channel it has — the reference dropped it silently.
      this.reportError(
        new UploadError("REJECTED", { fileName: file.name, message: rejection }),
        undefined,
      );
      return;
    }
    this.uploads.push(new FileModel(this, { file }));
  }

  /**
   * One scheduling pass. The order is load-bearing:
   *
   * 1. `settleFiles` advances files whose parts are done (or one of which failed), releasing slots —
   *    so a freed slot is reused in this same pass rather than the next one.
   * 2. `startPendingFiles` signs files, creating the parts pass 3 needs.
   * 3. `startQueuedParts` fills the part slots.
   */
  private pumpOnce(): void {
    if (!this.active) return;
    this.settleFiles();
    this.startPendingFiles();
    this.startQueuedParts();
  }

  /** `UPLOADING` -> `FAILED` / `COMPLETED` / `COMPLETING`, driven by part aggregates. */
  private settleFiles(): void {
    for (const file of this.files) {
      if (file.status !== "UPLOADING") continue;

      // one failed part fails the file; the part's own error carries the status and cause
      const failed = file.failedParts[0];
      if (failed) {
        file.fail(failed.error ?? new UploadError("PART", { fileName: file.name }));
        continue;
      }

      // vacuously true for a zero-part file, which is how a zero-byte upload completes
      if (!file.partsComplete) continue;

      if (this.config.completeUpload) {
        file.startComplete();
      } else {
        file.complete();
      }
    }
  }

  /**
   * `PENDING` -> `REQUESTING`.
   *
   * A file is signed only when the already-signed work can't keep the part pipeline busy without it.
   * Counting `requestingFiles` is what makes this self-limiting: without that term, a hundred picked
   * files would all sign on the first tick (none has produced parts yet), which is exactly what a
   * backend's pending-upload limit rejects. With it, signing stays one step ahead of the pipeline —
   * so the signing round trip overlaps the tail of the previous file and there is no bubble — while
   * the number of signed-but-unfinished uploads stays near `concurrency`.
   */
  private startPendingFiles(): void {
    let prospective =
      this.activeParts.length + this.queuedParts.length + this.requestingFiles.length;
    let pending = this.pendingUploads.length;

    for (const file of this.files) {
      if (file.status !== "PENDING") continue;
      if (prospective >= this.concurrency) return;
      if (pending >= this.maxPendingUploads) return;

      // startRequest sets REQUESTING synchronously, before its first await, so the local accounting
      // below stays correct without re-reading the computeds
      file.startRequest();
      prospective++;
      pending++;
    }
  }

  /**
   * `QUEUED` -> `UPLOADING`, in `(file order, part index)` order.
   *
   * Files drain one at a time rather than interleaving: an upload is worthless to the consumer until
   * every part lands, so FIFO over indivisible jobs minimizes mean completion time — ten interleaved
   * files give you nothing usable until the end, ten drained gives you the first at a tenth of the
   * time. It also finalizes uploads earlier and wastes no bytes when a queued file is cancelled.
   */
  private startQueuedParts(): void {
    let active = this.activeParts.length;
    if (active >= this.concurrency) return;

    for (const file of this.files) {
      if (file.status !== "UPLOADING") continue;
      for (const part of file.parts) {
        if (active >= this.concurrency) return;
        if (part.status !== "QUEUED") continue;
        part.start();
        active++;
      }
    }
  }
}
