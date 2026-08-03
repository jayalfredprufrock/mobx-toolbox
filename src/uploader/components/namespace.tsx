import { UploaderRoot } from "./uploader-root";
import { UploaderUploads } from "./uploader-uploads";

/**
 * Compound namespace for the uploader skeleton. Consumers compose these into their own closed
 * component (styles + defaults captured once), e.g. `<Uploader.Root><Uploader.Uploads>…`.
 */
export const Uploader = {
  Root: UploaderRoot,
  Uploads: UploaderUploads,
};
