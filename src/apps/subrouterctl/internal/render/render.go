// Package render turns API payloads into terminal output.
//
// Three formats are supported: a bordered table for humans, and JSON or YAML
// for scripts. Secrets are masked unless the operator asks for them.
package render

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sort"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"

	"gopkg.in/yaml.v3"
)

// Format is an output format.
type Format string

// The supported output formats.
const (
	FormatTable Format = "table"
	FormatJSON  Format = "json"
	FormatYAML  Format = "yaml"
)

// Options controls how a payload is rendered.
type Options struct {
	Format       Format
	Color        bool
	QuotaPerUnit float64
	Out          io.Writer
	// Err receives the warnings and the errors. They are kept apart from
	// the payload so that a JSON or YAML stream stays machine readable.
	Err io.Writer
}

// DefaultOptions returns options matching the current terminal.
func DefaultOptions() Options {
	return Options{
		Format:       FormatTable,
		Color:        isTerminal(os.Stdout),
		QuotaPerUnit: 500000,
		Out:          os.Stdout,
		Err:          os.Stderr,
	}
}

// Writer renders payloads according to a set of options.
type Writer struct {
	opts Options
}

// New builds a Writer.
func New(opts Options) *Writer {
	if opts.Out == nil {
		opts.Out = os.Stdout
	}
	if opts.Err == nil {
		opts.Err = os.Stderr
	}
	if opts.QuotaPerUnit <= 0 {
		opts.QuotaPerUnit = 500000
	}
	return &Writer{opts: opts}
}

// Format reports the active output format.
func (w *Writer) Format() Format { return w.opts.Format }

// Structured writes a payload as JSON or YAML. It is a no-op in table mode.
func (w *Writer) Structured(v any) error {
	switch w.opts.Format {
	case FormatJSON:
		b, err := json.MarshalIndent(v, "", "  ")
		if err != nil {
			return err
		}
		_, err = fmt.Fprintln(w.opts.Out, string(b))
		return err
	case FormatYAML:
		// Marshal through JSON so that YAML carries the same field names as
		// the JSON output instead of the Go field names.
		j, err := json.Marshal(v)
		if err != nil {
			return err
		}
		dec := json.NewDecoder(bytes.NewReader(j))
		dec.UseNumber()
		var generic any
		if err := dec.Decode(&generic); err != nil {
			return err
		}
		b, err := yaml.Marshal(normalizeNumbers(generic))
		if err != nil {
			return err
		}
		_, err = fmt.Fprint(w.opts.Out, string(b))
		return err
	default:
		return nil
	}
}

// IsStructured reports whether the writer emits machine readable output.
func (w *Writer) IsStructured() bool {
	return w.opts.Format == FormatJSON || w.opts.Format == FormatYAML
}

// Align controls the horizontal alignment of a column.
type Align int

// Column alignments.
const (
	AlignLeft Align = iota
	AlignRight
)

// Column describes one table column.
type Column struct {
	Title string
	Align Align
}

// Table renders a bordered table.
func (w *Writer) Table(cols []Column, rows [][]string) {
	if w.IsStructured() {
		return
	}
	if len(cols) == 0 {
		return
	}
	if len(rows) == 0 {
		fmt.Fprintln(w.opts.Out, w.dim("(no rows)"))
		return
	}

	widths := make([]int, len(cols))
	for i, c := range cols {
		widths[i] = displayWidth(c.Title)
	}
	for _, r := range rows {
		for i := range cols {
			if i < len(r) {
				if n := displayWidth(r[i]); n > widths[i] {
					widths[i] = n
				}
			}
		}
	}

	// Every border is drawn on the same column grid as the rows, so the box
	// closes on all four sides.
	top := w.dim("┌" + strings.Join(repeat("─", widths), "┬") + "┐")
	fmt.Fprintln(w.opts.Out, top)
	fmt.Fprintln(w.opts.Out, w.dim("│")+w.bold(headerRow(cols, widths))+"│")
	fmt.Fprintln(w.opts.Out, w.dim("├"+strings.Join(repeat("─", widths), "┼")+"┤"))
	for _, r := range rows {
		fmt.Fprintln(w.opts.Out, w.dim("│")+bodyRow(cols, r, widths)+"│")
	}
	fmt.Fprintln(w.opts.Out, w.dim("└"+strings.Join(repeat("─", widths), "┴")+"┘"))
}

