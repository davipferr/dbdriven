// The query builder's AST -> readable SQL, for the live preview ONLY.
//
// This string is never sent anywhere or executed. The server rebuilds the SQL
// from the same JSON in qb.build (db/init/06_query_builder.sql), with its own
// whitelist. If the server ran SQL text from the browser, anyone could send
// `drop table app.todos` with curl, so client-side checks are only for UX.
//
// It mirrors qb.build's rules, so the two outputs differ only in style:
//   - columns are "table.column" in the AST; plain names when there's no join
//   - nothing selected = all columns in scope (or group keys + count(*) when grouped)

export const NO_VALUE_OPS = ["is null", "is not null"];

// Only lowercase names like `created_at` can go unquoted, like Postgres' quote_ident.
const ident = (name) => (/^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${String(name).replace(/"/g, '""')}"`);

// A string literal: double any single quotes, like Postgres' quote_literal (%L).
const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;

export const isAggregate = (item) => typeof item === "object" && item !== null && "fn" in item;

// The tables a query can reference: the base table, plus the joined one.
export const tablesInScope = (query, schema) => (query.join ? [schema.from, query.join.table] : [schema.from]);

// Every column in scope, in schema order: [{ key: "todos.id", table, name, type, ops }]
export function columnsInScope(query, schema) {
  return tablesInScope(query, schema).flatMap((table) =>
    schema.tables[table].map((c) => ({ ...c, table, key: `${table}.${c.name}` })),
  );
}

export function columnLabel(key, tables) {
  return tables.length > 1 ? key : key.split(".")[1];
}

// How a select item reads: "title", "tags.name", "count(*)", "max(todos.created_at)".
export function itemLabel(item, tables) {
  if (!isAggregate(item)) return columnLabel(item, tables);
  return `${item.fn}(${item.column === "*" ? "*" : columnLabel(item.column, tables)})`;
}

function columnSql(key, tables) {
  const [table, name] = key.split(".");
  return tables.length > 1 ? `${ident(table)}.${ident(name)}` : ident(name);
}

function itemSql(item, tables) {
  if (!isAggregate(item)) return columnSql(item, tables);
  return `${item.fn.toUpperCase()}(${item.column === "*" ? "*" : columnSql(item.column, tables)})`;
}

// Values travel as strings. Here they're shown the way you'd type them in psql.
function literal(value, type) {
  if (type === "boolean" && (value === "true" || value === "false")) return value;
  if (type === "bigint" && /^-?\d+$/.test(value)) return value;
  return quote(value);
}

export function isGrouped(query) {
  return query.groupBy?.length > 0 || query.select?.some(isAggregate) || isAggregate(query.orderBy);
}

// What the server will select when nothing is picked.
export function effectiveSelect(query, schema) {
  if (query.select?.length) return query.select;
  if (isGrouped(query)) return [...(query.groupBy ?? []), { fn: "count", column: "*" }];
  return columnsInScope(query, schema).map((c) => c.key);
}

export function queryToSql(query, schema) {
  const tables = tablesInScope(query, schema);
  const types = Object.fromEntries(columnsInScope(query, schema).map((c) => [c.key, c.type]));

  const lines = [
    `SELECT ${effectiveSelect(query, schema).map((item) => itemSql(item, tables)).join(", ")}`,
    `FROM app.${ident(schema.from)}`,
  ];

  if (query.join) {
    const type = query.join.type === "left" ? "LEFT JOIN" : "JOIN";
    for (const step of schema.joins[query.join.table].steps) {
      lines.push(`  ${type} app.${ident(step.table)} ON ${step.on}`);
    }
  }

  const conditions = (query.where ?? []).map(({ column, op, value }) =>
    NO_VALUE_OPS.includes(op)
      ? `${columnSql(column, tables)} ${op.toUpperCase()}`
      : `${columnSql(column, tables)} ${op.toUpperCase()} ${literal(value ?? "", types[column])}`,
  );
  if (conditions.length) lines.push(`WHERE ${conditions.join("\n  AND ")}`);

  if (query.groupBy?.length) lines.push(`GROUP BY ${query.groupBy.map((key) => columnSql(key, tables)).join(", ")}`);

  if (query.orderBy) {
    const item = isAggregate(query.orderBy) ? query.orderBy : query.orderBy.column;
    lines.push(`ORDER BY ${itemSql(item, tables)} ${(query.orderBy.dir ?? "asc").toUpperCase()}`);
  }
  if (query.limit != null) lines.push(`LIMIT ${query.limit}`);

  return `${lines.join("\n")};`;
}
