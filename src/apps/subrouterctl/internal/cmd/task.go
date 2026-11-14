package cmd

import (
	"fmt"
	"strconv"

	"github.com/spf13/cobra"

	"github.com/Apothic-AI/subrouterctl/internal/render"
	"github.com/Apothic-AI/subrouterctl/pkg/api"
)

func newTaskCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "task",
		Short: "Inspect asynchronous media task records",
	}
	cmd.AddCommand(newTaskListCommand(), newTaskShowCommand())
	return cmd
}

func newTaskListCommand() *cobra.Command {
	var (
		lf     listFlags
		tf     timeFlags
		taskID string
		action string
	)
	cmd := &cobra.Command{
		Use:   "list",
		Short: "List async media tasks",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			start, end, err := tf.range_()
			if err != nil {
				return err
			}
			q := api.TaskQuery{
				Page:           lf.page,
				PageSize:       lf.pageSize,
				TaskID:         taskID,
				Action:         action,
				StartTimestamp: start,
				EndTimestamp:   end,
			}
			page, err := cl.ListTasks(ctx, q)
			if err != nil {
				return err
			}
			tasks := page.Items
			tasks = api.FilterTasks(tasks, lf.search)
			api.SortTasks(tasks, lf.sort, lf.desc())
			if w.IsStructured() {
				return w.Structured(map[string]any{"total": page.Total, "items": tasks})
			}
			rows := make([][]string, 0, len(tasks))
			for _, t := range tasks {
				rows = append(rows, []string{
					t.ID,
					orDash(t.Type),
					orDash(t.Model),
					w.StatusColor(t.Status),
					fmt.Sprintf("%d%%", t.Progress),
					w.Money(float64(t.Quota)),
					w.Time(t.CreatedAt),
				})
			}
			w.Table([]render.Column{
				{Title: "TASK ID"}, {Title: "TYPE"}, {Title: "MODEL"}, {Title: "STATUS"},
				{Title: "PROGRESS", Align: render.AlignRight}, {Title: "COST", Align: render.AlignRight},
				{Title: "CREATED"},
			}, lf.applyLimit(rows))
			return nil
		},
	}
	lf.add(cmd, "created")
	tf.add(cmd)
	f := cmd.Flags()
	f.StringVar(&taskID, "task-id", "", "filter by task id")
	f.StringVar(&action, "action", "", "filter by action")
	return cmd
}

func newTaskShowCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "show <task-id>",
		Short: "Show one task record",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, c, err := relayClient()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			t, err := cl.GetTask(ctx, args[0])
			if err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(t)
			}
			w.Detail("Task "+t.ID, []render.Field{{Label: "Type", Value: orDash(t.Type)},
				{Label: "Action", Value: orDash(t.Action)},
				{Label: "Model", Value: orDash(t.Model)},
				{Label: "Status", Value: w.StatusColor(t.Status)},
				{Label: "Progress", Value: fmt.Sprintf("%d%%", t.Progress)}, {Label: "Cost", Value: w.Money(float64(t.Quota))},
				{Label: "Created", Value: w.Time(t.CreatedAt)},
				{Label: "Images", Value: strconv.Itoa(len(t.Result.Images))},
				{Label: "Videos", Value: strconv.Itoa(len(t.Result.Videos))},
			})
			_ = c
			return nil
		},
	}
}
