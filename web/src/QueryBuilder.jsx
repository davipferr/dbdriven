import { useCallback, useEffect, useRef, useState } from "react";
import { rpc } from "./api.js";
import {
  NO_VALUE_OPS,
  columnLabel,
  columnsInScope,
  effectiveSelect,
  isAggregate,
  itemLabel,
  queryToSql,
  tablesInScope,
} from "./queryToSql.js";

// The query is DATA (an AST). Every control below just edits this object;
// the SQL preview and the requests to api.run_query / api.explain_query are
// all derived from it.
const BASE = { from: "todos", select: [], where: [], groupBy: [], orderBy: null, limit: 20 };
const COUNT = { fn: "count", column: "*" };

const PRESETS = [
  {
    name: "Open todos about buying",
    hint: "One table: WHERE, ORDER BY, LIMIT.",
    query: {
      ...BASE,
      select: ["todos.id", "todos.title", "todos.created_at"],
      where: [
        { column: "todos.done", op: "=", value: "false" },
        { column: "todos.title", op: "ilike", value: "%buy%" },
      ],
      orderBy: { column: "todos.created_at", dir: "desc" },
    },
  },
  {
    name: "Open todos per tag",
    hint: "JOIN through todo_tags, then GROUP BY: one row per tag instead of per todo.",
    query: {
      ...BASE,
      join: { table: "tags", type: "inner" },
      select: ["tags.name", COUNT],
      where: [{ column: "todos.done", op: "=", value: "false" }],
      groupBy: ["tags.name"],
      orderBy: { ...COUNT, dir: "desc" },
    },
  },
  {
    name: "Todos without tags",
    hint: "LEFT JOIN keeps todos with no match; their tags.* columns come back NULL.",
    query: {
      ...BASE,
      join: { table: "tags", type: "left" },
      select: ["todos.id", "todos.title"],
      where: [{ column: "tags.id", op: "is null" }],
    },
  },
  {
    name: "count(*) vs count(tags.id)",
    hint: "count(*) counts rows, count(col) skips NULLs: an untagged todo is 1 row but 0 tags.",
    query: {
      ...BASE,
      join: { table: "tags", type: "left" },
      select: ["todos.title", COUNT, { fn: "count", column: "tags.id" }],
      groupBy: ["todos.id", "todos.title"],
      orderBy: { column: "todos.id", dir: "asc" },
    },
  },
  {
    name: "Newest todo per tag",
    hint: "max() of a timestamp inside each group.",
    query: {
      ...BASE,
      join: { table: "tags", type: "inner" },
      select: ["tags.name", { fn: "max", column: "todos.created_at" }],
      groupBy: ["tags.name"],
      orderBy: { fn: "max", column: "todos.created_at", dir: "desc" },
    },
  },
];

// Hand-written ASTs that skip the builder's dropdowns, like an attacker using
// curl would. The server's whitelist (or %L quoting) has to handle each one.
const ATTACKS = [
  { name: "Inject through a column name", query: { select: ["todos.title; drop table app.todos"] } },
  { name: "Read password hashes", query: { from: "users", select: ["users.password_hash"] } },
  { name: "Join the users table", query: { join: { table: "users" } } },
  { name: "Write your own JOIN condition", query: { join: { table: "tags", type: "inner", on: "true" } } },
  { name: "Call any function as an aggregate", query: { select: [{ fn: "pg_sleep", column: "todos.id" }] } },
  { name: "Inject through the operator", query: { where: [{ column: "todos.done", op: "= true or 1=1 --", value: "x" }] } },
  { name: "Inject through a value", query: { where: [{ column: "todos.title", op: "=", value: "x'; delete from app.todos; --" }] } },
  { name: "Inject through the sort direction", query: { orderBy: { column: "todos.id", dir: "desc; drop table app.todos" } } },
  { name: "Ask for a million rows", query: { select: ["todos.id"], limit: 1000000 } },
];

