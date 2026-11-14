package api

import (
	"sort"
	"strings"
)

// FilterLogs keeps the log entries matching the free text query. It searches
// the key name, the model name, the group and the request identifiers.
func FilterLogs(logs []LogEntry, query string) []LogEntry {
	if query == "" {
		return logs
	}
	q := strings.ToLower(query)
	out := make([]LogEntry, 0, len(logs))
	for _, l := range logs {
		hay := strings.ToLower(strings.Join([]string{
			l.TokenName, l.ModelName, l.Group, l.RequestID, l.UpstreamRequestID, l.Username,
		}, " "))
		if strings.Contains(hay, q) {
			out = append(out, l)
		}
	}
	return out
}

// SortLogs orders log entries by a field name in the given direction.
func SortLogs(logs []LogEntry, field string, desc bool) {
	less := func(i, j int) bool { return false }
	switch strings.ToLower(field) {
	case "time", "created":
		less = func(i, j int) bool { return logs[i].CreatedAt < logs[j].CreatedAt }
	case "quota", "cost":
		less = func(i, j int) bool { return logs[i].Quota < logs[j].Quota }
	case "tokens":
		less = func(i, j int) bool {
			return logs[i].PromptTokens+logs[i].CompletionTokens < logs[j].PromptTokens+logs[j].CompletionTokens
		}
	case "prompt":
		less = func(i, j int) bool { return logs[i].PromptTokens < logs[j].PromptTokens }
	case "completion":
		less = func(i, j int) bool { return logs[i].CompletionTokens < logs[j].CompletionTokens }
	case "model":
		less = func(i, j int) bool { return logs[i].ModelName < logs[j].ModelName }
	case "key", "token_name":
		less = func(i, j int) bool { return logs[i].TokenName < logs[j].TokenName }
	case "group":
		less = func(i, j int) bool { return logs[i].Group < logs[j].Group }
	case "duration", "use_time":
		less = func(i, j int) bool { return logs[i].UseTime < logs[j].UseTime }
	case "tps":
		less = func(i, j int) bool { return logs[i].OutputTPS() < logs[j].OutputTPS() }
	case "ttft":
		less = func(i, j int) bool {
			return logs[i].FirstResponseTimeMs() < logs[j].FirstResponseTimeMs()
		}
	default:
		return
	}
	if desc {
		sort.SliceStable(logs, func(i, j int) bool { return less(j, i) })
		return
	}
	sort.SliceStable(logs, func(i, j int) bool { return less(i, j) })
}
