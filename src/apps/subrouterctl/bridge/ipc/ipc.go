// Package ipc serves the SubRouter protocol over a pair of streams.
//
// The protocol is one JSON object per line:
//
//	{"method":"account.info","params":{},"id":"1"}
//	{"ok":true,"result":{"id":10001,...},"id":"1"}
//
// Every request is answered by exactly one response. A response carries back
// the id of its request, so a client may keep several calls in flight.
//
// The server writes nothing but responses to the output stream, so the pair
// can be a pipe or a socket.
package ipc

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"

	"github.com/Apothic-AI/subrouterctl/pkg/service"
)

// maxConcurrent is how many calls are served at the same time.
const maxConcurrent = 8

// Serve reads requests from in and writes responses to out.
//
// The defaults are used for any field a request leaves out.
func Serve(ctx context.Context, in io.Reader, out io.Writer, defaults service.Options) error {
	reader := bufio.NewReader(in)
	writer := bufio.NewWriter(out)

	var writeMu sync.Mutex
	write := func(resp service.Response) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		b, err := json.Marshal(resp)
		if err != nil {
			return err
		}
		if _, err := writer.Write(append(b, '\n')); err != nil {
			return err
		}
		return writer.Flush()
	}

	sem := make(chan struct{}, maxConcurrent)
	var wg sync.WaitGroup
	for {
		line, err := reader.ReadString('\n')
		if line != "" {
			trimmed := trimSpace(line)
			if trimmed != "" {
				wg.Add(1)
				sem <- struct{}{}
				go func(payload string) {
					defer wg.Done()
					defer func() { <-sem }()
					write(answer(ctx, payload, defaults))
				}(trimmed)
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			wg.Wait()
			return err
		}
	}
	wg.Wait()
	return nil
}

// answer turns one request line into one response.
func answer(ctx context.Context, payload string, defaults service.Options) (resp service.Response) {
	defer func() {
		if r := recover(); r != nil {
			resp = service.Response{OK: false, Error: &service.Error{
				Message: fmt.Sprintf("panic: %v", r),
				Type:    "panic",
			}}
		}
	}()

	var req service.Request
	if err := json.Unmarshal([]byte(payload), &req); err != nil {
		return service.Response{OK: false, Error: &service.Error{
			Message: "invalid request: " + err.Error(),
			Type:    "invalid_request",
		}}
	}
	if req.Options == nil {
		opts := defaults
		req.Options = &opts
	}
	resp = service.Dispatch(ctx, req)
	resp.ID = req.ID
	return resp
}

// trimSpace removes the whitespace around a line.
func trimSpace(s string) string {
	start, end := 0, len(s)
	for start < end && isSpace(s[start]) {
		start++
	}
	for end > start && isSpace(s[end-1]) {
		end--
	}
	return s[start:end]
}

func isSpace(b byte) bool {
	switch b {
	case ' ', '\t', '\r', '\n', '\v', '\f':
		return true
	}
	return false
}

// Main serves the protocol on the standard streams. It is the entry point of
// the bridge command.
func Main(ctx context.Context, defaults service.Options) error {
	if err := Serve(ctx, os.Stdin, os.Stdout, defaults); err != nil {
		return err
	}
	return nil
}
