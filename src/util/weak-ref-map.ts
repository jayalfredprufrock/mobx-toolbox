/**
 * A map with strong keys and weak values: entries disappear on their own once nothing else
 * references the value. Useful as an identity map, where the point is to hand back the *same*
 * instance for a given key while it is still in use, without the map itself being the reason it
 * stays alive.
 *
 * ```ts
 * const cache = new WeakRefMap<number, UserModel>();
 * cache.add(user.id, user);
 * cache.get(user.id); // the same instance, until nothing holds it any more
 * ```
 *
 * Identity therefore lasts exactly as long as someone is holding the value. Once the last
 * reference goes, a later lookup misses and a fresh instance is built — which is unobservable,
 * since by definition nothing was holding the old one.
 */
export class WeakRefMap<K, V extends object> {
  private cacheMap = new Map<K, WeakRef<V>>();

  private finalizer = new FinalizationRegistry((key: K) => {
    // Double check the key hasn't been re-added since the finalizer was queued, so a freshly
    // set reference isn't deleted by the collection of the value it replaced.
    if (!this.get(key)) {
      this.cacheMap.delete(key);
    }
  });

  /** Store `value` under `key`, replacing any existing entry, and return it. */
  add(key: K, value: V): V {
    const cached = this.get(key);
    if (cached) {
      if (cached === value) return value;
      // Stop the outgoing value's finalizer from later deleting the incoming entry.
      this.finalizer.unregister(cached);
    }
    this.cacheMap.set(key, new WeakRef(value));
    this.finalizer.register(value, key, value);
    return value;
  }

  /** The live value for `key`, or `undefined` if absent or already collected. */
  get(key: K): V | undefined {
    return this.cacheMap.get(key)?.deref();
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  /**
   * Drop the entry for `key` immediately rather than waiting for collection. Use when the value
   * is known to be gone for good — a deleted record, say — so a later lookup builds a fresh
   * instance instead of reviving the old one.
   */
  delete(key: K): boolean {
    const cached = this.get(key);
    if (cached) this.finalizer.unregister(cached);
    return this.cacheMap.delete(key);
  }

  /** Forget everything. Values held elsewhere stay alive, they are just no longer identity-mapped. */
  clear(): void {
    for (const ref of this.cacheMap.values()) {
      const value = ref.deref();
      if (value) this.finalizer.unregister(value);
    }
    this.cacheMap.clear();
  }
}
