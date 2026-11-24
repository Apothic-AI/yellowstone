package cmd

import (
	"bytes"
	"strings"
	"testing"

	"github.com/Apothic-AI/subrouterctl/internal/render"
	"github.com/Apothic-AI/subrouterctl/pkg/api"
)

func TestTokenListMasksKeysByDefaultInEveryOutputFormat(t *testing.T) {
	const secret = "sk-SentinelKeyThatMustNeverAppear-0123456789abcdef"
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
	const secret = "sk-SentinelKeyThatMustNeverAppear-0123456789abcdef"
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

func TestTokenListOutputDoesNotMutateAPITokens(t *testing.T) {
	const secret = "sk-SentinelKeyThatMustNeverAppear-0123456789abcdef"
	tokens := []api.Token{{Key: secret}}
	got := tokenListOutput(tokens, false)
	if tokens[0].Key != secret {
		t.Fatal("tokenListOutput mutated its input")
	}
	if got[0].Key == secret {
		t.Fatal("tokenListOutput did not redact its copy")
	}
}
