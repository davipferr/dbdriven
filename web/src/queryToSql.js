// The query builder's AST -> readable SQL, for the live preview ONLY.
//
// This string is never sent anywhere or executed. The server rebuilds the SQL
// from the same JSON in api.run_query (db/init/04_api.sql), with its own
// whitelist. If the server ran SQL text from the browser, anyone could send
// `drop table app.todos` with curl, so client-side checks are only for UX.
//
//   { from, select: [...], where: [{ column, op, value }], orderBy: { column, dir }, limit }
//   -> SELECT ... FROM app.todos WHERE ... ORDER BY ... LIMIT ...;

// Only lowercase names like `created_at` can go unquoted, like Postgres' quote_ident.
const ident = (name) => (/^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${String(name).replace(/"/g, '""')}"`);

// A string literal: double any single quotes, like Postgres' quote_literal (%L).
const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;

// Values travel as strings. Here they're shown the way you'd type them in psql.
function literal(value, type) {
  if (type === "boolean" && (value === "true" || value === "false")) return value;
  if (type === "bigint" && /^-?\d+$/.test(value)) return value;
  return quote(value);
}

export const NO_VALUE_OPS = ["is null", "is not null"];

export function queryToSql(query, schema) {
  const types = Object.fromEntries(schema.columns.map((c) => [c.name, c.type]));
  const columns = query.select?.length ? query.select : schema.columns.map((c) => c.name);

  const lines = [`SELECT ${columns.map(ident).join(", ")}`, `FROM app.${ident(query.from ?? schema.table)}`];

  const conditions = (query.where ?? []).map(({ column, op, value }) =>
    NO_VALUE_OPS.includes(op)
      ? `${ident(column)} ${op.toUpperCase()}`
      : `${ident(column)} ${op.toUpperCase()} ${literal(value ?? "", types[column])}`,
  );
  if (conditions.length) lines.push(`WHERE ${conditions.join("\n  AND ")}`);

  if (query.orderBy) lines.push(`ORDER BY ${ident(query.orderBy.column)} ${(query.orderBy.dir ?? "asc").toUpperCase()}`);
  if (query.limit != null) lines.push(`LIMIT ${query.limit}`);

  return `${lines.join("\n")};`;
}
