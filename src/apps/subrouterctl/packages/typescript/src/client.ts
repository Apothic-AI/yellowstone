/**
 * The SubRouter client.
 *
 * The client mirrors the command line tool: the same operations, the same
 * namespaces, the same behaviour. It calls the Go library, so the cache, the
 * retries and the credential handling are exactly the ones of the tool.
 */

import { IPCTransport, type ProtocolRequest, type Transport } from "./transport.js";
import type {
  AccountInfo,
  ClientOptions,
  ListParams,
  LogEntry,
  LogFilters,
  Model,
  Page,
  Provider,
  Task,
  Token,
  TokenSpec,
} from "./types.js";

/** The options of a client. */
export interface SubRouterClientOptions extends ClientOptions {
  /** The helper binary, when it is not on the PATH. */
  binary?: string;
  /** A transport to use instead of the default one. */
  transport?: Transport;
}

/** Raised when the platform rejects a call. */
export class SubRouterAPIError extends Error {
  readonly status?: number;
  readonly kind: string;

  constructor(message: string, status?: number, kind = "error") {
    super(message);
    this.name = "SubRouterAPIError";
    this.status = status;
    this.kind = kind;
  }
}

/** Drops the parameters that were not given. */
function clean(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      out[key] = value;
    }
  }
  return out;
}

/** Maps the token shape of this package onto the protocol. */
function tokenParams(spec: TokenSpec): Record<string, unknown> {
  return clean({
    kind: spec.kind,
    name: spec.name,
    provider: spec.provider,
    providers: spec.providers,
    models: spec.models,
    model_routes: spec.modelRoutes,
    route_preference: spec.routePreference,
    sort_mode: spec.sortMode,
    load_balance: spec.loadBalance,
    include_cache_hit: spec.includeCacheHit,
    include_provider: spec.includeProvider,
    include_official: spec.includeOfficial,
    include_shared: spec.includeShared,
    official_max_discount: spec.officialMaxDiscount,
    shared_max_discount: spec.sharedMaxDiscount,
    official_channel: spec.officialChannel,
    unlimited: spec.unlimited,
    quota: spec.quota,
    quota_usd: spec.quotaUsd,
    expires: spec.expires,
    expires_in: spec.expiresIn,
    allow_ips: spec.allowIps,
    cross_group_retry: spec.crossGroupRetry,
    group: spec.group,
    key_group_id: spec.keyGroupId,
  });
}

/** Maps the list parameters onto the protocol. */
function listParams(params: ListParams): Record<string, unknown> {
  return clean({
    search: params.search,
    sort: params.sort,
    order: params.order,
    page: params.page,
    page_size: params.pageSize,
    limit: params.limit,
  });
}

/** Maps the log filters onto the protocol. */
function logParams(filters: LogFilters): Record<string, unknown> {
  return clean({
    from: filters.from,
    to: filters.to,
    type: filters.type,
    model: filters.model,
    group: filters.group,
    key_name: filters.keyName,
    request: filters.request,
    username: filters.username,
    search: filters.search,
    sort: filters.sort,
    order: filters.order,
    page: filters.page,
    page_size: filters.pageSize,
    limit: filters.limit,
  });
}

/** A group of operations on one part of the account. */
class Namespace {
  constructor(protected readonly client: SubRouterClient) {}
}

/** The credentials of this machine. */
export class Auth extends Namespace {
  /** The configured credentials and whether they work. */
  status(): Promise<Record<string, unknown>> {
    return this.client.call("auth.status");
  }
}

/** The account itself. */
export class Account extends Namespace {
  /** The profile and the wallet balance. */
  info(): Promise<AccountInfo> {
    return this.client.call("account.info");
  }

  /** Change the profile. */
  update(changes: {
    username?: string;
    displayName?: string;
    email?: string;
    group?: string;
  }): Promise<AccountInfo> {
    return this.client.call("account.update", clean({
      username: changes.username,
      display_name: changes.displayName,
      email: changes.email,
      group: changes.group,
    }));
  }

