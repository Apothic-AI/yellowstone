// Package config resolves SubRouter credentials and connection settings.
//
// Precedence for every value is: explicit flag > environment variable >
// credentials file > built-in default.
package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// DefaultBaseURL is the official SubRouter site.
const DefaultBaseURL = "https://subrouter.ai"

// DefaultQuotaPerUnit is the platform quota conversion: 500000 quota units
// are worth 1 USD. Override with --quota-per-unit when a site uses another
// ratio.
const DefaultQuotaPerUnit = 500000.0

// Credentials is the on-disk credential document written by the device
// authorization flow. It is deliberately permissive about extra fields so a
// newer server can add keys without breaking an older binary.
type Credentials struct {
	Key         string `json:"key,omitempty"`
	AccessToken string `json:"access_token,omitempty"`
	UserID      int    `json:"user_id,omitempty"`
	BaseURL     string `json:"base_url,omitempty"`
}

// Config is the fully resolved configuration for a single invocation.
type Config struct {
	BaseURL        string
	AccessToken    string
	UserID         int
	APIKey         string
	QuotaPerUnit   float64
	Timeout        int
	ShowSecrets    bool
	CredentialPath string
}

// CredentialPath returns the default location of the credential document.
func CredentialPath() string {
	if p := os.Getenv("SUBROUTER_CREDENTIALS"); p != "" {
		return p
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ".subrouter/credentials.json"
	}
	return filepath.Join(home, ".subrouter", "credentials.json")
}

// DefaultCacheDir is where the on-disk cache lives.
func DefaultCacheDir() string {
	if p := os.Getenv("SUBROUTER_CACHE_DIR"); p != "" {
		return p
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ".cache/subrouterctl"
	}
	return filepath.Join(home, ".cache", "subrouterctl")
}

// LoadCredentials reads the credential document. A missing file is not an
// error: it simply yields an empty set.
func LoadCredentials(path string) (*Credentials, error) {
	if path == "" {
		path = CredentialPath()
	}
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return &Credentials{}, nil
		}
		return nil, fmt.Errorf("read credentials %s: %w", path, err)
	}
	var c Credentials
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, fmt.Errorf("parse credentials %s: %w", path, err)
	}
	return &c, nil
}

// SaveCredentials writes the credential document with 0600 permissions,
// creating the parent directory if needed.
func SaveCredentials(path string, c *Credentials) error {
	if path == "" {
		path = CredentialPath()
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create credential dir: %w", err)
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o600)
}

// Resolve merges flags, environment and the credential file into a Config.
func Resolve(flagBase, flagToken, flagAPIKey string, flagUserID int, flagQuotaPerUnit float64, timeout int, showSecrets bool) (*Config, error) {
	credPath := CredentialPath()
	creds, err := LoadCredentials(credPath)
	if err != nil {
		return nil, err
	}

	cfg := &Config{
		BaseURL:        strings.TrimRight(firstNonEmpty(flagBase, os.Getenv("SUBROUTER_BASE_URL"), creds.BaseURL, DefaultBaseURL), "/"),
		AccessToken:    firstNonEmpty(flagToken, os.Getenv("SUBROUTER_ACCESS_TOKEN"), creds.AccessToken),
		APIKey:         firstNonEmpty(flagAPIKey, os.Getenv("SUBROUTER_API_KEY"), creds.Key),
		QuotaPerUnit:   ResolveQuotaPerUnit(flagQuotaPerUnit),
		Timeout:        timeout,
		ShowSecrets:    showSecrets,
		CredentialPath: credPath,
	}

	uid := flagUserID
	if uid == 0 {
		if s := os.Getenv("SUBROUTER_USER_ID"); s != "" {
			if v, err := strconv.Atoi(s); err == nil {
				uid = v
			}
		}
	}
	if uid == 0 {
		uid = creds.UserID
	}
	cfg.UserID = uid

	return cfg, nil
}

// ResolveQuotaPerUnit resolves the quota to dollar ratio. The flag wins over
// the environment variable, which wins over the platform default.
func ResolveQuotaPerUnit(flagValue float64) float64 {
	if flagValue > 0 {
		return flagValue
	}
	if s := os.Getenv("SUBROUTER_QUOTA_PER_UNIT"); s != "" {
		if v, err := strconv.ParseFloat(s, 64); err == nil && v > 0 {
			return v
		}
	}
	return DefaultQuotaPerUnit
}

// RequireManagementAuth verifies that the account management credential pair
// is available. Management endpoints need both the access token and the
// numeric user id.
func (c *Config) RequireManagementAuth() error {
	if c.AccessToken == "" {
		return fmt.Errorf("no system access token: run 'subrouterctl auth login' or set SUBROUTER_ACCESS_TOKEN")
	}
	if c.UserID == 0 {
		return fmt.Errorf("no user id: pass --user-id or set SUBROUTER_USER_ID (the numeric account id, e.g. 10001)")
	}
	return nil
}

// RequireRelayAuth verifies that an sk- relay key is available.
func (c *Config) RequireRelayAuth() error {
	if c.APIKey == "" {
		return fmt.Errorf("no api key: set SUBROUTER_API_KEY or run 'subrouterctl auth login'")
	}
	return nil
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}
