// Every call to the database goes through this one function:
//   rpc("add_todo", { title: "x" }, token)
//   -> POST /api/rpc/add_todo  -> select api.add_todo('{"title":"x"}')
export async function rpc(fn, args = {}, token) {
  const res = await fetch(`/api/rpc/${fn}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(args),
  });
  const body = await res.json();
  if (!res.ok) {
    const error = new Error(body.error ?? `Request failed (${res.status})`);
    error.status = res.status;
    throw error;
  }
  return body;
}

// Many calls at the SAME moment, each in its own transaction on its own
// connection (the gateway starts them together). One entry per call:
//   { ok, result | error + code, startedAt, finishedAt }
export async function rpcBatch(calls, token) {
  const res = await fetch("/api/rpc-batch", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ calls }),
  });
  const body = await res.json();
  if (!res.ok) {
    const error = new Error(body.error ?? `Request failed (${res.status})`);
    error.status = res.status;
    throw error;
  }
  return body;
}

// Realtime: the server pushes an event whenever one of OUR rows changes.
// event = "todo" (app.todos) or "job" (app.jobs)
export function subscribe(token, event, onChange) {
  const source = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  source.addEventListener(event, (e) => onChange(JSON.parse(e.data)));
  return () => source.close();
}
