import {
  Action,
  createBrowserHistory,
  type History,
  type Location,
  type Transition,
} from "history";
import { action, computed, makeObservable, observable, reaction, runInAction, when } from "mobx";
import { flushSync } from "react-dom";
import { redirectFailed, RouterError } from "./errors";
import { makeErrorRoute, matchRoute } from "./make-routes";
import { LOADING_DELAY_MS } from "./outlet";
import { Redirect } from "./redirect";
import type { Route } from "./route";
import type {
  BlockedNavigation,
  Component,
  MobxRouterConfig,
  NavigateOptions,
  NavigationBlocker,
  Obj,
  RoutePath,
  RouteTarget,
  Routes,
} from "./types";
import { resolvePath } from "./util";

/**
 * How many redirects one navigation may chain through before the router
 * calls it a loop. Every hop is a full match-and-guard cycle, so this is
 * also how long a looping app spins before it says so — kept well above any
 * plausible real chain (one or two hops) and well below "the tab is stuck".
 */
const MAX_REDIRECTS = 10;

/** @internal one `block()` registration: when it applies, and what it decides. */
interface BlockerEntry {
  when: () => boolean;
  blocker: NavigationBlocker;
}

export interface MobxRenderSegment {
  segment: string;
  component: Component;
  props?: Obj;
}

/** Narrows a freshly matched route to the value `target` publishes. */
const toTarget = (route: Route, pathname: string): RouteTarget => ({
  pathname,
  pattern: route.pattern,
  params: { ...route.params },
  levels: route.levels.map((level) => level.level),
});

/**
 * Whether `path` addresses `segments`, a `:param` in `path` matching any
 * value. Shared by `doesPathMatch` and `doesTargetMatch` so the two can only
 * differ in which clock they read.
 */
const matchesSegments = (path: string, segments: string[], exact?: boolean): boolean => {
  const parts = path.slice(1).split("/");

  return (
    parts.every((part, i) => part === segments[i] || part.startsWith(":")) &&
    segments.length >= parts.length &&
    (!exact || parts.length === segments.length)
  );
};

export class RouterStore {
  readonly history: History;
  readonly viewTransitions: boolean;

  routesDef?: Routes;

  /**
   * The current URL. Updates the **instant** a navigation starts, before
   * guards and loaders run.
   *
   * `activeRoute` — and so `pathParams`, `activeSegments` and
   * `doesPathMatch` — commits only once the navigation lands. The two
   * therefore disagree for the whole duration of a navigation, and combining
   * them silently mixes clocks: interpolating `pathParams` (old) into a test
   * against `location.pathname` (new) is wrong for exactly as long as the
   * navigation takes. Use {@link target} for a matched view of the
   * destination that is available immediately.
   */
  location!: Location;

  /**
   * The route on screen. Commits after guards **and** loaders resolve, so it
   * lags `location` for the duration of a navigation — see the note there.
   */
  activeRoute: Route | undefined;

  /**
   * The route being matched, guarded and loaded. Set for the duration of
   * a navigation and cleared when it lands. `activeRoute` keeps rendering
   * the previous page while this is set, so navigation never blanks the
   * screen — see {@link isNavigating}.
   *
   * Assigned only once guards have resolved, because it gates rendering. For
   * the destination as soon as it is *known*, use {@link target}.
   */
  pendingRoute: Route | undefined;

  /** Backs {@link target}; written at match time, never cleared. */
  private matchedTarget: RouteTarget | undefined;

  /**
   * Navigation-scoped state, tracked from the first line of a navigation
   * rather than derived from `pendingRoute`, so both span the guard phase.
   * See `beginNavigation`.
   */
  private navigating = false;
  private navigationSlow = false;
  private slowTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Redirect hops taken since the last navigation landed. Reset on landing,
   * so it measures one chain rather than session history.
   */
  private redirects = 0;

  /**
   * Registered navigation blockers, in registration order (a `Set` iterates
   * by insertion). See {@link block}.
   */
  private readonly blockers = new Set<BlockerEntry>();

  /**
   * State of the single `history.block` blocker that covers pops — its
   * disposer while armed, the one-shot listener that re-arms it after a
   * transition has been let through, and whether a handler is currently
   * deciding about one. See {@link syncHistoryBlocker}.
   */
  private unblockHistory: (() => void) | undefined;
  private stopRearm: (() => void) | undefined;
  private deciding = false;