// headerRow renders the header cells padded to their column widths.
func headerRow(cols []Column, widths []int) string {
	cells := make([]string, len(cols))
	for i, c := range cols {
		cells[i] = pad(c.Title, widths[i], c.Align)
	}
	return " " + strings.Join(cells, " │ ") + " "
}

// bodyRow renders one data row padded to its column widths.
func bodyRow(cols []Column, row []string, widths []int) string {
	cells := make([]string, len(cols))
	for i := range cols {
		v := ""
		if i < len(row) {
			v = row[i]
		}
		align := AlignLeft
		if i < len(cols) {
			align = cols[i].Align
		}
		cells[i] = pad(v, widths[i], align)
	}
	return " " + strings.Join(cells, " │ ") + " "
}

func repeat(s string, widths []int) []string {
	out := make([]string, len(widths))
	for i, w := range widths {
		out[i] = strings.Repeat(s, w+2)
	}
	return out
}

// pad pads a cell to the requested width, ignoring ANSI escape sequences.
func pad(s string, width int, align Align) string {
	gap := width - displayWidth(s)
	if gap <= 0 {
		return s
	}
	if align == AlignRight {
		return strings.Repeat(" ", gap) + s
	}
	return s + strings.Repeat(" ", gap)
}

// displayWidth counts printable columns, skipping ANSI escapes.
func displayWidth(s string) int {
	n := 0
	inEscape := false
	for _, r := range s {
		switch {
		case inEscape:
			if r == 'm' {
				inEscape = false
			}
		case r == '\x1b':
			inEscape = true
		default:
			n++
		}
	}
	return n
}

// Field is one line of a detail view.
type Field struct {
	Label string
	Value string
}

// Detail renders a key/value block, used for single object views.
func (w *Writer) Detail(title string, fields []Field) {
	if w.IsStructured() {
		return
	}
	if title != "" {
		fmt.Fprintln(w.opts.Out, w.bold(title))
		fmt.Fprintln(w.opts.Out, w.dim(strings.Repeat("─", min(len(title)*2, 60))))
	}
	tw := tabwriter.NewWriter(w.opts.Out, 0, 0, 2, ' ', 0)
	for _, f := range fields {
		fmt.Fprintf(tw, "%s\t%s\n", f.Label, f.Value)
	}
	_ = tw.Flush()
}

// isTerminal reports whether the given file is an interactive terminal.
func isTerminal(f *os.File) bool {
	info, err := f.Stat()
	if err != nil {
		return false
	}
	return info.Mode()&os.ModeCharDevice != 0
}

// Note prints an informational line. In a structured payload the line goes
// to the error stream, so that the payload stays machine readable.
func (w *Writer) Note(format string, a ...any) {
	if w.IsStructured() {
		fmt.Fprintln(w.opts.Err, w.dim(fmt.Sprintf(format, a...)))
		return
	}
	fmt.Fprintln(w.opts.Out, w.dim(fmt.Sprintf(format, a...)))
}

// Success prints a confirmation line.
func (w *Writer) Success(format string, a ...any) {
	if w.IsStructured() {
		return
	}
	fmt.Fprintln(w.opts.Out, w.green("✓ ")+fmt.Sprintf(format, a...))
}

// Warn prints a warning line. Warnings go to the error stream, so they
// never end up inside a JSON or YAML payload.
func (w *Writer) Warn(format string, a ...any) {
	fmt.Fprintln(w.opts.Err, w.yellow("! ")+fmt.Sprintf(format, a...))
}

// Error prints an error line. It goes to the error stream.
func (w *Writer) Error(format string, a ...any) {
	fmt.Fprintln(w.opts.Err, w.red("✗ ")+fmt.Sprintf(format, a...))
}

// Plain prints a line without decoration.
func (w *Writer) Plain(format string, a ...any) {
	fmt.Fprintln(w.opts.Out, fmt.Sprintf(format, a...))
}

// ---------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------

