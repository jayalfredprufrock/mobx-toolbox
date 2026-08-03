import { action, makeObservable, observable } from "mobx";
import type { UploadError } from "./errors";
import type { UploaderModel } from "./uploader.model";
import type { CompletedUploadConfig, FileStatus, UploadLike, UploadValue } from "./uploader.types";
import { getFileExtension, nextUploadKey } from "./uploader.util";

/**
 * An upload that already exists server-side, rehydrated from the controlled `value` — no blob, no
 * parts, nothing in flight.
 *
 * Implements `UploadLike` with literal answers (`status` is always `"COMPLETED"`, `progress` always
 * 100) so list UIs, `values`, `invalid` and `clear` treat it exactly like a `FileModel` and no
 * `instanceof` branch is needed anywhere.
 *
 * `name` is carried explicitly. The reference implementation derived it from the identifier with
 * `uploadKey.replace(/^.*[\\/]/, "")`, which only worked because that backend's client-facing id was
 * the bucket key; against an opaque id it renders the id itself and yields no extension.
 */
export class CompletedUploadModel implements UploadLike {
  readonly uploader: UploaderModel;
  readonly config: CompletedUploadConfig;
  /** Stable client identity for React keys; distinct from the server's `uploadId`. */
  readonly key: string = nextUploadKey();

  /** The parent owns this: a `value` update may rename an upload the uploader never uploaded. */
  private currentName: string;

  get uploadId(): string {
    return this.config.id;
  }

  get name(): string {
    return this.currentName;
  }

  get extension(): string {
    return getFileExtension(this.name);
  }

  get status(): FileStatus {
    return "COMPLETED";
  }

  get progress(): number {
    return 100;
  }

  get error(): UploadError | undefined {
    return undefined;
  }

  get value(): UploadValue {
    return { id: this.uploadId, name: this.name };
  }

  constructor(uploader: UploaderModel, config: CompletedUploadConfig) {
    this.uploader = uploader;
    this.config = config;
    this.currentName = config.name;

    makeObservable<this, "currentName">(this, {
      currentName: observable,
      setName: action,
    });
  }

  setName(name: string): void {
    this.currentName = name;
  }

  remove(): void {
    this.uploader.removeUpload(this);
  }

  /** No-op: there is nothing to arm. Present so the `Upload` union is uniform. */
  activate(): void {}

  /** No-op: no blob, no request, no timers. */
  dispose(): void {}
}
