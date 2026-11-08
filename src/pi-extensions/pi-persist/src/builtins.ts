/**
 * Built-in values available to declarative item templates.
 *
 * The extension already answers "what time is it" with a built-in clock contribution. Declarative
 * items need the same kind of value, so both paths resolve through this module — one formatter, one
 * definition of what a datetime string looks like. Adding a built-in here makes it available to
 * every item without touching the renderer.
 */

export type BuiltinName = keyof typeof BUILTINS;

export interface BuiltinContext {
	now?: Date;
}

/** Format variants accepted as `{{datetime:iso}}`. `local` is the default. */
export type DatetimeVariant = "local" | "iso" | "date" | "time" | "unix";

const LOCAL_FORMAT = new Intl.DateTimeFormat("en-GB", {
	// Weekday first: it is the part a model most often gets wrong from a bare timestamp, and the
	// part a human reads first when orienting.
	weekday: "long",
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
	hour12: false,
	timeZoneName: "short",
});

const DATE_FORMAT = new Intl.DateTimeFormat("en-GB", {
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
});

const TIME_FORMAT = new Intl.DateTimeFormat("en-GB", {
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
	hour12: false,
	timeZoneName: "short",
});

/**
 * The current instant.
 *
 * `local` carries the weekday and an explicit zone ("Wednesday, 28/10/2026, 01:32:44 GMT-4")
 * because a bare timestamp is
 * ambiguous to a model that does not know where the host is, and answering "when is it" is the
 * whole point. `iso` is offered for anything that needs to sort or parse.
 */
export function formatDatetime(now: Date, variant: DatetimeVariant = "local"): string {
	switch (variant) {
		case "iso":
			return now.toISOString();
		case "date":
			return DATE_FORMAT.format(now);
		case "time":
			return TIME_FORMAT.format(now);
		case "unix":
			return String(Math.floor(now.getTime() / 1000));
		default:
			return LOCAL_FORMAT.format(now);
	}
}

export function isDatetimeVariant(value: string): value is DatetimeVariant {
	return value === "local" || value === "iso" || value === "date" || value === "time" || value === "unix";
}

/**
 * Built-ins, resolved by name. Each takes the render context and an optional argument.
 *
 * This is the whole list by design: a closed set keeps a config file from being able to run code.
 * `datetime` is the only one for now.
 */
export const BUILTINS = {
	datetime: (context: BuiltinContext, argument?: string): string =>
		formatDatetime(
			context.now ?? new Date(),
			argument !== undefined && isDatetimeVariant(argument) ? argument : "local",
		),
} as const;

export function isBuiltin(name: string): name is BuiltinName {
	return Object.hasOwn(BUILTINS, name);
}

/** Names accepted in `{{…}}`, for docs and for the CLI to print. */
export function builtinNames(): BuiltinName[] {
	return Object.keys(BUILTINS) as BuiltinName[];
}