export default function QueryBuilder({ token, onUnauthorized }) {
  const [schema, setSchema] = useState(null);
  const [query, setQuery] = useState(PRESETS[0].query);
  const [result, setResult] = useState(null); // { sql, columns, rows } | { error }
  const [running, setRunning] = useState(false);
  const latest = useRef(0); // ignore responses that arrive after a newer request

  const run = useCallback(
    async (q) => {
      const id = ++latest.current;
      setRunning(true);
      try {
        const res = await rpc("run_query", q, token);
        if (id === latest.current) setResult(res);
      } catch (err) {
        if (err.status === 401) return onUnauthorized();
        if (id === latest.current) setResult({ error: err.message });
      } finally {
        if (id === latest.current) setRunning(false);
      }
    },
    [token, onUnauthorized],
  );

  // The whitelist lives in the database (qb.schema). The dropdowns come from
  // it, so they always offer exactly what qb.build will accept.
  useEffect(() => {
    rpc("query_schema", {}, token)
      .then(setSchema)
      .catch((err) => (err.status === 401 ? onUnauthorized() : setResult({ error: err.message })));
  }, [token, onUnauthorized]);

  const incomplete = query.where.some((f) => !NO_VALUE_OPS.includes(f.op) && f.value === "");

  // Live results: re-run shortly after every edit, once the query is complete.
  useEffect(() => {
    if (!schema || incomplete) return;
    const timer = setTimeout(() => run(query), 300);
    return () => clearTimeout(timer);
  }, [schema, query, incomplete, run]);

  if (!schema) return <p className="muted">{result?.error ?? "Loading…"}</p>;

  const set = (patch) => setQuery((q) => ({ ...q, ...patch }));
  const preset = PRESETS.find((p) => p.query === query);

  return (
    <div className="qb">
      <div className="qb-presets">
        <span className="muted">Try:</span>
        {PRESETS.map((p) => (
          <button key={p.name} className={p === preset ? "chip active" : "chip"} onClick={() => setQuery(p.query)}>
            {p.name}
          </button>
        ))}
        {preset && <p className="muted hint">{preset.hint}</p>}
      </div>

      <div className="qb-top">
        <Builder schema={schema} query={query} set={set} />
        <div className="qb-code">
          <section>
            <h2>SQL preview <span className="muted">(built in your browser, never executed)</span></h2>
            <pre className="sql">{queryToSql(query, schema)}</pre>
          </section>
          <section>
            <h2>What gets sent: <code>POST /api/rpc/run_query</code></h2>
            <pre>{JSON.stringify(query, null, 2)}</pre>
          </section>
        </div>
      </div>

      <section>
        <div className="section-head">
          <h2>
            Results {result?.rows && <span className="muted">· {result.rows.length} rows</span>}
            {running && <span className="muted"> · running…</span>}
          </h2>
          <button onClick={() => run(query)} disabled={incomplete}>Run</button>
        </div>
        {incomplete && <p className="muted">Fill in every filter value to run the query.</p>}
        {result?.error && <p className="error">{result.error}</p>}
        {result?.sql && (
          <p className="qb-server-sql">
            <span className="muted">
              Postgres executed (rebuilt from the JSON by <code>qb.build</code>, then RLS added your <code>user_id</code> to every table):
            </span>
            <code>{result.sql}</code>
          </p>
        )}
        {result?.rows && <ResultsTable columns={result.columns} rows={result.rows} />}
      </section>

      <Explain token={token} query={query} disabled={incomplete} onUnauthorized={onUnauthorized} />
      <Attacks token={token} onUnauthorized={onUnauthorized} />
    </div>
  );
}

// ---------- The builder: each control edits one part of the AST ----------

