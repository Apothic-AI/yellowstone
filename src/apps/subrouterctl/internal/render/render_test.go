package render

import (
	"bytes"
	"strings"
	"testing"
)

// TestTableBordersShareOneGrid checks that every line of a table, borders
// included, is exactly as wide as the rows. A border that is one column
// short or long leaves the box open on that side.
func TestTableBordersShareOneGrid(t *testing.T) {
	var buf bytes.Buffer
	w := New(Options{Format: FormatTable, Out: &buf})
	w.Table(
		[]Column{
			{Title: "ID", Align: AlignRight},
			{Title: "NAME"},
			{Title: "COST", Align: AlignRight},
		},
		[][]string{
			{"392958", "demo-fixed", "$0.00"},
			{"392939", "acme-fixed", "$12.34"},
		},
	)

	lines := strings.Split(strings.TrimRight(buf.String(), "\n"), "\n")
	if len(lines) != 6 {
		t.Fatalf("got %d lines, want 6:\n%s", len(lines), buf.String())
	}

	width := displayWidth(lines[0])
	for i, l := range lines {
		if got := displayWidth(l); got != width {
			t.Errorf("line %d is %d columns wide, want %d:\n%s", i, got, width, l)
		}
	}

	// The junctions have to sit on the column boundaries, so the box closes.
	if !strings.HasPrefix(lines[0], "┌") || !strings.HasSuffix(lines[0], "┐") {
		t.Errorf("the top border does not close the box:\n%s", lines[0])
	}
	if !strings.HasPrefix(lines[2], "├") || !strings.HasSuffix(lines[2], "┤") {
		t.Errorf("the separator does not close the box:\n%s", lines[2])
	}
	if !strings.HasPrefix(lines[5], "└") || !strings.HasSuffix(lines[5], "┘") {
		t.Errorf("the bottom border does not close the box:\n%s", lines[5])
	}
	for _, i := range []int{1, 3, 4} {
		l := lines[i]
		if !strings.HasPrefix(l, "│") || !strings.HasSuffix(l, "│") {
			t.Errorf("row %d is not framed:\n%s", i, l)
		}
	}
}

// TestTablePadsToTheWidestCell checks that a column grows to hold its widest
// value and that the values line up under each other.
func TestTablePadsToTheWidestCell(t *testing.T) {
	var buf bytes.Buffer
	w := New(Options{Format: FormatTable, Out: &buf})
	w.Table(
		[]Column{{Title: "NAME"}, {Title: "KIND"}},
		[][]string{{"a", "x"}, {"longer-name", "y"}},
	)

	lines := strings.Split(strings.TrimRight(buf.String(), "\n"), "\n")
	if got := displayWidth(lines[1]); got != displayWidth(lines[0]) {
		t.Errorf("the header is %d columns, the border is %d", got, displayWidth(lines[0]))
	}
	if !strings.Contains(lines[4], "longer-name") {
		t.Errorf("the row does not hold the longest value:\n%s", lines[4])
	}
	if !strings.Contains(lines[1], "NAME  ") {
		t.Errorf("the header is not padded to the column:\n%s", lines[1])
	}
}

// TestMaskKeyKeepsTheShape checks the mask the tables print.
func TestMaskKeyKeepsTheShape(t *testing.T) {
	got := MaskKey("sk-Qk7mRt2xWq9bLc4nZ")
	if want := "sk-Qk7******c4nZ"; got != want {
		t.Errorf("MaskKey = %q, want %q", got, want)
	}
	if got := MaskKey(""); got != "" {
		t.Errorf("MaskKey of an empty key = %q, want an empty string", got)
	}
}