  /** The routing groups available to the account. */
  groups(): Promise<Record<string, unknown>> {
    return this.client.call("account.groups");
  }

  /** The model names the account may call. */
  models(): Promise<string[]> {
    return this.client.call("account.models");
  }

  /** The models of the smart router, with their prices. */
  subrouterModels(): Promise<Model[]> {
    return this.client.call("account.subrouterModels");
  }

  /** The top-up options of the site. */
  topupInfo(): Promise<Record<string, unknown>> {
    return this.client.call("account.topupInfo");
  }

  /** The wallet top-up records. */
  topups(params: ListParams = {}): Promise<Record<string, unknown>[]> {
    return this.client.call("account.topups", listParams(params));
  }

  /** Redeem a voucher code. */
  redeem(code: string): Promise<Record<string, unknown>> {
    return this.client.call("account.redeem", { code });
  }

  /** The wallet balance from the relay billing API. */
  balance(): Promise<Record<string, unknown>> {
    return this.client.call("account.balance");
  }

  /** The notifications of the account. */
  notifications(params: ListParams = {}): Promise<unknown> {
    return this.client.call("account.notifications", listParams(params));
  }

  /** The referral code, the invites and the earnings. */
  aff(): Promise<Record<string, unknown>> {
    return this.client.call("account.aff");
  }

  /** The status of the site and its announcements. */
  status(): Promise<Record<string, unknown>> {
    return this.client.call("account.status");
  }
}

/** The usage logs and the statistics. */
export class Usage extends Namespace {
  /**
   * The request logs.
   *
   * `from` and `to` take a date (`2026-01-31`), a relative age (`24h`,
   * `7d`) or a unix timestamp. Cached ranges are served from disk and only
   * the missing parts are fetched.
   */
  logs(filters: LogFilters = {}): Promise<LogEntry[]> {
    return this.client.call("usage.logs", logParams(filters));
  }

  /** One log entry, by request id. */
  log(requestId: string): Promise<LogEntry> {
    return this.client.call("usage.log", { request_id: requestId });
  }

  /** The totals of a range. */
  stats(filters: LogFilters = {}): Promise<Record<string, unknown>> {
    return this.client.call("usage.stats", logParams(filters));
  }

  /** The per-day quota usage. */
  data(range: { from?: string; to?: string } = {}): Promise<Record<string, unknown>[]> {
    return this.client.call("usage.data", clean({ from: range.from, to: range.to }));
  }

  /** The URL of the CSV export. */
  export(filters: LogFilters = {}): Promise<{ url: string }> {
    return this.client.call("usage.export", logParams(filters));
  }
}

/** The model API keys. */
export class Tokens extends Namespace {
  /**
   * The keys of the account.
   *
   * `kind` is `smart`, `official`, `shared`, `fixed` or `all`.
   */
  list(params: ListParams & { kind?: string } = {}): Promise<Page<Token>> {
    return this.client.call("token.list", clean({
      ...listParams(params),
      kind: params.kind,
    }));
  }

  /** One key. */
  show(id: number): Promise<Token> {
    return this.client.call("token.show", { id });
  }

  /** The four key kinds and what they route to. */
  types(): Promise<{ kind: string; group: string; routing: string }[]> {
    return this.client.call("token.types");
  }

  /**
   * Create a key.
   *
   * A fixed key needs the `provider` slug. A key is unlimited unless a
   * quota is given.
   */
  create(spec: TokenSpec): Promise<Token> {
    return this.client.call("token.create", tokenParams(spec));
  }

  /**
   * Change a key.
   *
   * A field that is not given keeps the value of the stored key.
   */
  update(id: number, spec: Partial<TokenSpec>): Promise<Token> {
    return this.client.call("token.update", clean({ id, ...tokenParams(spec as TokenSpec) }));
  }

  /** Delete a key. */
  delete(id: number): Promise<{ deleted: number }> {
    return this.client.call("token.delete", { id });
  }

