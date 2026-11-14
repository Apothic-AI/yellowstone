package api

import (
	"context"
	"sync"
)

// ConcurrentPages fetches pages in parallel with a bounded worker pool.
//
// fetch returns the rows of one page and the total row count. The pages are
// numbered from 1. The rows come back in page order, whatever order the
// workers finished in.
func ConcurrentPages[T any](ctx context.Context, pages, workers int, fetch func(context.Context, int) ([]T, int, error)) ([]T, error) {
	if pages <= 0 {
		return nil, nil
	}
	if workers < 1 {
		workers = 1
	}
	rows := make([][]T, pages)
	errs := make(chan error, pages)
	sem := make(chan struct{}, workers)
	var wg sync.WaitGroup
	for p := 1; p <= pages; p++ {
		wg.Add(1)
		go func(page int) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			got, _, err := fetch(ctx, page)
			if err != nil {
				errs <- err
				return
			}
			rows[page-1] = got
		}(p)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			return nil, err
		}
	}
	var all []T
	for _, r := range rows {
		all = append(all, r...)
	}
	return all, nil
}