  get search(): URLSearchParams {
    return new URLSearchParams(this.location?.search);
  }

  get query(): Record<string, string> {
    return Object.fromEntries(this.search);
  }

  get pathParams(): Record<string, string> {
    return { ...this.activeRoute?.params };
  }

  get activeSegments(): string[] {
    return this.activeRoute?.path.split("/") ?? [];
  }

  /**
   * Where navigation is headed, as soon as the matcher knows — before guards
   * and loaders, and so well before `activeRoute` swaps. When nothing is in
   * flight this is the active route, so consumers never branch on navigation
   * state: `target.pattern` answers "which route is, or is about to be,
   * on screen".
   *
   * Compare `pattern`s rather than interpolating params into a path — that
   * is the comparison that mixes the `location` and `activeRoute` clocks.
   *
   * ```tsx
   * const active = tabs.find((tab) => tab.to === router.target?.pattern);
   * ```
   *
   * Holds its previous value when a URL produces no match, rather than
   * blanking: a `[REDIRECT]` leaf throws instead of matching, and clearing
   * would flicker for exactly the one hop before the redirect's own match
   * lands. The same applies to a `NOT_FOUND` or a rejected guard — the error
   * route commits through `activeRoute`, and `target` keeps naming the last
   * route that matched. So this is not "the route on screen": after a failed
   * navigation the two differ until the next successful match.
   *
   * `undefined` only before the first successful match of the session.
   */
  get target(): RouteTarget | undefined {
    return this.matchedTarget;
  }