  /** Delete several keys at once. */
  deleteBatch(ids: number[]): Promise<{ deleted: number[] }> {
    return this.client.call("token.deleteBatch", { ids });
  }
}

/** The model directory. */
export class Models extends Namespace {
  /** The marketplace models. */
  list(params: ListParams & { category?: string; providerId?: number } = {}): Promise<Page<Model>> {
    return this.client.call("model.list", clean({
      ...listParams(params),
      category: params.category,
      provider_id: params.providerId,
    }));
  }

  /** One model. */
  show(id: number): Promise<Model> {
    return this.client.call("model.show", { id });
  }

  /** The price list of every model. */
  pricing(): Promise<unknown> {
    return this.client.call("model.pricing");
  }

  /** The options the console offers when a model is picked. */
  options(): Promise<unknown> {
    return this.client.call("model.options");
  }

  /** The models of the smart router, with their prices. */
  routing(params: ListParams = {}): Promise<Page<Model>> {
    return this.client.call("model.routing", listParams(params));
  }
}

/** The provider directory. */
export class Providers extends Namespace {
  /** The providers of the marketplace. */
  list(params: ListParams = {}): Promise<Page<Provider>> {
    return this.client.call("provider.list", listParams(params));
  }

  /** One provider. */
  show(slug: string): Promise<Record<string, unknown>> {
    return this.client.call("provider.show", { slug });
  }

  /** The models of one provider. */
  models(slug: string, params: ListParams = {}): Promise<Page<Model>> {
    return this.client.call("provider.models", clean({ slug, ...listParams(params) }));
  }

  /** The providers this account is subscribed to. */
  subs(): Promise<Record<string, unknown>[]> {
    return this.client.call("provider.subs");
  }

  /** Subscribe to a provider. */
  subscribe(providerId: number): Promise<unknown> {
    return this.client.call("provider.subscribe", { provider_id: providerId });
  }

  /** Unsubscribe from a provider. */
  unsubscribe(providerId: number): Promise<{ unsubscribed: number }> {
    return this.client.call("provider.unsubscribe", { provider_id: providerId });
  }

  /** Subscribe to every provider. */
  subscribeAll(): Promise<unknown> {
    return this.client.call("provider.subscribeAll");
  }

  /** Unsubscribe from every provider. */
  unsubscribeAll(): Promise<{ unsubscribed: string }> {
    return this.client.call("provider.unsubscribeAll");
  }

  /** Read or change the subscription defaults. */
  subConfig(autoSubscribe?: boolean): Promise<unknown> {
    return this.client.call("provider.subConfig", clean({ auto_subscribe: autoSubscribe }));
  }

  /** The providers that share a subscription. */
  shared(): Promise<Provider[]> {
    return this.client.call("provider.shared");
  }
}

/** The shared subscription plans. */
export class Shared extends Namespace {
  /** The shared plans of the marketplace. */
  list(): Promise<Record<string, unknown>[]> {
    return this.client.call("shared.list");
  }

  /** Subscribe to a shared plan. */
  subscribe(planId: number): Promise<unknown> {
    return this.client.call("shared.subscribe", { plan_id: planId });
  }

  /** Cancel a shared plan. */
  cancel(planId: number): Promise<{ cancelled: number }> {
    return this.client.call("shared.cancel", { plan_id: planId });
  }
}

/** The subscription of the account. */
export class Subscriptions extends Namespace {
  /** The subscriptions and the billing preference. */
  list(): Promise<Record<string, unknown>> {
    return this.client.call("subscription.list");
  }

  /** The plans on offer. */
  plans(): Promise<Record<string, unknown>[]> {
    return this.client.call("subscription.plans");
  }

  /** Change the billing preference. */
  preference(changes: { priority?: string; wallet?: string }): Promise<Record<string, unknown>> {
    return this.client.call("subscription.preference", clean({
      priority: changes.priority,
      wallet: changes.wallet,
    }));
  }

