package api

import (
	"bytes"
	"encoding/json"
	"strings"
)

// redactSecrets removes the secret values from a response body before it is
// written to the cache.
//
// The cache is a plain file on disk, and the platform hands out the full
// relay key of every key on the account. The command masks those keys on the
// way to the terminal, but the raw body would still end up in the cache, so
// it is scrubbed on the way in.
//
// Every string field called "key" that is long enough to be key material is
// replaced by a placeholder of the same length. The placeholder keeps the
// shape of the document, so a cached response still decodes, and it is the
// same shape the platform itself returns when it withholds a key.
//
// A short field called "key", such as the name of a key, is left alone.
func redactSecrets(body []byte) []byte {
	if len(body) == 0 {
		return body
	}
	var doc any
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(&doc); err != nil {
		// The body is not the JSON we expect. Leave it as it is rather than
		// file something that was never looked at.
		return body
	}
	if !redactValue(doc) {
		return body
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(doc); err != nil {
		return body
	}
	return buf.Bytes()
}

// redactValue walks a decoded document and redacts the secret values it
// holds. It reports whether anything was redacted.
func redactValue(v any) bool {
	switch t := v.(type) {
	case map[string]any:
		changed := false
		for name, value := range t {
			if name == "key" {
				if s, ok := value.(string); ok && len(s) >= secretFieldLength {
					t[name] = strings.Repeat("*", len(s))
					changed = true
					continue
				}
			}
			if redactValue(value) {
				changed = true
			}
		}
		return changed
	case []any:
		changed := false
		for _, value := range t {
			if redactValue(value) {
				changed = true
			}
		}
		return changed
	}
	return false
}

// secretFieldLength is the shortest value that is treated as key material.
// The relay keys of the platform are 48 characters long, so the threshold
// sits well below that and well above the length of a key name.
const secretFieldLength = 20