func (w *Writer) wrap(code, s string) string {
	if !w.opts.Color || s == "" {
		return s
	}
	return "\x1b[" + code + "m" + s + "\x1b[0m"
}

func (w *Writer) bold(s string) string    { return w.wrap("1", s) }
func (w *Writer) dim(s string) string     { return w.wrap("2", s) }
func (w *Writer) green(s string) string   { return w.wrap("32", s) }
func (w *Writer) yellow(s string) string  { return w.wrap("33", s) }
func (w *Writer) red(s string) string     { return w.wrap("31", s) }
func (w *Writer) cyan(s string) string    { return w.wrap("36", s) }
func (w *Writer) magenta(s string) string { return w.wrap("35", s) }

// StatusColor paints a status label with a sensible colour.
func (w *Writer) StatusColor(status string) string {
	switch strings.ToLower(status) {
	case "enabled", "completed", "active", "ok", "healthy", "success", "verified":
		return w.green(status)
	case "disabled", "banned", "failed", "error", "expired", "exhausted", "paused":
		return w.red(status)
	case "pending", "processing", "pending_review", "warning":
		return w.yellow(status)
	default:
		return status
	}
}

// KindColor paints a token kind.
func (w *Writer) KindColor(kind string) string {
	switch strings.ToLower(kind) {
	case "smart":
		return w.cyan(kind)
	case "fixed":
		return w.magenta(kind)
	case "shared":
		return w.blue(kind)
	case "official":
		return w.green(kind)
	default:
		return kind
	}
}

func (w *Writer) blue(s string) string { return w.wrap("34", s) }

// ---------------------------------------------------------------------------
// Value formatting
// ---------------------------------------------------------------------------

// MaskKey masks an sk- relay key, keeping a short recognisable prefix.
func MaskKey(key string) string {
	if key == "" {
		return ""
	}
	if len(key) <= 10 {
		return key[:1] + strings.Repeat("*", len(key)-1)
	}
	return key[:6] + strings.Repeat("*", 6) + key[len(key)-4:]
}

// normalizeNumbers turns json.Number values into int64 or float64 so that
// YAML prints timestamps as integers instead of floating point.
func normalizeNumbers(v any) any {
	switch t := v.(type) {
	case json.Number:
		if i, err := t.Int64(); err == nil {
			return i
		}
		if f, err := t.Float64(); err == nil {
			return f
		}
		return t.String()
	case []any:
		for i := range t {
			t[i] = normalizeNumbers(t[i])
		}
		return t
	case map[string]any:
		for k := range t {
			t[k] = normalizeNumbers(t[k])
		}
		return t
	default:
		return v
	}
}

// IsRedacted reports whether the platform returned a placeholder instead of
// the real secret.
func IsRedacted(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r != '*' {
			return false
		}
	}
	return true
}

// MaskSecret masks an arbitrary secret.
func MaskSecret(s string) string {
	if s == "" {
		return ""
	}
	if len(s) <= 8 {
		return strings.Repeat("*", len(s))
	}
	return s[:4] + strings.Repeat("*", 8) + s[len(s)-2:]
}

// Money renders quota units as a USD amount.
func (w *Writer) Money(quota float64) string {
	return "$" + strconv.FormatFloat(quota/w.opts.QuotaPerUnit, 'f', 2, 64)
}

// Time renders a unix timestamp, tolerating zero.
func (w *Writer) Time(ts int64) string {
	if ts <= 0 {
		return "-"
	}
	return time.Unix(ts, 0).Format("2006-01-02 15:04:05")
}

// Duration renders a unix timestamp as a relative age.
func (w *Writer) Age(ts int64) string {
	if ts <= 0 {
		return "-"
	}
	d := time.Since(time.Unix(ts, 0))
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds ago", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd ago", int(d.Hours()/24))
	}
}

// Truncate shortens a string to the given width, adding an ellipsis.
func Truncate(s string, width int) string {
	if width <= 0 || displayWidth(s) <= width {
		return s
	}
	runes := []rune(s)
	if len(runes) <= width {
		return s
	}
	return string(runes[:width-1]) + "…"
}

// SortedKeys returns the sorted keys of a map, for stable output.
func SortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
