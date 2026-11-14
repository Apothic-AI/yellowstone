// Command subrouterctl manages a SubRouter account from the command line.
package main

import (
	"fmt"
	"os"

	"github.com/Apothic-AI/subrouterctl/internal/cmd"
)

func main() {
	if err := cmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, "subrouterctl: "+err.Error())
		os.Exit(1)
	}
}