function Builder({ schema, query, set }) {
  const tables = tablesInScope(query, schema);
  const columns = columnsInScope(query, schema);
  const byKey = Object.fromEntries(columns.map((c) => [c.key, c]));
  const defaultValue = (col) => (col.type === "boolean" ? "false" : "");
  const plain = query.select.filter((i) => !isAggregate(i));
  const aggregates = query.select.filter(isAggregate);

  function setJoin(type) {
    if (type) return set({ join: { table: "tags", type } });
    // No join any more: drop everything that pointed at the joined table.
    const gone = (key) => key.split(".")[0] !== schema.from;
    const itemGone = (item) => (isAggregate(item) ? item.column !== "*" && gone(item.column) : gone(item));
    set({
      join: undefined, // undefined = left out of the JSON
      select: query.select.filter((i) => !itemGone(i)),
      where: query.where.filter((f) => !gone(f.column)),
      groupBy: query.groupBy.filter((k) => !gone(k)),
      orderBy: query.orderBy && itemGone(isAggregate(query.orderBy) ? query.orderBy : query.orderBy.column) ? null : query.orderBy,
    });
  }

  // Plain columns keep the schema's order; aggregates follow in the order added.
  function toggleColumn(key) {
    const picked = plain.includes(key) ? plain.filter((k) => k !== key) : [...plain, key];
    set({ select: [...columns.map((c) => c.key).filter((k) => picked.includes(k)), ...aggregates] });
  }

  function toggleGroup(key) {
    const picked = query.groupBy.includes(key) ? query.groupBy.filter((k) => k !== key) : [...query.groupBy, key];
    set({ groupBy: columns.map((c) => c.key).filter((k) => picked.includes(k)) });
  }

  // Columns an aggregate accepts: "*" (count only) and columns of a fitting type.
  const aggregateOptions = (fn) => [
    ...(schema.aggregates[fn].includes("*") ? ["*"] : []),
    ...columns.filter((c) => schema.aggregates[fn].includes(c.type)).map((c) => c.key),
  ];

  function updateAggregate(i, patch) {
    const next = { ...aggregates[i], ...patch };
    if (!aggregateOptions(next.fn).includes(next.column)) next.column = aggregateOptions(next.fn)[0];
    set({ select: [...plain, ...aggregates.map((a, j) => (j === i ? next : a))] });
  }

  function updateFilter(i, patch) {
    set({ where: query.where.map((f, j) => (j === i ? toFilter({ ...f, ...patch }) : f)) });
  }

  // Normalizes a filter after an edit: a new column may not support the old
  // operator, and IS NULL takes no value.
  function toFilter({ column, op, value }) {
    const col = byKey[column];
    if (!col.ops.includes(op)) op = col.ops[0];
    if (NO_VALUE_OPS.includes(op)) return { column, op };
    return { column, op, value: value ?? defaultValue(col) };
  }

  function addFilter() {
    const col = byKey[`${schema.from}.done`] ?? columns[0];
    set({ where: [...query.where, { column: col.key, op: col.ops[0], value: defaultValue(col) }] });
  }

  // ORDER BY picks from the columns and the aggregates. Encode both as strings for <select>.
  const orderValue = (o) => (!o ? "" : isAggregate(o) ? `agg:${o.fn}:${o.column}` : o.column);
  const orderAggregates = [...aggregates];
  if (isAggregate(query.orderBy) && !aggregates.some((a) => orderValue(a) === orderValue(query.orderBy))) {
    orderAggregates.push(query.orderBy);
  }
  function setOrder(value) {
    const dir = query.orderBy?.dir ?? "asc";
    if (!value) return set({ orderBy: null });
    if (value.startsWith("agg:")) {
      const [, fn, column] = value.split(":");
      return set({ orderBy: { fn, column, dir } });
    }
    set({ orderBy: { column: value, dir } });
  }

  // <option>s for "pick a column", grouped by table once there's a join.
  const columnOptions = (filter = () => true) =>
    tables.map((t) => {
      const opts = columns.filter((c) => c.table === t && filter(c)).map((c) => (
        <option key={c.key} value={c.key}>{columnLabel(c.key, tables)}</option>
      ));
      return tables.length > 1 ? <optgroup key={t} label={t}>{opts}</optgroup> : opts;
    });

  return (
    <div className="qb-builder">
      <section>
        <h3>From</h3>
        <div className="qb-row">
          <select value={query.from} disabled>
            <option value={schema.from}>app.{schema.from}</option>
          </select>
          <select value={query.join?.type ?? ""} onChange={(e) => setJoin(e.target.value)}>
            <option value="">no join</option>
            <option value="inner">JOIN tags (only tagged todos)</option>
            <option value="left">LEFT JOIN tags (every todo)</option>
          </select>
        </div>
      </section>

      <section>
        <h3>Select <span className="muted">(none = {query.groupBy.length || aggregates.length ? "group keys + count(*)" : "all"})</span></h3>
        {tables.map((t) => (
          <div key={t} className="qb-chips">
            {tables.length > 1 && <span className="qb-table">{t}</span>}
            {columns.filter((c) => c.table === t).map((c) => (
              <label key={c.key} className={plain.includes(c.key) ? "chip active" : "chip"}>
                <input type="checkbox" checked={plain.includes(c.key)} onChange={() => toggleColumn(c.key)} />
                {c.name}
              </label>
            ))}
          </div>
        ))}
        {aggregates.map((a, i) => (
          <div key={i} className="qb-row">
            <select value={a.fn} onChange={(e) => updateAggregate(i, { fn: e.target.value })}>
              {Object.keys(schema.aggregates).map((fn) => <option key={fn}>{fn}</option>)}
            </select>
            <select value={a.column} onChange={(e) => updateAggregate(i, { column: e.target.value })}>
              {schema.aggregates[a.fn].includes("*") && <option value="*">*</option>}
              {columnOptions((c) => schema.aggregates[a.fn].includes(c.type))}
            </select>
            <button className="link" title="Remove aggregate" onClick={() => set({ select: [...plain, ...aggregates.filter((_, j) => j !== i)] })}>✕</button>
          </div>
        ))}
        <button className="link" onClick={() => set({ select: [...plain, ...aggregates, COUNT] })}>+ Add aggregate</button>
      </section>

      <section>
        <h3>Where <span className="muted">(all must match)</span></h3>
        {query.where.map((f, i) => (
          <div key={i} className="qb-row">
            <select
              value={f.column}
              onChange={(e) => updateFilter(i, { column: e.target.value, value: defaultValue(byKey[e.target.value]) })}
            >
              {columnOptions()}
            </select>
            <select value={f.op} onChange={(e) => updateFilter(i, { op: e.target.value })}>
              {byKey[f.column].ops.map((op) => <option key={op}>{op}</option>)}
            </select>
            {!NO_VALUE_OPS.includes(f.op) && (
              <ValueInput type={byKey[f.column].type} op={f.op} value={f.value} onChange={(value) => updateFilter(i, { value })} />
            )}
            <button className="link" title="Remove filter" onClick={() => set({ where: query.where.filter((_, j) => j !== i) })}>✕</button>
          </div>
        ))}
        <button className="link" onClick={addFilter}>+ Add filter</button>
      </section>

      <section>
        <h3>Group by <span className="muted">(one result row per distinct value)</span></h3>
        {tables.map((t) => (
          <div key={t} className="qb-chips">
            {tables.length > 1 && <span className="qb-table">{t}</span>}
            {columns.filter((c) => c.table === t).map((c) => (
              <label key={c.key} className={query.groupBy.includes(c.key) ? "chip active" : "chip"}>
                <input type="checkbox" checked={query.groupBy.includes(c.key)} onChange={() => toggleGroup(c.key)} />
                {c.name}
              </label>
            ))}
          </div>
        ))}
      </section>

      <section className="qb-inline">
        <div>
          <h3>Order by</h3>
          <div className="qb-row">
            <select value={orderValue(query.orderBy)} onChange={(e) => setOrder(e.target.value)}>
              <option value="">(none)</option>
              {columnOptions()}
              {orderAggregates.length > 0 && (
                <optgroup label="aggregates">
                  {orderAggregates.map((a) => (
                    <option key={orderValue(a)} value={orderValue(a)}>{itemLabel(a, tables)}</option>
                  ))}
                </optgroup>
              )}
            </select>
            {query.orderBy && (
              <select value={query.orderBy.dir} onChange={(e) => set({ orderBy: { ...query.orderBy, dir: e.target.value } })}>
                <option value="asc">ascending</option>
                <option value="desc">descending</option>
              </select>
            )}
          </div>
        </div>
        <div>
          <h3>Limit</h3>
          <input
            type="number" min="1" max={schema.maxLimit} value={query.limit ?? ""}
            onChange={(e) => set({ limit: e.target.value === "" ? null : Number(e.target.value) })}
          />
        </div>
      </section>

      <p className="muted hint">
        Will select: <code>{effectiveSelect(query, schema).map((i) => itemLabel(i, tables)).join(", ")}</code>
      </p>
    </div>
  );
}

