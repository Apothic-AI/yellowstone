/**
 * TypeScript client for the SubRouter account management API.
 *
 * The package talks to the Go library of `subrouterctl`, so the cache, the
 * retries and the credential handling are the ones of the command line tool.
 *
 * ```ts
 * import { SubRouterClient } from "subrouterctl";
 *
 * const client = new SubRouterClient();
 * const info = await client.account.info();
 * console.log(info.username);
 * ```
 */

export {
  Account,
  Auth,
  Merchant,
  Models,
  Providers,
  Shared,
  SubRouterAPIError,
  SubRouterClient,
  Subscriptions,
  Tasks,
  Tokens,
  Usage,
  type SubRouterClientOptions,
} from "./client.js";

export {
  IPCTransport,
  TransportError,
  resolveBinary,
  type ProtocolRequest,
  type ProtocolResponse,
  type Transport,
} from "./transport.js";

export type {
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
  TokenKind,
  TokenSpec,
} from "./types.js";