  /**
   * Start a checkout.
   *
   * `provider` is `stripe`, `creem` or `epay`. The answer holds a URL to
   * open in a browser; no card data ever touches this client.
   */
  pay(provider: string, planId?: number, body?: Record<string, unknown>): Promise<unknown> {
    return this.client.call("subscription.pay", clean({
      provider,
      plan_id: planId,
      body,
    }));
  }
}

/** The asynchronous media tasks. */
export class Tasks extends Namespace {
  /** The tasks of the account. */
  list(params: ListParams & {
    action?: string;
    taskId?: string;
    from?: string;
    to?: string;
  } = {}): Promise<Page<Task>> {
    return this.client.call("task.list", clean({
      ...listParams(params),
      action: params.action,
      task_id: params.taskId,
      from: params.from,
      to: params.to,
    }));
  }

  /** One task. */
  show(taskId: string): Promise<Task> {
    return this.client.call("task.show", { task_id: taskId });
  }
}

/** The provider side of the account. */
export class Merchant extends Namespace {
  /** The provider profile, or an updated one. */
  me(body?: Record<string, unknown>): Promise<unknown> {
    return this.client.call("merchant.self", clean({ body }));
  }

  /** The channels of the provider. */
  channels(): Promise<unknown> {
    return this.client.call("merchant.channels");
  }

  /** Test a channel. */
  channelTest(id: number): Promise<unknown> {
    return this.client.call("merchant.channelTest", { id });
  }

  /** The models the provider lists. */
  models(params: ListParams = {}): Promise<unknown> {
    return this.client.call("merchant.models", listParams(params));
  }

  /** List a new model. */
  modelCreate(body: Record<string, unknown>): Promise<unknown> {
    return this.client.call("merchant.modelCreate", { body });
  }

  /** Change a listed model. */
  modelUpdate(id: number, body: Record<string, unknown>): Promise<unknown> {
    return this.client.call("merchant.modelUpdate", { id, body });
  }

  /** Change many listed models at once. */
  modelBatch(body: Record<string, unknown>, variant?: string): Promise<unknown> {
    return this.client.call("merchant.modelBatch", clean({ body, variant }));
  }

  /** Calculate a price change without saving it. */
  pricePreview(body: Record<string, unknown>): Promise<unknown> {
    return this.client.call("merchant.pricePreview", { body });
  }

  /** The earnings of the provider. */
  earnings(range: { from?: string; to?: string; summary?: boolean } = {}): Promise<unknown> {
    return this.client.call("merchant.earnings", clean({
      from: range.from,
      to: range.to,
      summary: range.summary,
    }));
  }

  /** The payout history. */
  payouts(): Promise<unknown> {
    return this.client.call("merchant.payouts");
  }

  /** Apply to become a provider. */
  register(body: Record<string, unknown>): Promise<unknown> {
    return this.client.call("merchant.register", { body });
  }
}

/** The distributor side of the account. */
export class Station extends Namespace {
  /** The station profile, or an updated one. */
  me(body?: Record<string, unknown>): Promise<unknown> {
    return this.client.call("station.self", clean({ body }));
  }

  /** The traffic, the revenue and the customer counts. */
  dashboard(): Promise<unknown> {
    return this.client.call("station.dashboard");
  }

  /** The customers of the station. */
  customers(params: ListParams & { keyword?: string } = {}): Promise<unknown> {
    return this.client.call("station.customers", clean({
      ...listParams(params),
      keyword: params.keyword,
    }));
  }

  /** The models the station lists. */
  models(params: ListParams = {}): Promise<unknown> {
    return this.client.call("station.models", listParams(params));
  }

  /** The models the station lists in the all-site mode. */
  globalModels(): Promise<unknown> {
    return this.client.call("station.globalModels");
  }

  /** The key groups of the station. */
  keyGroups(): Promise<unknown> {
    return this.client.call("station.keyGroups");
  }

  /** The shared subscriptions of the station. */
  shared(): Promise<unknown> {
    return this.client.call("station.shared");
  }

  /** The official channels the platform offers. */
  officialChannels(): Promise<unknown> {
    return this.client.call("station.officialChannels");
  }

