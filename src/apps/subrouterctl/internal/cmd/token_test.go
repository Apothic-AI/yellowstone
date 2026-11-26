package cmd

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/Apothic-AI/subrouterctl/internal/render"
	"github.com/Apothic-AI/subrouterctl/pkg/api"
)

const tokenListTestSecret = "sk-SentinelKeyThatMustNeverAppear"

func TestTokenListMasksKeysByDefaultInEveryOutputFormat(t *testing.T) {
	secret := tokenListTestSecret
	tokens := []api.Token{{ID: 7, Name: "test", Key: secret}}

	for _, format := range []render.Format{render.FormatTable, render.FormatJSON, render.FormatYAML} {
		t.Run(string(format), func(t *testing.T) {
			var out, errOut bytes.Buffer
			w := render.New(render.Options{Format: format, Out: &out, Err: &errOut})
			if warning := tokenListWarning(false); warning != "" {
				w.Warn("%s", warning)
			}
			if w.IsStructured() {
				if err := w.Structured(tokenListOutput(tokens, false)); err != nil {
					t.Fatal(err)
				}
			} else {
				masked := tokenListOutput(tokens, false)[0].Key
				w.Table([]render.Column{{Title: "KEY"}}, [][]string{{masked}})
			}

			if strings.Contains(out.String(), secret) {
				t.Fatalf("default %s output contains the key: %s", format, out.String())
			}
			if !strings.Contains(out.String(), render.MaskKey(secret)) {
				t.Fatalf("default %s output does not contain the expected mask %q: %s", format, render.MaskKey(secret), out.String())
			}
			if errOut.Len() != 0 {
				t.Fatalf("default %s output unexpectedly warned: %s", format, errOut.String())
			}
		})
	}
}

func TestTokenListShowSecretsOptInReturnsUnmaskedKey(t *testing.T) {
	secret := tokenListTestSecret
	tokens := []api.Token{{ID: 7, Name: "test", Key: secret}}

	for _, format := range []render.Format{render.FormatTable, render.FormatJSON, render.FormatYAML} {
		t.Run(string(format), func(t *testing.T) {
			var out, errOut bytes.Buffer
			w := render.New(render.Options{Format: format, Out: &out, Err: &errOut})
			if warning := tokenListWarning(true); warning != "" {
				w.Warn("%s", warning)
			}
			if w.IsStructured() {
				if err := w.Structured(tokenListOutput(tokens, true)); err != nil {
					t.Fatal(err)
				}
			} else {
				w.Table([]render.Column{{Title: "KEY"}}, [][]string{{tokenListOutput(tokens, true)[0].Key}})
			}

			if !strings.Contains(out.String(), secret) {
				t.Fatalf("explicit show-secrets %s output did not contain the key: %s", format, out.String())
			}
			if !strings.Contains(errOut.String(), "unmasked API keys") {
				t.Fatalf("explicit show-secrets %s output did not warn on stderr: %s", format, errOut.String())
			}
		})
	}
}

func TestTokenListShowSecretsWarningDoesNotCorruptJSON(t *testing.T) {
	secret := tokenListTestSecret
	tokens := tokenListOutput([]api.Token{{ID: 7, Name: "test", Key: secret}}, true)
	var out, errOut bytes.Buffer
	w := render.New(render.Options{Format: render.FormatJSON, Out: &out, Err: &errOut})

	writeTokenListWarning(w, true)
	if err := w.Structured(tokens); err != nil {
		t.Fatal(err)
	}

	var parsed []api.Token
	if err := json.Unmarshal(out.Bytes(), &parsed); err != nil {
		t.Fatalf("--show-secrets JSON output is not parseable: %v; stdout: %s", err, out.String())
	}
	if len(parsed) != 1 || parsed[0].Key != secret {
		t.Fatalf("--show-secrets JSON did not preserve the unmasked key: %#v", parsed)
	}
	if strings.Contains(out.String(), "--show-secrets is enabled") {
		t.Fatalf("warning contaminated JSON stdout: %s", out.String())
	}
	if !strings.Contains(errOut.String(), "--show-secrets is enabled") {
		t.Fatalf("warning was not written to stderr: %s", errOut.String())
	}
}

func TestTokenListOutputDoesNotMutateAPITokens(t *testing.T) {
	secret := tokenListTestSecret
	tokens := []api.Token{{Key: secret}}
	got := tokenListOutput(tokens, false)
	if tokens[0].Key != secret {
		t.Fatal("tokenListOutput mutated its input")
	}
	if got[0].Key == secret {
		t.Fatal("tokenListOutput did not redact its copy")
	}
}