  private get targetSegments(): string[] {
    const pathname = this.target?.pathname;
    return pathname === undefined ? [] : pathname.replace(/^\//, "").split("/");
  }

  /**
   * `true` from the first moment of a navigation until it lands, guard
   * phase included — the honest answer to "is something in flight".
   *
   * Undebounced: it flips for every navigation however fast, so an
   * indicator rendered straight off it will flicker. Use it for logic, and
   * {@link isSlowNavigation} or {@link isLoading} for pixels. For the
   * narrower question "is a route currently loading", check `pendingRoute`,
   * which is only assigned once guards have resolved.
   */
  get isNavigating(): boolean {
    return this.navigating;
  }

  /**
   * `true` whenever a loading indicator is warranted *anywhere*: a
   * navigation has been in flight longer than `LOADING_DELAY_MS` (guards
   * included), or a cold load's `[LOADING]` component is on screen
   * (including through the minimum-duration hold). Debounced, so quick
   * navigations never flip it.
   *
   * Use this for a layout progress bar that should stay visible alongside
   * a cold load's `[LOADING]` skeleton. For a bar that yields to the
   * skeleton instead, use {@link isSlowNavigation}.
   */
  get isLoading(): boolean {
    // navigationSlow covers the whole in-flight window; activeRoute's own
    // flag covers the cold-load hold, which outlives the navigation itself
    return this.navigationSlow || !!this.pendingRoute?.isLoading || !!this.activeRoute?.isLoading;
  }

  /**
   * `true` when a navigation has been slow enough to be worth showing
   * *and* there is already a page on screen to show it over — the usual
   * signal for a layout-level progress bar.
   *
   * Measured from the start of the navigation, so a slow `[GUARD]` counts
   * toward it just as a slow `[LOAD]` does, and a navigation made slow by
   * both phases together still trips it.
   *
   * Excludes the cold load, where the pending route's `[LOADING]`
   * component is on screen instead, so a bar driven off this is mutually
   * exclusive with `[LOADING]`. Use {@link isLoading} if you want both at
   * once.
   */
  get isSlowNavigation(): boolean {
    return this.navigationSlow && this.activeRoute !== undefined;
  }

  constructor(config?: MobxRouterConfig) {
    makeObservable<
      RouterStore,
      "navigating" | "navigationSlow" | "matchedTarget" | "targetSegments"
    >(this, {
      location: observable.ref,
      activeRoute: observable.ref,
      pendingRoute: observable.ref,
      matchedTarget: observable.ref,
      navigating: observable,
      navigationSlow: observable,

      search: computed,
      pathParams: computed,
      activeSegments: computed,
      target: computed,
      targetSegments: computed,
      isNavigating: computed,
      isLoading: computed,
      isSlowNavigation: computed,

      setLocation: action,
    });

    this.history = config?.history ?? createBrowserHistory();
    this.viewTransitions = config?.viewTransitions ?? true;
  }

  /**
   * Wires the router to its history and starts the first navigation,
   * resolving when that navigation lands — the same guarantee
   * {@link navigate} gives, including any redirect the initial URL runs
   * through. Await it to hand off from a boot screen, or to hold a test
   * until there is a route to assert on; ignore it to let `[SPLASH]` and
   * `[LOADING]` cover the wait, which is the usual case.
   */
  initialize(routesDef: Routes): Promise<void> {
    this.routesDef = routesDef;
    this.history.listen((data) => {
      void this.setLocation(data.location);
    });

    void this.setLocation(this.history.location);

    // `setLocation` has already claimed the navigation clock synchronously
    // — it only awaits once matching is done — so there is no window here
    // in which `settled()` could see an idle router and resolve early.
    return this.settled();
  }

  /**
   * Whether `path` matches the route **on screen**. Lags a navigation in
   * flight, because it reads `activeSegments`; use {@link doesTargetMatch} for
   * the destination. A `:param` segment in `path` matches any value.
   */
  doesPathMatch<P extends RoutePath>(path: P, exact?: boolean): boolean {
    return matchesSegments(path, this.activeSegments, exact);
  }

  /**
   * {@link doesPathMatch} against {@link target} instead of the active route,
   * so it answers for the destination the moment a navigation starts.
   *
   * A separate method rather than an option on `doesPathMatch`: which clock a
   * call site means is worth stating at the call site.
   */
  doesTargetMatch<P extends RoutePath>(path: P, exact?: boolean): boolean {
    return matchesSegments(path, this.targetSegments, exact);
  }

  /**
   * Navigates to `options`, resolving `true` once the navigation has
   * **landed** — or `false` as soon as a {@link block}er declines it.
   *
   * Landing is the end of the whole chain, not this hop: guards, loaders,
   * any redirect they throw, and the `activeRoute` swap (view transition
   * included). Await it to run a side effect against the page that actually
   * ended up on screen.
   *
   * ```ts
   * await router.navigate({ to: "/orders/:id", params: { id } });
   * announce(`Now viewing ${router.target?.pathname}`);
   * ```
   *
   * Resolves rather than rejects when a navigation fails. A rejected guard,
   * a `NOT_FOUND` or a throwing loader commits the `[ERROR]` route, which is
   * a landing like any other — the caller's "after navigation" work usually
   * still wants to run. Read `activeRoute.error`, or compare `target.pattern`
   * against where you meant to go, when the distinction matters. A
   * navigation skipped as redundant (already at that URL, no `state`)
   * resolves immediately, and counts as landing.
   *
   * `false` means only that *this* call did not navigate. A blocker that
   * saves and then lets the user leave is expected to return `true` and land
   * normally; `false` is the "stay here" answer. See {@link block}.
   *
   * An unresolvable `to` — a `:param` left unfilled — still throws
   * *synchronously*, because that is a caller bug rather than a navigation
   * outcome, and because the redirect path below depends on catching it.
   *
   * A redirect loop resolves too. Guards that redirect to each other would
   * otherwise chain forever and leave this promise pending for the life of
   * the page — see {@link redirectLoop}, which cuts the chain and lands an
   * `[ERROR]` route instead. A guard that calls `navigate()` in a cycle
   * rather than throwing `redirect()` is *not* bounded: that is the app
   * driving navigation through the same public API a link click uses, and
   * the router cannot tell the two apart.
   *
   * What is awaited is "nothing is in flight" rather than this call
   * specifically, so a navigation superseded by another resolves when *that*
   * one lands. That is the only useful answer: once a redirect has replaced
   * the destination there is no separate completion for the original hop,
   * and a caller awaiting navigation wants the view it ends on.
   *
   * The router's state is committed when this resolves. React has re-rendered
   * too wherever a view transition ran, since the swap is flushed inside it;
   * without one the re-render is left on React's scheduler, so a test reading
   * the DOM still needs its usual `act` / `waitFor`.
   */
  navigate<P extends RoutePath>(options: NavigateOptions<P>): Promise<boolean> {
    // resolved up front so an unresolvable `to` still throws synchronously
    // even with a blocker registered — deferring it past the handler's
    // `await` would turn a caller bug into a rejected promise
    const { pathname, search } = this.resolveLocation(options);

    const blockers = this.activeBlockers(pathname);
    if (!blockers.length) {
      return this.navigateNow(options);
    }

    return this.consultBlockers(blockers, {
      action: options.replace ? "REPLACE" : "PUSH",
      pathname,
      search: search ?? "",
      href: `${pathname}${search ?? ""}`,
    }).then((allowed) => (allowed ? this.navigateNow(options) : false));
  }

  /**
   * {@link navigate} without consulting blockers — the navigation the router
   * itself performs rather than one the user asked for.
   *
   * That is the `redirect()` path: a `[REDIRECT]` leaf or a redirect thrown
   * by a guard is the app's own decision about where a URL leads, not the
   * user leaving a page, so prompting for it would ask about a destination
   * the user never chose.
   *
   * Deliberately not `async`: `_navigate` throws synchronously for an
   * unresolvable path, and the redirect handler in `setLocation` catches it
   * with a plain `try`/`catch`. An async method would turn that throw into
   * a rejection and the [ERROR] route would never render.
   */
  private navigateNow<P extends RoutePath>(options: NavigateOptions<P>): Promise<boolean> {
    // navigating to the current URL attaches no new information — skip
    // the navigation (and its view transition) entirely so redundant
    // navigations (e.g. clicking an already-active link) cause no churn
    if (!options.state && this.isCurrentLocation(options)) {
      return Promise.resolve(true);
    }

    // the view transition is started around the route swap in
    // `applyRoute`, not here — see the note there
    this._navigate(options);

    return this.settled().then(() => true);
  }

  /**
   * Resolves once no navigation is in flight.
   *
   * Reads the same flag `isNavigating` publishes, which spans a redirect
   * chain unbroken: the follow-up navigation starts inside the previous
   * one's `catch`, before its `finally` runs, so `beginNavigation` hands the
   * clock straight over and the flag never dips between hops. The same holds
   * for a guard that calls `navigate()` itself, and for the trailing-slash
   * normalization in `setLocation`. That is what makes awaiting a navigation
   * mean the destination rather than the first redirect.
   */
  private async settled(): Promise<void> {
    await when(() => !this.navigating);
  }

  _navigate<P extends RoutePath>(options: NavigateOptions<P>): void {
    const location = this.resolveLocation(options);

    if (options.replace) {
      this.history.replace(location, options.state);
    } else {
      this.history.push(location, options.state);
    }
  }

  /**
   * Registers a navigation blocker: `when` says whether the block is live,
   * and `blocker` decides what to do about a navigation while it is.
   * Returns the disposer.
   *
   * ```ts
   * const dispose = router.block(
   *   () => designer.dirty,
   *   async () => {
   *     const choice = await confirmLeave(); // the app's own dialog
   *     if (choice === "save") await designer.save();
   *     return choice !== "stay";
   *   },
   * );
   * ```
   *
   * {@link useNavigationBlock} is this with the lifetime tied to a
   * component, which is the usual way to reach it.
   *
   * Only `true` proceeds — see {@link NavigationBlocker}. The handler may be
   * async, and `navigate()` stays pending until it settles, so a blocker
   * that saves before allowing the navigation still resolves the caller's
   * `await router.navigate(...)` once the destination lands.
   *
   * Covers every navigation that goes through {@link navigate} — `<Link>`
   * clicks, programmatic navigation, `search`-only navigations to another
   * path — the back and forward buttons, and closing or reloading the tab.
   *
   * **`when` must be derived from observables.** It is read at the moment a
   * navigation is proposed, but it also *drives registration*: the pop and
   * `beforeunload` halves of this depend on a `history.block` blocker being
   * armed exactly while the predicate holds, and that is kept in step by a
   * MobX reaction. A predicate reading something MobX cannot see — a ref, a
   * DOM query, a plain field — still blocks in-app navigation correctly, and
   * silently stops covering the back button.
   *
   * Does **not** cover:
   * - **The `redirect()` path.** See {@link navigateNow}.
   * - **A change that keeps the same pathname** — a query param, a history
   *   state update, or navigating to the current URL. The route on screen
   *   does not change, so there is nothing to leave; this is the same rule
   *   `setLocation` applies when it declines to re-match, and it is what
   *   keeps `setQueryParam` working while a block is live.
   * - **Writes straight to `router.history`.** A push there is let through
   *   rather than prompted about — see {@link onTransition}.
   *
   * There is no "navigate anyway" option, because the predicate is one: a
   * "discard and leave" action resets what it guards and then navigates, by
   * which point `when` is false.
   *
   * Registering more than one blocker is allowed. They are consulted in
   * registration order and the first to decline ends it, so two dirty models
   * prompt one after the other rather than both at once.
   *
   * What blocking a pop cannot do anything about: the URL moves and comes
   * back, so the address bar can flicker — `router.location` does not, since
   * a blocked pop never reaches the history listeners — and popping to an
   * entry the history library did not create cannot be blocked and fails
   * silently in production. A cancelled pop is also invisible to
   * `navigate()`, which was never called for it.
   */
  block(when: () => boolean, blocker: NavigationBlocker): () => void {
    const entry: BlockerEntry = { when, blocker };
    this.blockers.add(entry);

    // registration follows the predicate rather than the caller's lifetime:
    // `history.block` installs a `beforeunload` handler that calls
    // `preventDefault()` without ever consulting a blocker, so a
    // registration outliving its predicate would prompt "Leave site?" on a
    // clean form. That listener is also why the router keeps none of its
    // own — armed while the predicate holds is exactly the behaviour wanted.
    const stopReaction = reaction(
      () => entry.when(),
      () => this.syncHistoryBlocker(),
      {
        fireImmediately: true,
      },
    );

    // idempotent, so StrictMode's mount/unmount/mount and a caller that
    // disposes twice both land in the same place
    return () => {
      stopReaction();
      this.blockers.delete(entry);
      this.syncHistoryBlocker();
    };
  }

  /**
   * The blockers with a say in a navigation to `pathname`, in registration
   * order. Empty is the common case and costs one `Set` size check.
   */
  private activeBlockers(pathname: string): NavigationBlocker[] {
    // a same-pathname change leaves the route on screen — see `block`
    if (!this.blockers.size || pathname === this.location?.pathname) return [];

    return [...this.blockers].filter((entry) => entry.when()).map((entry) => entry.blocker);
  }

  /** Asks each blocker in turn, stopping at the first that says no. */
  private async consultBlockers(
    blockers: NavigationBlocker[],
    navigation: BlockedNavigation,
  ): Promise<boolean> {
    for (const blocker of blockers) {
      try {
        if ((await blocker(navigation)) !== true) return false;
      } catch (cause) {
        // staying is the safe failure: a dialog that crashed cannot have
        // told the user their work was about to be discarded
        console.error("A navigation blocker threw; staying at the current route.", cause);
        return false;
      }
    }

    return true;
  }

  /**
   * Arms a single `history.block` blocker while any predicate holds, and
   * disarms it when none does.
   *
   * One blocker rather than one per registration: `history.block` fans a
   * transition out to *every* blocker and gives each its own `retry()`, so
   * several would prompt at once and each retry would re-prompt the others.
   * Multiplexing here is what makes {@link consultBlockers} the only place
   * that decides.
   *
   * Called from the reaction in {@link block}, from disposal, and after a
   * transition has been let through.
   */
  private syncHistoryBlocker(): void {
    // a transition is on its way through; the re-arm in `passThrough` owns
    // the decision until it lands
    if (this.stopRearm) return;

    const armed = [...this.blockers].some((entry) => entry.when());
    if (armed === !!this.unblockHistory) return;

    if (!armed) {
      this.standDown();
      return;
    }

    this.unblockHistory = this.history.block((transition) => this.onTransition(transition));
  }

  /**
   * The one blocker history sees.
   *
   * `history.block` declines *every* transition while a blocker is
   * registered and never reads what the blocker returned, so most of what
   * arrives here has already been decided: a push {@link navigate} approved,
   * a `redirect()`, `setQueryParam`, the trailing-slash normalization and a
   * write straight to `router.history` all need nothing but a retry.
   * Prompting for them would ask twice about one navigation, or ask about
   * one the user never made.
   *
   * A pop is the one transition nothing else sees, and the only one this
   * consults blockers about.
   */
  private onTransition(transition: Transition): void {
    if (transition.action !== Action.Pop) {
      this.passThrough(transition);
      return;
    }

    // one decision at a time. The pop stays reverted, so the user is where
    // they were and can press back again once they have answered.
    if (this.deciding) return;

    const { pathname, search } = transition.location;
    const blockers = this.activeBlockers(pathname);
    if (!blockers.length) {
      this.passThrough(transition);
      return;
    }

    // where the retry counts from: `retry()` is a `go()` by the delta the
    // pop fired with, so anything that moves while the handler is deciding
    // leaves that delta addressing an entry the user did not ask for
    const from = this.history.location.key;
    this.deciding = true;

    void this.consultBlockers(blockers, {
      action: "POP",
      pathname,
      search,
      href: `${pathname}${search}`,
    })
      .then((allowed) => {
        if (allowed && this.history.location.key === from) {
          this.passThrough(transition);
        }
      })
      .finally(() => {
        this.deciding = false;
      });
  }

  /**
   * Lets a transition history has already declined through, and re-arms once
   * it lands.
   *
   * Standing down first is not optional: `retry()` re-enters the blocker,
   * and a pop's retry is a `go()` whose `popstate` arrives asynchronously —
   * so the blocker has to stay down until the retried navigation lands. The
   * one-shot listener is that "until", and re-arming through
   * {@link syncHistoryBlocker} means a predicate that went false in the
   * meantime leaves it down.
   *
   * If the retry never lands — a pop to an entry the history library did not
   * create cannot be blocked, and fails silently in production — the blocker
   * stays down, which is the same outcome as never having armed it.
   */
  private passThrough(transition: Transition): void {
    this.standDown();

    this.stopRearm = this.history.listen(() => {
      this.standDown();
      this.syncHistoryBlocker();
    });

    transition.retry();
  }

  private standDown(): void {
    this.unblockHistory?.();
    this.unblockHistory = undefined;
    this.stopRearm?.();
    this.stopRearm = undefined;
  }

  /**
   * The URL a set of navigation options addresses, as a single string.
   *
   * This is what the link components put on `href`, so a cmd-click lands on
   * exactly where a plain click would have navigated — `search` and
   * `preserveSearch` included. Reads {@link search} when preserving, so it
   * re-derives as the current query changes.
   */
  resolveHref<P extends RoutePath>(options: NavigateOptions<P>): string {
    const { pathname, search } = this.resolveLocation(options);
    return `${pathname}${search ?? ""}`;
  }

  private resolveLocation<P extends RoutePath>(
    options: NavigateOptions<P>,
  ): { pathname: string; search: string | undefined } {
    const { to, search = {}, preserveSearch, params } = options;

    const searchParams = search instanceof URLSearchParams ? search : new URLSearchParams(search);

    if (preserveSearch) {
      for (const [name, value] of this.search) {
        if (!searchParams.has(name)) {
          searchParams.set(name, value);
        }
      }
    }

    return {
      pathname: resolvePath(to, params),
      search: searchParams.size ? `?${searchParams.toString()}` : undefined,
    };
  }

  private isCurrentLocation<P extends RoutePath>(options: NavigateOptions<P>): boolean {
    if (!this.location) return false;

    const target = this.resolveLocation(options);
    return (
      target.pathname === this.location.pathname && (target.search ?? "") === this.location.search
    );
  }

  setQueryParam(param: string, value: string): void {
    const params = new URLSearchParams(this.location.search);
    params.set(param, value);
    this.history.replace({ search: `?${params.toString()}` });
  }

  removeQueryParam(param: string): string | undefined {
    const params = new URLSearchParams(this.location.search);
    const value = params.get(param) ?? undefined;
    if (value !== undefined) {
      params.delete(param);
      this.history.replace({ search: params.size ? `?${params.toString()}` : "" });
    }
    return value;
  }

  async setLocation(location: Location): Promise<void> {
    if (!this.routesDef) return;

    // TODO: this should not be the responsibility of mobx-router
    // and should really be handled server-side
    if (location.pathname !== "/" && location.pathname.endsWith("/")) {
      this.history.replace({ ...location, pathname: location.pathname.slice(0, -1) });
      return;
    }

    // a same-pathname change (query params, history state) can't affect
    // which route matches, its guards, or its loaders (none of which can
    // observe search params) — update the observable location without
    // rebuilding the route, so query-param changes don't refetch loaders
    // or replace activeRoute. Also guards against restarting a match for
    // a pathname that a still-pending navigation is already resolving.
    if ((this.activeRoute || this.pendingRoute) && this.location?.pathname === location.pathname) {
      this.location = location;
      return;
    }

    this.location = location;

    // a cold load has no previous page to preserve, so the pending route
    // renders and its [LOADING] components are on screen — the only case
    // where holding a just-shown indicator is worth delaying content for
    const cold = !this.activeRoute;

    // starts before guards, so both isNavigating and isSlowNavigation span
    // the guard phase
    const settle = this.beginNavigation();

    let matchedRoute: Route | undefined;
    try {
      const matched = matchRoute(location.pathname, this.routesDef);
      matchedRoute = matched;

      // Published before guards run — the point of `target` is that the
      // destination is known here and nothing else exposes it until the swap.
      // No staleness check is needed: matching is synchronous and there is no
      // await between assigning `this.location` above and this write, so
      // concurrent navigations cannot interleave and the newest always wins.
      runInAction(() => {
        this.matchedTarget = toTarget(matched, location.pathname);
      });

      await matchedRoute.guard();

      // navigating within a guard function
      // is essentially a redirect
      if (this.isStale(location)) {
        return;
      }

      runInAction(() => {
        this.pendingRoute = matchedRoute;
      });

      await matchedRoute.load({ hold: cold });

      // another navigation started while this one was loading — it owns
      // the swap now, and its own pendingRoute assignment has replaced ours
      if (this.isStale(location)) {
        return;
      }

      await this.applyRoute(() => {
        this.activeRoute = matchedRoute;
        this.pendingRoute = undefined;
      });
    } catch (e) {
      let thrown: unknown = e;

      if (thrown instanceof Redirect) {
        const loop = this.redirectLoop(location.pathname);

        if (loop) {
          // carries the Redirect's own origin so the loop renders under the
          // same [ERROR] a failure at that level would have, exactly as
          // `redirectFailed` does for the unresolvable case
          loop.state = thrown.state;
          loop.depth = thrown.depth;
          thrown = loop;
        } else {
          try {
            // a redirect replaces by default. The URL that redirected renders
            // nothing of its own, so leaving it in history traps Back: it
            // resolves to the same redirect and throws the user forward again.
            // An explicit `replace: false` on the redirect still wins.
            // not awaited: the caller's own `settled()` already spans this
            // hop, and awaiting here would hold this navigation's `finally`
            // open behind a chain it no longer owns
            void this.navigateNow({ ...thrown.options, replace: thrown.options.replace ?? true });
            return;
          } catch (cause) {
            // a redirect that can't be carried out — most often a `to` whose
            // `:params` weren't filled — is a routing failure like any other.
            // Falling through renders it via [ERROR] instead of escaping as an
            // unhandled rejection out of the history listener, where nothing
            // would catch it and the screen would keep the previous page.
            thrown = redirectFailed(cause, location.pathname, thrown);
          }
        }
      }

      // navigating within a guard before it threw — treat as a redirect
      if (this.isStale(location)) {
        return;
      }

      const error =
        thrown instanceof RouterError
          ? thrown
          : new RouterError("RENDER", { cause: thrown, path: location.pathname });
      console.error(error);

      const errorRoute = makeErrorRoute(error, location.pathname, matchedRoute);
      await this.applyRoute(() => {
        this.activeRoute = errorRoute;
        this.pendingRoute = undefined;
      });
      await errorRoute.load();
    } finally {
      // covers every exit: the swap, an error route, a stale bail, and the
      // redirect path — where the follow-up navigation has already claimed
      // the clock, so this call is a no-op
      settle();
    }
  }

  /**
   * Marks a navigation as in flight, starts its debounce clock, and returns
   * the cleanup that ends both.
   *
   * Both are tracked here — before guards run — rather than derived from
   * `pendingRoute`, which is only assigned once guards resolve. That is
   * what lets `isNavigating` mean "in flight" and `isSlowNavigation`
   * measure how long the user has actually been waiting. An outlet-level
   * clock cannot do the latter: outlets only begin loading after guards, so
   * a 250ms guard followed by a 250ms loader would show no indicator at all
   * despite half a second of waiting.
   */
  private beginNavigation(): () => void {
    // a newer navigation supersedes the previous clock, but deliberately
    // does not reset `navigationSlow` — if an indicator is already on
    // screen, a follow-up navigation should not blink it out and back in
    clearTimeout(this.slowTimer);
    runInAction(() => {
      this.navigating = true;
    });

    const timer = setTimeout(() => {
      if (this.slowTimer === timer) {
        runInAction(() => {
          this.navigationSlow = true;
        });
      }
    }, LOADING_DELAY_MS);
    this.slowTimer = timer;

    return () => {
      // a later navigation owns the clock now; leave its state alone
      if (this.slowTimer !== timer) return;
      clearTimeout(timer);
      this.slowTimer = undefined;
      // reaching here is the definition of a chain ending: a superseded hop
      // returns above, so only the navigation that actually landed clears it
      this.redirects = 0;
      runInAction(() => {
        this.navigating = false;
        this.navigationSlow = false;
      });
    };
  }

  /**
   * Counts a redirect hop away from `pathname`, and reports the chain as a
   * loop once it has taken too many.
   *
   * `makeRoutes` rejects a static `[REDIRECT]` cycle at build time, but it
   * gives up on the function form and cannot see a `redirect()` thrown from
   * a guard or loader at all. Those only reveal themselves by running, and
   * left alone they spin forever: every hop begins a fresh navigation before
   * the previous one's `finally`, so the clock is handed on indefinitely,
   * `isNavigating` never drops, and an awaited `navigate()` never settles —
   * which would silently swallow everything after it in an `async` caller.
   *
   * Deliberately a count and not a cycle search. Tracking the pathnames
   * visited would name the exact cycle in the message and catch a ping-pong
   * on its second hop rather than its tenth, but it only helps a chain that
   * repeats itself — one that keeps inventing pathnames still needs the
   * count — so it buys a better message at the price of being the second
   * way to answer a question that already has one.
   *
   * Either way the loop becomes a `RouterError` and ends the chain the way
   * any other routing failure does: `[ERROR]` renders and the promise
   * resolves, instead of a hung tab.
   */
  private redirectLoop(pathname: string): RouterError | undefined {
    if (++this.redirects <= MAX_REDIRECTS) return undefined;

    return new RouterError("REDIRECT", {
      message:
        `Redirect loop: ${MAX_REDIRECTS} redirects without landing, still going at '${pathname}'. ` +
        "A guard, loader or [REDIRECT] is sending this navigation in a circle.",
      path: pathname,
    });
  }

  /**
   * Whether another navigation has taken over since this one started.
   * Compared by pathname rather than `Location` identity: a query-param or
   * history-state change during a pending navigation replaces `location`
   * without re-matching, and must not cancel the navigation in flight.
   */
  private isStale(location: Location): boolean {
    return this.location?.pathname !== location.pathname;
  }

  /**
   * Commits a route swap, wrapped in a view transition where supported.
   *
   * The transition wraps **only** the swap. Wrapping the navigation as a
   * whole would freeze the page on its old snapshot for the entire guard
   * and load phase — a fetch's worth of unresponsive UI, with the loading
   * indicator unable to animate.
   *
   * `flushSync` removes a race rather than fixing an outright bug. The
   * browser captures the new snapshot at the first rendering opportunity
   * after the update callback settles; a bare MobX mutation schedules the
   * re-render on React's scheduler, which in practice usually lands
   * inside that window but is not guaranteed to (concurrent rendering may
   * yield). Flushing synchronously inside the callback makes the captured
   * frame deterministic.
   *
   * What the earlier implementation got wrong was placement, not
   * flushing: it wrapped `history.push`, so the callback returned before
   * guards had even run and both snapshots caught the same page. Verified
   * against real Chrome — that version animated exactly one frame.
   */
  private async applyRoute(swap: () => void): Promise<void> {
    const apply = () => runInAction(swap);
    const startViewTransition =
      typeof document !== "undefined" ? document.startViewTransition?.bind(document) : undefined;

    // A cold load has no previous page to animate away from, and its
    // visible change happens when outlets resolve rather than at the swap.
    if (!this.viewTransitions || !startViewTransition || !this.activeRoute) {
      apply();
      return;
    }

    const transition = startViewTransition(() => {
      flushSync(apply);
    });

    // `ready` rejects whenever the browser skips the animation — a second
    // navigation interrupting this one, a backgrounded tab, duplicate
    // view-transition-names. Routine, and the DOM update still happens.
    transition.ready.catch(() => {});

    // Awaited so the swap has landed before the navigation resolves.
    // Deliberately not `finished`: that waits out the animation, which
    // would make every navigation report as long as its transition.
    await transition.updateCallbackDone.catch(() => {});
  }
}
