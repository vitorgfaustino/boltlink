/* Copyright (c) 2026 Vitor Faustino — AGPL-3.0 */

/** Manual retention only. No scheduler or environment flag. */
export const TRASH_RETENTION_DAYS = 90;
export const TRASH_PAGE_SIZE = 100;

export function trashCutoff(now: Date): string {
	return new Date(now.getTime() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/** Compare explicit ISO instants, never SQLite's numeric Julian-day coercion.
 * Round-trip the civil prefix to refuse impossible dates before comparing UTC.
 * Legacy offsets are accepted; naive, malformed and numeric values remain inspectable.
 */
export const TRASH_ELIGIBLE_SQL = `disabled_at IS NOT NULL
	AND substr(disabled_at, 1, 19) GLOB '????-??-??T??:??:??'
	AND (substr(disabled_at, -1) = 'Z'
		OR (substr(disabled_at, -6, 1) IN ('+', '-') AND substr(disabled_at, -3, 1) = ':'))
	AND strftime('%Y-%m-%dT%H:%M:%S', substr(disabled_at, 1, 19), '+0 seconds') = substr(disabled_at, 1, 19)
	AND julianday(disabled_at) <= julianday(?)`;
