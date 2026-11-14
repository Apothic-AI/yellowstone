/**
 * The shapes the SubRouter protocol returns.
 *
 * The fields the console does not always send are optional, so a response
 * that leaves one out still fits the type.
 */

/** The options of a client. */
export interface ClientOptions {
  /** The site to talk to, for example `https://subrouter.ai`. */
  baseUrl?: string;
  /** The system access token of the account. */
  accessToken?: string;
  /** The `sk-` relay key. */
  apiKey?: string;
  /** The numeric account id, which every management call needs. */
  userId?: number;
  /** The timeout of one request, in seconds. */
  timeout?: number;
  /** The directory of the on-disk cache. */
  cacheDir?: string;
  /** How long a cached response stays fresh, in milliseconds. */
  cacheTtl?: number;
  /** The quota units that are worth one dollar. */
  quotaPerUnit?: number;
}

/** The account profile. */
export interface AccountInfo {
  id: number;
  username: string;
  display_name: string;
  email: string;
  role: number;
  group: string;
  quota: number;
  used_quota: number;
  request_count: number;
  status: number;
  aff_code: string;
  aff_quota: number;
  inviter_id: number;
  created_time: number;
  [key: string]: unknown;
}

/** One model API key. */
export interface Token {
  id: number;
  user_id: number;
  name: string;
  key: string;
  status: number;
  created_time: number;
  accessed_time: number;
  expired_time: number;
  remain_quota: number;
  unlimited_quota: boolean;
  used_quota: number;
  model_limits_enabled: boolean;
  model_limits: string;
  allow_ips: string;
  group: string;
  cross_group_retry: boolean;
  load_balance_enabled: boolean;
  distributor_id: number;
  key_group_id: number;
  official_channel_id: number;
  official_key_max_discount: number;
  shared_subscription_max_discount: number;
  include_cache_hit_rate: boolean;
  include_provider_self: boolean;
  include_official_channels: boolean;
  include_shared_subscriptions: boolean;
  subrouter_providers: string;
  subrouter_model_providers: string;
  subrouter_model_price_limits: string;
  subrouter_sort_mode: string;
  subrouter_route_preference: string;
  [key: string]: unknown;
}

/** The four kinds of key. */
export type TokenKind = "smart" | "official" | "shared" | "fixed";

/** What a key needs to look like. */
export interface TokenSpec {
  kind: TokenKind;
  name?: string;
  /** The provider slug a fixed key is pinned to. */
  provider?: string;
  /** The providers a smart key may use. */
  providers?: string[];
  /** The models the key may call. An empty list means every model. */
  models?: string[];
  /** Models pinned to providers, for example `{ "gpt-5": ["acme"] }`. */
  modelRoutes?: Record<string, string[]>;
  routePreference?: string;
  sortMode?: string;
  loadBalance?: boolean;
  includeCacheHit?: boolean;
  includeProvider?: boolean;
  includeOfficial?: boolean;
  includeShared?: boolean;
  officialMaxDiscount?: number;
  sharedMaxDiscount?: number;
  officialChannel?: number;
  /** A key is unlimited unless a quota is given. */
  unlimited?: boolean;
  /** The quota in platform units. */
  quota?: number;
  /** The quota in dollars. */
  quotaUsd?: number;
  /** The expiry as a unix timestamp, or -1 for never. */
  expires?: number;
  /** The expiry as a duration, for example `30d` or `12h`. */
  expiresIn?: string;
  allowIps?: string;
  crossGroupRetry?: boolean;
  group?: string;
  keyGroupId?: number;
}

/** One usage log entry. */
export interface LogEntry {
  id: number;
  user_id: number;
  created_at: number;
  type: number;
  content: string;
  username: string;
  token_name: string;
  model_name: string;
  quota: number;
  prompt_tokens: number;
  completion_tokens: number;
  use_time: number;
  is_stream: boolean;
  channel: number;
  channel_name: string;
  token_id: number;
  group: string;
  ip: string;
  request_id: string;
  upstream_request_id: string;
  distributor_id: number;
  node_name: string;
  use_group: string;
  other: Record<string, unknown>;
  [key: string]: unknown;
}

/** One model of the marketplace. */
export interface Model {
  id: string;
  model_name: string;
  upstream_model: string;
  provider_id: string;
  provider_name: string;
  provider_slug: string;
  category: string;
  billing_mode: string;
  input_price: number;
  output_price: number;
  fixed_price: number;
  price_currency: string;
  context_length: number;
  status: string;
  rating: number;
  availability: number;
  avg_latency: number;
  median_ttft: number;
  cache_hit_rate: number;
  total_requests: number;
  total_tokens: number;
  [key: string]: unknown;
}

/** One provider of the marketplace. */
export interface Provider {
  id: string;
  slug: string;
  company_name: string;
  description: string;
  logo: string;
  status: string;
  verified: boolean;
  rating: number;
  availability: number;
  model_count: number;
  credit_score: number;
  [key: string]: unknown;
}

/** One asynchronous media task. */
export interface Task {
  id: string;
  task_id: string;
  platform?: string;
  action: string;
  status: string;
  progress: number;
  model: string;
  created_at: number;
  fail_reason?: string;
  [key: string]: unknown;
}

/** A page of a list. */
export interface Page<T> {
  items: T[];
  total: number;
  page?: number;
}

/** The filters of the log methods. */
export interface LogFilters {
  /** The start of the range: a date, a relative age or a timestamp. */
  from?: string;
  /** The end of the range. */
  to?: string;
  /** 0 is every type, 1 a top-up, 2 a call and 5 an error. */
  type?: number;
  model?: string;
  group?: string;
  keyName?: string;
  request?: string;
  username?: string;
  search?: string;
  sort?: string;
  order?: "asc" | "desc";
  page?: number;
  pageSize?: number;
  limit?: number;
}

/** The paging, search and sorting parameters of the list methods. */
export interface ListParams {
  search?: string;
  sort?: string;
  order?: "asc" | "desc";
  page?: number;
  pageSize?: number;
  limit?: number;
}
