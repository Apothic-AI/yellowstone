package cmd

import (
	"fmt"
	"time"

	"github.com/spf13/cobra"

	"github.com/Apothic-AI/subrouterctl/internal/render"
	"github.com/Apothic-AI/subrouterctl/pkg/api"
	"github.com/Apothic-AI/subrouterctl/pkg/config"
)

// authChannel identifies this CLI to the device authorization service.
const authChannel = "subrouterctl"

func newAuthCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "auth",
		Short: "Manage credentials and sign in",
	}
	cmd.AddCommand(newAuthStatusCommand(), newAuthLoginCommand())
	return cmd
}

func newAuthStatusCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Show the configured credentials and check that they work",
		RunE: func(cmd *cobra.Command, args []string) error {
			w := writer()
			c, err := cfg()
			if err != nil {
				return err
			}

			token := render.MaskSecret(c.AccessToken)
			key := render.MaskKey(c.APIKey)
			if flagShowSecrets {
				token = c.AccessToken
				key = c.APIKey
			}

			fields := []render.Field{{Label: "Base URL", Value: c.BaseURL}, {Label: "User id", Value: fmt.Sprintf("%d", c.UserID)}, {Label: "Access token", Value: orDash(token)}, {Label: "Relay key", Value: orDash(key)}, {Label: "Credential file", Value: c.CredentialPath}}
			w.Detail("Credentials", fields)

			if c.AccessToken == "" || c.UserID == 0 {
				w.Warn("management credential incomplete: run 'subrouterctl auth login'")
				return nil
			}

			cl := api.New(c.BaseURL, c.AccessToken, c.UserID, c.APIKey, time.Duration(c.Timeout)*time.Second)
			ctx, cancel := ctx()
			defer cancel()

			user, err := cl.GetUser(ctx)
			if err != nil {
				w.Error("management API unreachable: %v", err)
				return err
			}
			w.Success("authenticated as %s (id %d)", user.Username, user.ID)

			if c.APIKey != "" {
				models, err := cl.GetRelayModels(ctx)
				if err != nil {
					w.Warn("relay key rejected: %v", err)
				} else {
					w.Success("relay key works, %d models reachable", len(models))
				}
			}
			return nil
		},
	}
}

func newAuthLoginCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "login",
		Short: "Authorize this CLI with a device code",
		Long: `Start the device authorization flow. Open the printed verification URL in a
browser, confirm the code, and the credentials are written to
~/.subrouter/credentials.json with 0600 permissions.

Re-running login with the same channel re-uses the account's existing token
instead of creating a second one.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			w := writer()
			c, err := cfg()
			if err != nil {
				return err
			}
			cl := api.New(c.BaseURL, "", 0, "", time.Duration(c.Timeout)*time.Second)
			ctx, cancel := ctx()
			defer cancel()

			auth, err := cl.StartDeviceAuth(ctx, authChannel)
			if err != nil {
				return fmt.Errorf("start device authorization: %w", err)
			}

			fmt.Printf("\n  Open this URL to continue:\n\n    %s\n\n", auth.VerificationURL)
			fmt.Printf("  Confirm the code:  %s\n\n", auth.UserCode)
			fmt.Println("  Waiting for approval...")

			interval := auth.Interval
			if interval < 1 {
				interval = 3
			}
			deadline := time.Now().Add(time.Duration(auth.ExpiresIn) * time.Second)
			if auth.ExpiresIn <= 0 {
				deadline = time.Now().Add(10 * time.Minute)
			}

			for time.Now().Before(deadline) {
				time.Sleep(time.Duration(interval) * time.Second)

				poll, err := cl.PollDeviceAuth(ctx, auth.DeviceCode)
				if err != nil {
					return fmt.Errorf("poll device authorization: %w", err)
				}
				switch poll.Status {
				case "approved", "success":
					creds := &config.Credentials{
						Key:         poll.Key,
						AccessToken: poll.AccessToken,
						UserID:      poll.UserID,
						BaseURL:     c.BaseURL,
					}
					if creds.BaseURL == "" {
						creds.BaseURL = config.DefaultBaseURL
					}
					if err := config.SaveCredentials(c.CredentialPath, creds); err != nil {
						return fmt.Errorf("save credentials: %w", err)
					}
					fmt.Println()
					w.Success("authorized as user id %d", poll.UserID)
					w.Plain("  credentials written to %s (mode 0600)", c.CredentialPath)
					if poll.Key != "" {
						w.Plain("  relay key: %s", render.MaskKey(poll.Key))
					}
					fmt.Println()
					return nil
				case "slow_down":
					interval += 2
				case "authorization_pending":
					// keep waiting
				default:
					return fmt.Errorf("device authorization failed: %s", poll.Message)
				}
			}
			return fmt.Errorf("device authorization expired before approval")
		},
	}
}

func orDash(v any) string {
	switch t := v.(type) {
	case nil:
		return "-"
	case string:
		if t == "" {
			return "-"
		}
		return t
	case fmt.Stringer:
		if t.String() == "" {
			return "-"
		}
		return t.String()
	default:
		s := fmt.Sprint(v)
		if s == "" || s == "0" && fmt.Sprintf("%T", v) == "int" {
			return "-"
		}
		return s
	}
}