// Values are always strings in the AST; Postgres casts them to the column type.
function ValueInput({ type, op, value, onChange }) {
  if (type === "boolean") {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option>false</option>
        <option>true</option>
      </select>
    );
  }
  if (type === "bigint") return <input type="number" value={value} onChange={(e) => onChange(e.target.value)} />;
  if (type === "timestamptz") return <input type="date" value={value} onChange={(e) => onChange(e.target.value)} />;
  return (
    <input
      value={value}
      placeholder={op.includes("ilike") ? "%buy%  (% = anything)" : "exact text"}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

// Rows arrive as arrays, in the same order as `columns` (with a join,
// todos.id and tags.id would collide as keys of a JSON object).
function ResultsTable({ columns, rows }) {
  if (rows.length === 0) return <p className="muted">No rows match.</p>;
  return (
    <div className="qb-scroll">
      <table className="table">
        <thead>
          <tr>{columns.map((c, i) => <th key={i}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((value, j) => <td key={j}>{formatCell(value)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatCell(value) {
  if (value === null) return <span className="muted">null</span>;
  if (typeof value === "boolean") return <code>{String(value)}</code>;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) return new Date(value).toLocaleString();
  return String(value);
}

// ---------- Explain: HOW did Postgres run it? ----------

const USER_INDEX = "todos_user_id_idx"; // `create index on app.todos (user_id)` in 02_schema.sql

function Explain({ token, query, disabled, onUnauthorized }) {
  const [explained, setExplained] = useState(null); // { ...api result, for: JSON of the query }
  const [noSeqscan, setNoSeqscan] = useState(false);
  const [table, setTable] = useState(null); // { rows, pages }: the planner's view of app.todos
  const [removed, setRemoved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const call = useCallback(
    async (fn, args) => {
      setError(null);
      setBusy(true);
      try {
        return await rpc(fn, args, token);
      } catch (err) {
        if (err.status === 401) onUnauthorized();
        else setError(err.message);
      } finally {
        setBusy(false);
      }
    },
    [token, onUnauthorized],
  );

  async function explain(disableSeqscan = noSeqscan) {
    const res = await call("explain_query", { query, disableSeqscan });
    if (res) {
      setExplained({ ...res, for: JSON.stringify(query) });
      setTable({ rows: res.tableRows, pages: res.tablePages });
    }
  }

  async function seed(fn) {
    const res = await call(fn, {});
    if (res) {
      setRemoved(fn === "remove_demo_data");
      setTable({ rows: res.tableRows, pages: null });
      if (explained) explain();
    }
  }

  const stale = explained && explained.for !== JSON.stringify(query);

  return (
    <section className="qb-explain">
      <div className="section-head">
        <h2>Explain <span className="muted">(EXPLAIN ANALYZE: how Postgres ran it)</span></h2>
        <button onClick={() => explain()} disabled={disabled || busy}>Explain</button>
      </div>

      <div className="qb-explain-controls">
        <label>
          <input
            type="checkbox" checked={noSeqscan}
            onChange={(e) => { setNoSeqscan(e.target.checked); if (explained) explain(e.target.checked); }}
          />
          Discourage sequential scans (<code>set enable_seqscan = off</code>)
        </label>
        <span className="muted">
          app.todos: {!table ? "?" : table.rows < 0 ? "never analyzed" : `≈${table.rows.toLocaleString()} rows`}
          {table?.pages != null && ` in ${table.pages.toLocaleString()} pages of 8 kB`}, all users
        </span>
        <button className="link" onClick={() => seed("seed_demo_data")} disabled={busy}>Seed 20,000 rows from 200 other users</button>
        <button className="link" onClick={() => seed("remove_demo_data")} disabled={busy}>Remove them</button>
      </div>

      {error && <p className="error">{error}</p>}
      {removed && (
        <p className="muted hint">
          Deleted rows stay in the table as dead tuples until autovacuum cleans them up (about a minute). Until then
          the table still has hundreds of pages for a few live rows, so Postgres may keep using the index. Explain
          again in a minute.
        </p>
      )}
      {explained && (
        <>
          {stale && <p className="muted">The query changed since this plan. Press Explain again.</p>}
          <Verdict result={explained} />
          <p className="muted qb-timing">
            Planning {explained.plan["Planning Time"].toFixed(2)} ms · execution {explained.plan["Execution Time"].toFixed(2)} ms
          </p>
          <ul className="plan">
            <PlanNode node={explained.plan.Plan} />
          </ul>
          <details>
            <summary className="muted">Raw EXPLAIN (FORMAT JSON)</summary>
            <pre>{JSON.stringify(explained.plan, null, 2)}</pre>
          </details>
        </>
      )}
      {!explained && (
        <p className="muted">
          Press Explain to see the plan. With only your own todos, expect a <strong>Seq Scan</strong>: reading a
          tiny table is cheaper than visiting an index first. Seed the demo rows and explain again.
        </p>
      )}
    </section>
  );
}

function planNodes(node) {
  return [node, ...(node.Plans ?? []).flatMap(planNodes)];
}

function Verdict({ result }) {
  const nodes = planNodes(result.plan.Plan);
  const viaIndex = nodes.find((n) => n["Index Name"] === USER_INDEX);
  const seq = nodes.find((n) => n["Node Type"] === "Seq Scan" && n["Relation Name"] === "todos");
  const small = result.tablePages < 10;

  if (viaIndex) {
    return (
      <p className="verdict good">
        ✓ Used <code>{USER_INDEX}</code> ({viaIndex["Node Type"]}): Postgres jumped straight to your rows instead of reading
        the whole table. The <code>user_id = $0</code> condition comes from the RLS policy.
        {result.seqscanDisabled && " (Seq scans were discouraged, so compare the costs with the box unchecked.)"}
      </p>
    );
  }
  if (seq) {
    return (
      <p className="verdict bad">
        ✗ Seq Scan on <code>todos</code>: Postgres read every row and kept the ones matching the RLS filter{" "}
        <code>user_id = $0</code>.{" "}
        {small
          ? `The table is only ${result.tablePages} page(s), so reading all of it is genuinely the cheapest plan. Seed the demo rows, or discourage seq scans, to see the index.`
          : "Your rows are a large share of the table, or the query needs most rows anyway."}
      </p>
    );
  }
  const other = nodes.find((n) => n["Relation Name"] === "todos" && n["Index Name"]);
  return (
    <p className="verdict">
      Postgres reached <code>todos</code> another way
      {other && <> (via <code>{other["Index Name"]}</code>, {other["Node Type"]})</>}. In a join it often starts from the
      other table and looks todos up by id, one per matching row. Read the tree below.
    </p>
  );
}

// Fields worth showing, in reading order.
const DETAILS = ["Index Cond", "Recheck Cond", "Hash Cond", "Merge Cond", "Join Filter", "Filter", "Group Key", "Sort Key"];

function PlanNode({ node }) {
  const loops = node["Actual Loops"];
  const tone =
    node["Index Name"] === USER_INDEX ? "good" : node["Node Type"] === "Seq Scan" && node["Relation Name"] === "todos" ? "bad" : "";
  return (
    <li>
      <div className={`plan-node ${tone}`}>
        <strong>{node["Node Type"]}</strong>
        {node["Join Type"] && node["Node Type"] !== "Hash" && <span> ({node["Join Type"].toLowerCase()})</span>}
        {node["Relation Name"] && <> on <code>app.{node["Relation Name"]}</code></>}
        {node["Index Name"] && <> using <code>{node["Index Name"]}</code></>}
        {/* The builder never writes subqueries, so an InitPlan can only come from an RLS policy. */}
        {node["Subplan Name"]?.startsWith("InitPlan") && (
          <span className="muted"> · {node["Subplan Name"]}: <code>(select auth.uid())</code> from the RLS policy, run once</span>
        )}
        <div className="plan-meta muted">
          {node["Plan Rows"]} rows estimated, {node["Actual Rows"]} actual{loops > 1 && ` × ${loops} loops`} ·{" "}
          {node["Actual Total Time"]} ms · cost {node["Total Cost"]}
          {node["Rows Removed by Filter"] > 0 && ` · ${node["Rows Removed by Filter"]} rows removed by filter`}
        </div>
        {DETAILS.filter((d) => node[d]).map((d) => (
          <div key={d} className="plan-meta">
            <span className="muted">{d}:</span> <code>{[].concat(node[d]).join(", ")}</code>
          </div>
        ))}
      </div>
      {node.Plans && (
        <ul>
          {node.Plans.map((child, i) => <PlanNode key={i} node={child} />)}
        </ul>
      )}
    </li>
  );
}

// ---------- Attacks: each hostile AST goes straight to the server ----------

function Attacks({ token, onUnauthorized }) {
  const [outcomes, setOutcomes] = useState({});

  async function attack(a) {
    try {
      const res = await rpc("run_query", a.query, token);
      setOutcomes((o) => ({ ...o, [a.name]: { ok: true, text: `Ran safely, ${res.rows.length} rows: ${res.sql}` } }));
    } catch (err) {
      if (err.status === 401) return onUnauthorized();
      setOutcomes((o) => ({ ...o, [a.name]: { ok: false, text: `Rejected (${err.status}): ${err.message}` } }));
    }
  }

  return (
    <section>
      <div className="section-head">
        <h2>Try to break it</h2>
        <button className="link" onClick={() => ATTACKS.forEach(attack)}>Run all</button>
      </div>
      <p className="muted">
        These skip the dropdowns and send hand-written JSON, like an attacker with curl would.
      </p>
      <table className="table qb-attacks">
        <thead>
          <tr><th>Attack</th><th>JSON sent</th><th>What the database did</th></tr>
        </thead>
        <tbody>
          {ATTACKS.map((a) => (
            <tr key={a.name}>
              <td><button className="link" onClick={() => attack(a)}>{a.name}</button></td>
              <td><code>{JSON.stringify(a.query)}</code></td>
              <td className={outcomes[a.name] ? (outcomes[a.name].ok ? "" : "error-text") : "muted"}>
                {outcomes[a.name]?.text ?? "not run yet"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
