package api

import (
	"context"
	"fmt"
	"sort"
	"strings"
)

// ---------------------------------------------------------------------------
// Provider subscriptions
// ---------------------------------------------------------------------------

// ListProviderSubscriptions returns the subscribed providers
// (GET /api/marketplace/subscriptions).
func (c *Client) ListProviderSubscriptions(ctx context.Context) ([]ProviderSubscription, error) {
	var out []ProviderSubscription
	if err := c.Get(ctx, "/api/marketplace/subscriptions", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// SubscribeProvider adds a provider to the routing sources
// (POST /api/marketplace/subscribe).
func (c *Client) SubscribeProvider(ctx context.Context, providerID int) (any, error) {
	var out any
	err := c.Post(ctx, "/api/marketplace/subscribe", map[string]any{"provider_id": providerID}, &out)
	if err != nil {
		return nil, err
	}
	return out, nil
}

// SubscribeAll adds every available provider and shared pool
// (POST /api/marketplace/subscribe-all).
func (c *Client) SubscribeAll(ctx context.Context) (any, error) {
	var out any
	if err := c.Post(ctx, "/api/marketplace/subscribe-all", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// UnsubscribeProvider removes one provider
// (DELETE /api/marketplace/subscribe/{provider_id}).
func (c *Client) UnsubscribeProvider(ctx context.Context, providerID int) error {
	return c.Delete(ctx, fmt.Sprintf("/api/marketplace/subscribe/%d", providerID), nil)
}

// UnsubscribeAll removes every provider and shared pool
// (DELETE /api/marketplace/subscriptions).
func (c *Client) UnsubscribeAll(ctx context.Context) error {
	return c.Delete(ctx, "/api/marketplace/subscriptions", nil)
}

// GetSubscriptionConfig returns the provider auto-subscribe settings
// (GET /api/marketplace/subscription-config).
func (c *Client) GetSubscriptionConfig(ctx context.Context) (*SubscriptionConfig, error) {
	var s SubscriptionConfig
	if err := c.Get(ctx, "/api/marketplace/subscription-config", nil, &s); err != nil {
		return nil, err
	}
	return &s, nil
}

// UpdateSubscriptionConfig changes the provider auto-subscribe settings
// (PUT /api/marketplace/subscription-config).
func (c *Client) UpdateSubscriptionConfig(ctx context.Context, body map[string]any) (*SubscriptionConfig, error) {
	var s SubscriptionConfig
	if err := c.Put(ctx, "/api/marketplace/subscription-config", body, &s); err != nil {
		return nil, err
	}
	return &s, nil
}

// ---------------------------------------------------------------------------
// Shared pool subscriptions
// ---------------------------------------------------------------------------

// ListSharedPlans returns the shared plans and subscription status
// (GET /api/shared-subscriptions/plans).
func (c *Client) ListSharedPlans(ctx context.Context) ([]SharedPlan, error) {
	var out []SharedPlan
	if err := c.Get(ctx, "/api/shared-subscriptions/plans", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// SubscribeSharedPlan subscribes to a shared pool plan
// (POST /api/shared-subscriptions/plans/{id}/subscribe).
func (c *Client) SubscribeSharedPlan(ctx context.Context, id int) (any, error) {
	var out any
	err := c.Post(ctx, fmt.Sprintf("/api/shared-subscriptions/plans/%d/subscribe", id), nil, &out)
	if err != nil {
		return nil, err
	}
	return out, nil
}

// CancelSharedPlan cancels a shared pool subscription
// (DELETE /api/shared-subscriptions/plans/{id}/subscribe).
func (c *Client) CancelSharedPlan(ctx context.Context, id int) error {
	return c.Delete(ctx, fmt.Sprintf("/api/shared-subscriptions/plans/%d/subscribe", id), nil)
}

// ---------------------------------------------------------------------------
// Paid account plans
// ---------------------------------------------------------------------------

// ListSubscriptionPlans returns the purchasable paid plans
// (GET /api/subscription/plans).
func (c *Client) ListSubscriptionPlans(ctx context.Context) ([]SubscriptionPlan, error) {
	var out []SubscriptionPlan
	if err := c.Get(ctx, "/api/subscription/plans", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetSubscriptionState returns the current plans and quota
// (GET /api/subscription/self).
func (c *Client) GetSubscriptionState(ctx context.Context) (*SubscriptionState, error) {
	var s SubscriptionState
	if err := c.Get(ctx, "/api/subscription/self", nil, &s); err != nil {
		return nil, err
	}
	return &s, nil
}

// UpdateSubscriptionPreference updates the wallet and plan billing priority
// (PUT /api/subscription/self/preference).
func (c *Client) UpdateSubscriptionPreference(ctx context.Context, body map[string]any) (*SubscriptionState, error) {
	var s SubscriptionState
	if err := c.Put(ctx, "/api/subscription/self/preference", body, &s); err != nil {
		return nil, err
	}
	return &s, nil
}

// PayProvider names a checkout backend for a paid account plan.
type PayProvider string

// The supported checkout backends.
const (
	PayStripe PayProvider = "stripe"
	PayCreem  PayProvider = "creem"
	PayEPay   PayProvider = "epay"
)

// CreatePlanCheckout starts a checkout session for a paid account plan
// (POST /api/subscription/{stripe,creem,epay}/pay). The response carries a
// URL the operator opens in a browser; no card data ever touches the CLI.
func (c *Client) CreatePlanCheckout(ctx context.Context, provider PayProvider, body map[string]any) (any, error) {
	var out any
	err := c.Post(ctx, fmt.Sprintf("/api/subscription/%s/pay", provider), body, &out)
	if err != nil {
		return nil, err
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// Async media tasks
// ---------------------------------------------------------------------------

// TaskQuery holds the filters accepted by the task record endpoint.
type TaskQuery struct {
	Page           int
	PageSize       int
	TaskID         string
	Action         string
	StartTimestamp int64
	EndTimestamp   int64
}

// Params renders the query as request parameters.
func (q TaskQuery) Params() Params {
	p := Params{"p": q.Page, "page_size": q.PageSize}
	if q.TaskID != "" {
		p["task_id"] = q.TaskID
	}
	if q.Action != "" {
		p["action"] = q.Action
	}
	if q.StartTimestamp > 0 {
		p["start_timestamp"] = q.StartTimestamp
	}
	if q.EndTimestamp > 0 {
		p["end_timestamp"] = q.EndTimestamp
	}
	return p
}

// TaskPage is one page of task records.
type TaskPage struct {
	Items    []Task `json:"items"`
	Page     int    `json:"page"`
	PageSize int    `json:"page_size"`
	Total    int    `json:"total"`
}

// ListTasks returns the async media task records (GET /api/task/self).
func (c *Client) ListTasks(ctx context.Context, q TaskQuery) (*TaskPage, error) {
	var p TaskPage
	if err := c.Get(ctx, "/api/task/self", q.Params(), &p); err != nil {
		return nil, err
	}
	return &p, nil
}

// GetTask returns one task record (GET /v1/tasks/{id}) using the relay key.
func (c *Client) GetTask(ctx context.Context, id string) (*Task, error) {
	var t Task
	if err := c.GetRelay(ctx, "/v1/tasks/"+id, nil, &t); err != nil {
		return nil, err
	}
	return &t, nil
}

// FilterTasks keeps the tasks matching the free text query.
func FilterTasks(tasks []Task, query string) []Task {
	if query == "" {
		return tasks
	}
	q := lower(query)
	out := make([]Task, 0, len(tasks))
	for _, t := range tasks {
		hay := lower(t.ID + " " + t.Model + " " + t.Status + " " + t.Type + " " + t.Action)
		if contains(hay, q) {
			out = append(out, t)
		}
	}
	return out
}

// SortTasks orders tasks by a field name in the given direction.
func SortTasks(tasks []Task, field string, desc bool) {
	less := func(i, j int) bool { return false }
	switch lower(field) {
	case "id":
		less = func(i, j int) bool { return tasks[i].ID < tasks[j].ID }
	case "model":
		less = func(i, j int) bool { return tasks[i].Model < tasks[j].Model }
	case "status":
		less = func(i, j int) bool { return tasks[i].Status < tasks[j].Status }
	case "created":
		less = func(i, j int) bool { return tasks[i].CreatedAt < tasks[j].CreatedAt }
	case "quota":
		less = func(i, j int) bool { return tasks[i].Quota < tasks[j].Quota }
	case "progress":
		less = func(i, j int) bool { return tasks[i].Progress < tasks[j].Progress }
	default:
		return
	}
	if desc {
		sort.SliceStable(tasks, func(i, j int) bool { return less(j, i) })
		return
	}
	sort.SliceStable(tasks, func(i, j int) bool { return less(i, j) })
}

func lower(s string) string            { return strings.ToLower(s) }
func contains(hay, needle string) bool { return strings.Contains(hay, needle) }
