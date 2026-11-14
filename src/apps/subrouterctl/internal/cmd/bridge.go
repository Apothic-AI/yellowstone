package cmd

import (
	"os"

	"github.com/spf13/cobra"

	"github.com/Apothic-AI/subrouterctl/bridge/ipc"
	"github.com/Apothic-AI/subrouterctl/pkg/service"
)

// newBridgeCommand serves the machine interface that the TypeScript and
// Python bindings talk to.
func newBridgeCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "bridge",
		Short: "Serve the machine interface over stdin and stdout",
		Long: `Serve the SubRouter protocol on the standard streams.

Every line of the input is one JSON request:

  {"method":"account.info","params":{}}

Every line of the output is one JSON response:

  {"ok":true,"result":{"id":10001,"username":"..."}}

The bindings start this command and speak the protocol over a pipe. It is
also a stable way to script SubRouter from any language that can read JSON.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx, cancel := ctx()
			defer cancel()
			return ipc.Serve(ctx, os.Stdin, os.Stdout, serviceOptions())
		},
	}
}

// serviceOptions turns the global flags into the options of the protocol.
func serviceOptions() service.Options {
	return service.Options{
		BaseURL:        flagBaseURL,
		AccessToken:    flagToken,
		APIKey:         flagAPIKey,
		UserID:         flagUserID,
		TimeoutSeconds: flagTimeout,
		CacheDir:       flagCacheDir,
		CacheTTLMillis: flagCacheTTL.Milliseconds(),
		QuotaPerUnit:   flagQuotaPerUnit,
	}
}
