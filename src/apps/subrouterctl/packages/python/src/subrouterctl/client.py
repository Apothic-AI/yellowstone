"""The SubRouter client.

The client mirrors the command line tool: the same operations, the same
namespaces, the same behaviour. It calls the Go library, so the cache, the
retries and the credential handling are exactly the ones of the tool.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from .errors import APIError
from .transport import Transport, open_transport


def _clean(**kwargs: Any) -> Dict[str, Any]:
    """Drop the parameters that were not given."""
    return {key: value for key, value in kwargs.items() if value is not None}


class _Namespace:
    """A group of operations on one part of the account."""

    def __init__(self, client: "SubRouterClient") -> None:
        self._client = client


class SubRouterClient:
    """A client for the SubRouter account management API.

    Every argument is optional. An argument that is left out falls back to
    the environment, then to the credential file at
    ``~/.subrouter/credentials.json``.

    >>> client = SubRouterClient()
    >>> client.account.info()["username"]
    'demo-user'
    """

    def __init__(
        self,
        base_url: Optional[str] = None,
        access_token: Optional[str] = None,
        api_key: Optional[str] = None,
        user_id: Optional[int] = None,
        timeout: Optional[int] = None,
        cache_dir: Optional[str] = None,
        cache_ttl: Optional[float] = None,
        quota_per_unit: Optional[float] = None,
        transport: Any = "auto",
    ) -> None:
        self._options: Dict[str, Any] = {}
        if base_url is not None:
            self._options["base_url"] = base_url
        if access_token is not None:
            self._options["access_token"] = access_token
        if api_key is not None:
            self._options["api_key"] = api_key
        if user_id is not None:
            self._options["user_id"] = user_id
        if timeout is not None:
            self._options["timeout_seconds"] = int(timeout)
        if cache_dir is not None:
            self._options["cache_dir"] = cache_dir
        if cache_ttl is not None:
            self._options["cache_ttl_ms"] = int(cache_ttl * 1000)
        if quota_per_unit is not None:
            self._options["quota_per_unit"] = quota_per_unit

        self._transport: Transport = (
            transport if isinstance(transport, Transport) else open_transport(transport)
        )
        self._notices: List[str] = []

        self.auth = Auth(self)
        self.account = Account(self)
        self.usage = Usage(self)
        self.tokens = Tokens(self)
        self.models = Models(self)
        self.providers = Providers(self)
        self.shared = Shared(self)
        self.subscriptions = Subscriptions(self)
        self.tasks = Tasks(self)
        self.merchant = Merchant(self)
        self.station = Station(self)

    # -- the plumbing ------------------------------------------------------

    @property
    def transport(self) -> str:
        """The name of the transport in use: ``ffi`` or ``ipc``."""
        return self._transport.name

    @property
    def notices(self) -> List[str]:
        """The messages of the last call, such as a cache notice."""
        return list(self._notices)

    def call(self, method: str, params: Optional[Dict[str, Any]] = None) -> Any:
        """Call any method of the protocol.

        This is the escape hatch for the endpoints that have no named
        method yet.
        """
        request: Dict[str, Any] = {"method": method}
        if params:
            request["params"] = params
        if self._options:
            request["options"] = self._options

        response = self._transport.call(request)
        self._notices = list(response.get("notices") or [])
        if not response.get("ok"):
            error = response.get("error") or {}
            status = error.get("status")
            raise APIError(error.get("message") or "the call failed", status, response)
        return response.get("result")

    def close(self) -> None:
        """Release the transport."""
        self._transport.close()

    def __enter__(self) -> "SubRouterClient":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()


class Auth(_Namespace):
    """The credentials of this machine."""

    def status(self) -> Dict[str, Any]:
        """The configured credentials and whether they work."""
        return self._client.call("auth.status")


class Account(_Namespace):
    """The account itself."""

    def info(self) -> Dict[str, Any]:
        """The profile and the wallet balance."""
        return self._client.call("account.info")

    def update(self, username: Optional[str] = None, display_name: Optional[str] = None,
               email: Optional[str] = None, group: Optional[str] = None) -> Dict[str, Any]:
        """Change the profile."""
        return self._client.call("account.update", _clean(
            username=username, display_name=display_name, email=email, group=group))

    def groups(self) -> Dict[str, Any]:
        """The routing groups available to the account."""
        return self._client.call("account.groups")

    def models(self) -> List[str]:
        """The model names the account may call."""
        return self._client.call("account.models")

    def subrouter_models(self) -> List[Dict[str, Any]]:
        """The models of the smart router, with their prices."""
        return self._client.call("account.subrouterModels")

    def topup_info(self) -> Dict[str, Any]:
        """The top-up options of the site."""
        return self._client.call("account.topupInfo")

    def topups(self, page: Optional[int] = None, page_size: Optional[int] = None) -> List[Dict[str, Any]]:
        """The wallet top-up records."""
        return self._client.call("account.topups", _clean(page=page, page_size=page_size))

    def redeem(self, code: str) -> Dict[str, Any]:
        """Redeem a voucher code."""
        return self._client.call("account.redeem", {"code": code})

    def balance(self) -> Dict[str, Any]:
        """The wallet balance from the relay billing API."""
        return self._client.call("account.balance")

    def notifications(self, page: Optional[int] = None,
                      page_size: Optional[int] = None) -> Any:
        """The notifications of the account."""
        return self._client.call("account.notifications", _clean(page=page, page_size=page_size))

    def aff(self) -> Dict[str, Any]:
        """The referral code, the invites and the earnings."""
        return self._client.call("account.aff")

    def status(self) -> Dict[str, Any]:
        """The status of the site and its announcements."""
        return self._client.call("account.status")


class Usage(_Namespace):
    """The usage logs and the statistics."""

    def logs(self, from_: Optional[str] = None, to: Optional[str] = None,
             type: Optional[int] = None, model: Optional[str] = None,
             group: Optional[str] = None, key_name: Optional[str] = None,
             request: Optional[str] = None, username: Optional[str] = None,
             search: Optional[str] = None, sort: Optional[str] = None,
             order: Optional[str] = None, page: Optional[int] = None,
             page_size: Optional[int] = None, limit: Optional[int] = None) -> List[Dict[str, Any]]:
        """The request logs.

        ``from_`` and ``to`` take a date (``2026-01-31``), a relative age
        (``24h``, ``7d``) or a unix timestamp. Cached ranges are served from
        disk and only the missing parts are fetched.
        """
        return self._client.call("usage.logs", _clean(
            **{"from": from_}, to=to, type=type, model=model, group=group,
            key_name=key_name, request=request, username=username, search=search,
            sort=sort, order=order, page=page, page_size=page_size, limit=limit))

    def log(self, request_id: str) -> Dict[str, Any]:
        """One log entry, by request id."""
        return self._client.call("usage.log", {"request_id": request_id})

    def stats(self, from_: Optional[str] = None, to: Optional[str] = None,
              type: Optional[int] = None, model: Optional[str] = None,
              group: Optional[str] = None, key_name: Optional[str] = None) -> Dict[str, Any]:
        """The totals of a range."""
        return self._client.call("usage.stats", _clean(
            **{"from": from_}, to=to, type=type, model=model, group=group,
            key_name=key_name))

    def data(self, from_: Optional[str] = None, to: Optional[str] = None) -> List[Dict[str, Any]]:
        """The per-day quota usage."""
        return self._client.call("usage.data", _clean(**{"from": from_}, to=to))

    def export(self, from_: Optional[str] = None, to: Optional[str] = None,
               type: Optional[int] = None, model: Optional[str] = None,
               group: Optional[str] = None, key_name: Optional[str] = None) -> Dict[str, Any]:
        """The URL of the CSV export."""
        return self._client.call("usage.export", _clean(
            **{"from": from_}, to=to, type=type, model=model, group=group,
            key_name=key_name))


class Tokens(_Namespace):
    """The model API keys."""

    def list(self, kind: Optional[str] = None, search: Optional[str] = None,
             sort: Optional[str] = None, order: Optional[str] = None,
             page: Optional[int] = None, page_size: Optional[int] = None,
             limit: Optional[int] = None) -> Dict[str, Any]:
        """The keys of the account.

        The answer holds the page of keys under ``items``, the number of
        keys of the account under ``total`` and the page number under
        ``page``.

        ``kind`` is ``smart``, ``official``, ``shared``, ``fixed`` or
        ``all``.
        """
        return self._client.call("token.list", _clean(
            kind=kind, search=search, sort=sort, order=order, page=page,
            page_size=page_size, limit=limit))

    def show(self, id: int) -> Dict[str, Any]:
        """One key."""
        return self._client.call("token.show", {"id": id})

    def types(self) -> List[Dict[str, str]]:
        """The four key kinds and what they route to."""
        return self._client.call("token.types")

    def create(self, kind: str, name: Optional[str] = None,
               provider: Optional[str] = None, providers: Optional[List[str]] = None,
               models: Optional[List[str]] = None,
               model_routes: Optional[Dict[str, List[str]]] = None,
               route_preference: Optional[str] = None, sort_mode: Optional[str] = None,
               load_balance: Optional[bool] = None, include_cache_hit: Optional[bool] = None,
               include_provider: Optional[bool] = None, include_official: Optional[bool] = None,
               include_shared: Optional[bool] = None, official_max_discount: Optional[float] = None,
               shared_max_discount: Optional[float] = None, official_channel: Optional[int] = None,
               unlimited: Optional[bool] = None, quota: Optional[float] = None,
               quota_usd: Optional[float] = None, expires: Optional[int] = None,
               expires_in: Optional[str] = None, allow_ips: Optional[str] = None,
               cross_group_retry: Optional[bool] = None, group: Optional[str] = None,
               key_group_id: Optional[int] = None) -> Dict[str, Any]:
        """Create a key.

        ``kind`` is ``smart``, ``official``, ``shared`` or ``fixed``. A fixed
        key needs the ``provider`` slug. A key is unlimited unless a quota
        is given.
        """
        return self._client.call("token.create", _clean(
            kind=kind, name=name, provider=provider, providers=providers, models=models,
            model_routes=model_routes, route_preference=route_preference,
            sort_mode=sort_mode, load_balance=load_balance,
            include_cache_hit=include_cache_hit, include_provider=include_provider,
            include_official=include_official, include_shared=include_shared,
            official_max_discount=official_max_discount,
            shared_max_discount=shared_max_discount, official_channel=official_channel,
            unlimited=unlimited, quota=quota, quota_usd=quota_usd, expires=expires,
            expires_in=expires_in, allow_ips=allow_ips,
            cross_group_retry=cross_group_retry, group=group, key_group_id=key_group_id))

    def update(self, id: int, **changes: Any) -> Dict[str, Any]:
        """Change a key.

        A field that is not given keeps the value of the stored key.
        """
        params: Dict[str, Any] = {"id": id}
        params.update({key: value for key, value in changes.items() if value is not None})
        return self._client.call("token.update", params)

    def delete(self, id: int) -> Dict[str, Any]:
        """Delete a key."""
        return self._client.call("token.delete", {"id": id})

    def delete_batch(self, ids: List[int]) -> Dict[str, Any]:
        """Delete several keys at once."""
        return self._client.call("token.deleteBatch", {"ids": ids})


class Models(_Namespace):
    """The model directory."""

    def list(self, search: Optional[str] = None, category: Optional[str] = None,
             provider_id: Optional[int] = None, sort: Optional[str] = None,
             order: Optional[str] = None, page: Optional[int] = None,
             page_size: Optional[int] = None, limit: Optional[int] = None) -> Dict[str, Any]:
        """The marketplace models."""
        return self._client.call("model.list", _clean(
            search=search, category=category, provider_id=provider_id, sort=sort,
            order=order, page=page, page_size=page_size, limit=limit))

    def show(self, id: int) -> Dict[str, Any]:
        """One model."""
        return self._client.call("model.show", {"id": id})

    def pricing(self) -> Any:
        """The price list of every model."""
        return self._client.call("model.pricing")

    def options(self) -> Any:
        """The options the console offers when a model is picked."""
        return self._client.call("model.options")

    def routing(self, sort: Optional[str] = None, order: Optional[str] = None,
                limit: Optional[int] = None) -> Dict[str, Any]:
        """The models of the smart router, with their prices."""
        return self._client.call("model.routing", _clean(sort=sort, order=order, limit=limit))


class Providers(_Namespace):
    """The provider directory."""

    def list(self, search: Optional[str] = None, sort: Optional[str] = None,
             order: Optional[str] = None, page: Optional[int] = None,
             page_size: Optional[int] = None, limit: Optional[int] = None) -> Dict[str, Any]:
        """The providers of the marketplace."""
        return self._client.call("provider.list", _clean(
            search=search, sort=sort, order=order, page=page, page_size=page_size,
            limit=limit))

    def show(self, slug: str) -> Dict[str, Any]:
        """One provider."""
        return self._client.call("provider.show", {"slug": slug})

    def models(self, slug: str, page: Optional[int] = None,
               page_size: Optional[int] = None, limit: Optional[int] = None) -> Dict[str, Any]:
        """The models of one provider."""
        return self._client.call("provider.models", _clean(
            slug=slug, page=page, page_size=page_size, limit=limit))

    def subs(self) -> List[Dict[str, Any]]:
        """The providers this account is subscribed to."""
        return self._client.call("provider.subs")

    def subscribe(self, provider_id: int) -> Any:
        """Subscribe to a provider."""
        return self._client.call("provider.subscribe", {"provider_id": provider_id})

    def unsubscribe(self, provider_id: int) -> Dict[str, Any]:
        """Unsubscribe from a provider."""
        return self._client.call("provider.unsubscribe", {"provider_id": provider_id})

    def subscribe_all(self) -> Any:
        """Subscribe to every provider."""
        return self._client.call("provider.subscribeAll")

    def unsubscribe_all(self) -> Dict[str, Any]:
        """Unsubscribe from every provider."""
        return self._client.call("provider.unsubscribeAll")

    def sub_config(self, auto_subscribe: Optional[bool] = None) -> Any:
        """Read or change the subscription defaults."""
        return self._client.call("provider.subConfig", _clean(auto_subscribe=auto_subscribe))

    def shared(self) -> List[Dict[str, Any]]:
        """The providers that share a subscription."""
        return self._client.call("provider.shared")


class Shared(_Namespace):
    """The shared subscription plans."""

    def list(self) -> List[Dict[str, Any]]:
        """The shared plans of the marketplace."""
        return self._client.call("shared.list")

    def subscribe(self, plan_id: int) -> Any:
        """Subscribe to a shared plan."""
        return self._client.call("shared.subscribe", {"plan_id": plan_id})

    def cancel(self, plan_id: int) -> Dict[str, Any]:
        """Cancel a shared plan."""
        return self._client.call("shared.cancel", {"plan_id": plan_id})


class Subscriptions(_Namespace):
    """The subscription of the account."""

    def list(self) -> Dict[str, Any]:
        """The subscriptions and the billing preference."""
        return self._client.call("subscription.list")

    def plans(self) -> List[Dict[str, Any]]:
        """The plans on offer."""
        return self._client.call("subscription.plans")

    def preference(self, priority: Optional[str] = None,
                   wallet: Optional[str] = None) -> Dict[str, Any]:
        """Change the billing preference."""
        return self._client.call("subscription.preference", _clean(
            priority=priority, wallet=wallet))

    def pay(self, provider: str, plan_id: Optional[int] = None,
            body: Optional[Dict[str, Any]] = None) -> Any:
        """Start a checkout.

        ``provider`` is ``stripe``, ``creem`` or ``epay``. The answer holds a
        URL to open in a browser; no card data ever touches this client.
        """
        return self._client.call("subscription.pay", _clean(
            provider=provider, plan_id=plan_id, body=body))


class Tasks(_Namespace):
    """The asynchronous media tasks."""

    def list(self, action: Optional[str] = None, task_id: Optional[str] = None,
             from_: Optional[str] = None, to: Optional[str] = None,
             search: Optional[str] = None, sort: Optional[str] = None,
             order: Optional[str] = None, page: Optional[int] = None,
             page_size: Optional[int] = None, limit: Optional[int] = None) -> Dict[str, Any]:
        """The tasks of the account."""
        return self._client.call("task.list", _clean(
            action=action, task_id=task_id, **{"from": from_}, to=to, search=search,
            sort=sort, order=order, page=page, page_size=page_size, limit=limit))

    def show(self, task_id: str) -> Dict[str, Any]:
        """One task."""
        return self._client.call("task.show", {"task_id": task_id})


class Merchant(_Namespace):
    """The provider side of the account."""

    def me(self, body: Optional[Dict[str, Any]] = None) -> Any:
        """The provider profile, or an updated one."""
        return self._client.call("merchant.self", _clean(body=body))

    def channels(self) -> Any:
        """The channels of the provider."""
        return self._client.call("merchant.channels")

    def channel_test(self, id: int) -> Any:
        """Test a channel."""
        return self._client.call("merchant.channelTest", {"id": id})

    def models(self, page: Optional[int] = None, page_size: Optional[int] = None) -> Any:
        """The models the provider lists."""
        return self._client.call("merchant.models", _clean(page=page, page_size=page_size))

    def model_create(self, body: Dict[str, Any]) -> Any:
        """List a new model."""
        return self._client.call("merchant.modelCreate", {"body": body})

    def model_update(self, id: int, body: Dict[str, Any]) -> Any:
        """Change a listed model."""
        return self._client.call("merchant.modelUpdate", {"id": id, "body": body})

    def model_batch(self, body: Dict[str, Any], variant: Optional[str] = None) -> Any:
        """Change many listed models at once."""
        return self._client.call("merchant.modelBatch", _clean(body=body, variant=variant))

    def price_preview(self, body: Dict[str, Any]) -> Any:
        """Calculate a price change without saving it."""
        return self._client.call("merchant.pricePreview", {"body": body})

    def earnings(self, from_: Optional[str] = None, to: Optional[str] = None,
                 summary: bool = False) -> Any:
        """The earnings of the provider."""
        return self._client.call("merchant.earnings", _clean(
            **{"from": from_}, to=to, summary=summary or None))

    def payouts(self) -> Any:
        """The payout history."""
        return self._client.call("merchant.payouts")

    def register(self, body: Dict[str, Any]) -> Any:
        """Apply to become a provider."""
        return self._client.call("merchant.register", {"body": body})


class Station(_Namespace):
    """The distributor side of the account."""

    def me(self, body: Optional[Dict[str, Any]] = None) -> Any:
        """The station profile, or an updated one."""
        return self._client.call("station.self", _clean(body=body))

    def dashboard(self) -> Any:
        """The traffic, the revenue and the customer counts."""
        return self._client.call("station.dashboard")

    def customers(self, keyword: Optional[str] = None, page: Optional[int] = None,
                  page_size: Optional[int] = None) -> Any:
        """The customers of the station."""
        return self._client.call("station.customers", _clean(
            keyword=keyword, page=page, page_size=page_size))

    def models(self, page: Optional[int] = None, page_size: Optional[int] = None) -> Any:
        """The models the station lists."""
        return self._client.call("station.models", _clean(page=page, page_size=page_size))

    def global_models(self) -> Any:
        """The models the station lists in the all-site mode."""
        return self._client.call("station.globalModels")

    def key_groups(self) -> Any:
        """The key groups of the station."""
        return self._client.call("station.keyGroups")

    def shared(self) -> Any:
        """The shared subscriptions of the station."""
        return self._client.call("station.shared")

    def official_channels(self) -> Any:
        """The official channels the platform offers."""
        return self._client.call("station.officialChannels")

    def packages(self, page: Optional[int] = None, page_size: Optional[int] = None) -> Any:
        """The packages the station sells."""
        return self._client.call("station.packages", _clean(page=page, page_size=page_size))

    def logs(self, from_: Optional[str] = None, to: Optional[str] = None,
             limit: Optional[int] = None) -> Any:
        """The logs of the station."""
        return self._client.call("station.logs", _clean(
            **{"from": from_}, to=to, limit=limit))

    def earnings(self, from_: Optional[str] = None, to: Optional[str] = None,
                 summary: bool = False) -> Any:
        """The earnings of the station."""
        return self._client.call("station.earnings", _clean(
            **{"from": from_}, to=to, summary=summary or None))