  /** The packages the station sells. */
  packages(params: ListParams = {}): Promise<unknown> {
    return this.client.call("station.packages", listParams(params));
  }

  /** The logs of the station. */
  logs(filters: LogFilters = {}): Promise<unknown> {
    return this.client.call("station.logs", logParams(filters));
  }

  /** The earnings of the station. */
  earnings(range: { from?: string; to?: string; summary?: boolean } = {}): Promise<unknown> {
    return this.client.call("station.earnings", clean({
      from: range.from,
      to: range.to,
      summary: range.summary,
    }));
  }
}

/**
 * A client for the SubRouter account management API.
 *
 * Every option is optional. An option that is left out falls back to the
 * environment, then to the credential file at
 * `~/.subrouter/credentials.json`.
 *
 * ```ts
 * const client = new SubRouterClient();
 * const info = await client.account.info();
 * console.log(info.username);
 * ```
 */
export class SubRouterClient {
  /** The credentials of this machine. */
  readonly auth: Auth;
  /** The account itself. */
  readonly account: Account;
  /** The usage logs and the statistics. */
  readonly usage: Usage;
  /** The model API keys. */
  readonly tokens: Tokens;
  /** The model directory. */
  readonly models: Models;
  /** The provider directory. */
  readonly providers: Providers;
  /** The shared subscription plans. */
  readonly shared: Shared;
  /** The subscription of the account. */
  readonly subscriptions: Subscriptions;
  /** The asynchronous media tasks. */
  readonly tasks: Tasks;
  /** The provider side of the account. */
  readonly merchant: Merchant;
  /** The distributor side of the account. */
  readonly station: Station;

  private readonly options: ClientOptions;
  private readonly transport: Transport;
  private notices: string[] = [];

  constructor(options: SubRouterClientOptions = {}) {
    const { binary, transport, ...rest } = options;
    this.options = {};
    if (rest.baseUrl !== undefined) this.options.baseUrl = rest.baseUrl;
    if (rest.accessToken !== undefined) this.options.accessToken = rest.accessToken;
    if (rest.apiKey !== undefined) this.options.apiKey = rest.apiKey;
    if (rest.userId !== undefined) this.options.userId = rest.userId;
    if (rest.timeout !== undefined) this.options.timeout = rest.timeout;
    if (rest.cacheDir !== undefined) this.options.cacheDir = rest.cacheDir;
    if (rest.cacheTtl !== undefined) this.options.cacheTtl = rest.cacheTtl;
    if (rest.quotaPerUnit !== undefined) this.options.quotaPerUnit = rest.quotaPerUnit;

    this.transport = transport ?? new IPCTransport(binary);

    this.auth = new Auth(this);
    this.account = new Account(this);
    this.usage = new Usage(this);
    this.tokens = new Tokens(this);
    this.models = new Models(this);
    this.providers = new Providers(this);
    this.shared = new Shared(this);
    this.subscriptions = new Subscriptions(this);
    this.tasks = new Tasks(this);
    this.merchant = new Merchant(this);
    this.station = new Station(this);
  }

  /** The name of the transport in use. */
  get transportName(): string {
    return this.transport.name;
  }

  /** The messages of the last call, such as a cache notice. */
  get lastNotices(): string[] {
    return [...this.notices];
  }

  /**
   * Call any method of the protocol.
   *
   * This is the escape hatch for the endpoints that have no named method
   * yet.
   */
  async call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const request: ProtocolRequest = { method };
    if (params && Object.keys(params).length > 0) {
      request.params = params;
    }
    if (Object.keys(this.options).length > 0) {
      request.options = this.options;
    }

    const response = await this.transport.call(request);
    this.notices = response.notices ?? [];
    if (!response.ok) {
      const error = response.error ?? { message: "the call failed" };
      throw new SubRouterAPIError(error.message, error.status, error.type ?? "error");
    }
    return response.result as T;
  }

  /** Release the transport. */
  close(): void {
    this.transport.close();
  }
}
