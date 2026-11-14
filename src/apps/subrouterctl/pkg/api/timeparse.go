package api

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// ParseTime parses a date, timestamp or relative age into unix seconds.
//
// Accepted forms: 2026-01-31, 2026-01-31T15:04:05Z, 1738281600, 24h, 7d.
// A bare date is read in the local time zone. When endOfDay is set, a bare
// date covers the whole day instead of its midnight.
func ParseTime(s string, endOfDay bool) (int64, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, nil
	}
	if strings.EqualFold(s, "now") {
		return time.Now().Unix(), nil
	}
	if n, err := strconv.ParseInt(s, 10, 64); err == nil {
		return n, nil
	}
	if strings.HasSuffix(s, "d") || strings.HasSuffix(s, "h") || strings.HasSuffix(s, "m") {
		unit := s[len(s)-1]
		n, err := strconv.Atoi(s[:len(s)-1])
		if err != nil {
			return 0, fmt.Errorf("cannot parse time %q", s)
		}
		now := time.Now()
		switch unit {
		case 'd':
			return now.AddDate(0, 0, -n).Unix(), nil
		case 'h':
			return now.Add(-time.Duration(n) * time.Hour).Unix(), nil
		case 'm':
			return now.Add(-time.Duration(n) * time.Minute).Unix(), nil
		}
	}
	if t, err := time.ParseInLocation("2006-01-02", s, time.Local); err == nil {
		if endOfDay {
			t = t.Add(24*time.Hour - time.Second)
		}
		return t.Unix(), nil
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t.Unix(), nil
	}
	return 0, fmt.Errorf("cannot parse time %q: use 2026-01-31, 24h or a unix timestamp", s)
}

// StartOfToday is the midnight the platform uses when a log query names no
// start time.
func StartOfToday() int64 {
	y, m, d := time.Now().Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.Local).Unix()
}

// ResolveExpiry turns an expiry description into a unix timestamp.
//
// Accepted forms: "never" and "-1" for no expiry, a unix timestamp, and a
// duration with a second, minute, hour, day or week unit ("30d", "12h").
func ResolveExpiry(v string) (int64, error) {
	v = strings.TrimSpace(v)
	switch strings.ToLower(v) {
	case "", "never", "-1", "always":
		return -1, nil
	}
	if n, err := strconv.ParseInt(v, 10, 64); err == nil {
		return n, nil
	}
	if d, err := time.ParseDuration(v); err == nil {
		return time.Now().Add(d).Unix(), nil
	}
	// Go durations have no day or week unit, so they are parsed here.
	if len(v) > 1 {
		unit := v[len(v)-1]
		if unit == 'd' || unit == 'w' {
			if n, err := strconv.Atoi(v[:len(v)-1]); err == nil {
				days := n
				if unit == 'w' {
					days *= 7
				}
				return time.Now().AddDate(0, 0, days).Unix(), nil
			}
		}
	}
	return 0, fmt.Errorf("invalid expiry %q: use never, 30d, 12h or a unix timestamp", v)
}
