import { computed, makeObservable } from "mobx";
import type {
  Bucket,
  BucketFilterOptions,
  BucketFilterProps,
  SetFilterValue,
} from "./filter.types";
import { SetFilter } from "./set-filter.model";
import { isBlank } from "./util";

/**
 * Build the projection a set of buckets describes: a value in, its bucket's label out.
 *
 * Ranges are `[min, max)` — inclusive lower, exclusive upper — so two adjacent buckets sharing a
 * number don't both claim it. The first matching bucket wins, which is what makes overlapping
 * definitions resolve by declaration order instead of being an error nobody can act on.
 *
 * Exported because the projection is useful without the filter: the same function labels a value
 * for a cell renderer or a chart legend, and reusing it is what keeps the table and the filter
 * agreeing on which bucket a score is in.
 */
export const bucketProjection =
  (buckets: readonly Bucket[]) =>
  (value: unknown): unknown => {
    // blanks stay blank — a missing score is not a low one, and `facetValues` gives it its own facet
    if (isBlank(value)) return value;
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return value;
    for (const bucket of buckets) {
      if (bucket.min !== undefined && n < bucket.min) continue;
      if (bucket.max !== undefined && n >= bucket.max) continue;
      return bucket.label;
    }
    // outside every bucket: hand back the raw value rather than inventing a label, so it shows up
    // in the facet list as itself instead of vanishing
    return value;
  };

/**
 * A set filter over named ranges — pick "B" rather than typing 80 to 90.
 *
 * A `SetFilter` whose domain is derived, and deliberately a subclass rather than a parallel type: a
 * bucket filter *is* a checkbox list, so everything already built for one applies — facets, counts,
 * blanks, match modes, serialization — and a popover narrowing by `instanceof SetFilter` renders it
 * with no changes.
 *
 * The column keeps showing and sorting the **raw** value; only the filter sees the buckets. That is
 * the point: a score column still sorts 84 above 81 inside the "B" bucket.
 *
 * ```ts
 * {
 *   key: "score",
 *   filter: () => new BucketFilter({
 *     buckets: [
 *       { label: "A", min: 90 },
 *       { label: "B", min: 80, max: 90 },
 *       { label: "C", min: 70, max: 80 },
 *       { label: "D", min: 60, max: 70 },
 *       { label: "F", max: 60 },
 *     ],
 *   }),
 * }
 * ```
 *
 * Note for server mode: the condition carries the selected *labels*, which a server can only act on
 * if it knows the same bucket definitions. Map them to ranges yourself when building the request, or
 * keep bucket filters client-side.
 */
export class BucketFilter extends SetFilter {
  readonly buckets: readonly Bucket[];

  /** Narrowed to {@link BucketFilterProps}; see {@link SetFilterProps}. */
  declare readonly props: BucketFilterProps;

  /** The bucket a value falls in, or `undefined` when it falls outside every one. */
  bucketOf(value: unknown): Bucket | undefined {
    const label = this.project?.(value);
    return this.buckets.find((b) => b.label === label);
  }

  constructor(options: BucketFilterOptions) {
    const buckets = [...options.buckets];
    super({
      // the labels *are* the domain, derived rather than declared twice so they cannot drift
      options: buckets.map((b) => b.label as SetFilterValue),
      project: bucketProjection(buckets),
      counts: options.counts,
      matchMode: options.matchMode,
      selected: options.selected,
      props: options.props,
    });
    this.buckets = buckets;

    makeObservable(this, { bucketOf: false, buckets: false, labels: computed });
  }

  /** The bucket labels, in declaration order — the same list `options` holds. */
  get labels(): SetFilterValue[] {
    return this.buckets.map((b) => b.label);
  }
}
