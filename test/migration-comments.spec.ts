import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

// SQLite quoting keeps comment markers inside strings/identifiers out of comments.
function commentSemicolons(sql: string): number[] {
	const offsets: number[] = [];
	let state: "code" | "line" | "block" | "quote" = "code";
	let closingQuote = "";
	for (let i = 0; i < sql.length; i++) {
		const char = sql[i];
		const next = sql[i + 1];
		if (state === "line" || state === "block") {
			if (char === ";") offsets.push(i);
			if (state === "line" && (char === "\n" || char === "\r")) state = "code";
			else if (state === "block" && char === "*" && next === "/") {
				state = "code";
				i++;
			}
		} else if (state === "quote") {
			if (char === closingQuote) {
				if (closingQuote !== "]" && next === closingQuote) i++;
				else state = "code";
			}
		} else if (char === "-" && next === "-") {
			state = "line";
			i++;
		} else if (char === "/" && next === "*") {
			state = "block";
			i++;
		} else if (["'", '"', "`", "["].includes(char)) {
			state = "quote";
			closingQuote = char === "[" ? "]" : char;
		}
	}
	return offsets;
}

describe("D1 migration comment parser compatibility", () => {
	it("rejects semicolons in line comments, including at EOF", () => {
		const sql = "SELECT 1; -- explanation; continuation\r\n-- final;";
		expect(commentSemicolons(sql)).toEqual([sql.indexOf("; continuation"), sql.lastIndexOf(";")]);
	});

	it("rejects semicolons throughout multiline block comments", () => {
		const sql = "/* explanation;\n -- still a block; */ SELECT 1; /* final; */";
		expect(commentSemicolons(sql)).toEqual([
			sql.indexOf(";"), sql.indexOf("; */"), sql.lastIndexOf("; */"),
		]);
	});

	it("allows executable semicolons and comment markers in SQLite quoted values and identifiers", () => {
		const sql = "CREATE TABLE x ([--field;] TEXT, `/*field;*/` TEXT, \"a\"\"--;\" TEXT);\n"
			+ "INSERT INTO x VALUES ('it''s -- text; /* text; */', 'a;b', 'c');\n"
			+ "PRAGMA foreign_keys = ON; -- valid comment\n/* valid comment */ SELECT 1;";
		expect(commentSemicolons(sql)).toEqual([]);
	});

	it("resumes scanning after quoted values and closed comments", () => {
		const sql = "SELECT '--;'; /* safe */ -- forbidden;\nSELECT '/*;*/'; /* forbidden; */";
		expect(commentSemicolons(sql)).toEqual([sql.indexOf(";\n"), sql.lastIndexOf("; */")]);
	});

	it("scans every current and future top-level SQL migration", () => {
		const files = readdirSync("migrations").filter((name) => name.endsWith(".sql")).sort();
		expect(files.length).toBeGreaterThan(0);
		const violations = files.flatMap((file) => {
			const sql = readFileSync(`migrations/${file}`, "utf8");
			return commentSemicolons(sql).map((offset) => `${file}:${sql.slice(0, offset).split(/\r\n|\r|\n/).length}`);
		});
		expect(violations, "Semicolons inside SQL comments break remote migration parsing").toEqual([]);
	});
});
