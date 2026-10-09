// =============================================================================
// Job handlers: the actual "work". Each kind of job maps to one async function.
//
// These are fake (they sleep and fail at random) so you can watch the queue's
// retries, backoff and crash recovery on the dashboard.
//
// Because delivery is AT-LEAST-ONCE, a handler can run more than once for the
// same job (e.g. we sent the email, then crashed before reporting success).
// Real handlers must be idempotent: pass `job.id` as an idempotency key to the
// email/payment provider, use `insert ... on conflict do nothing`, etc.
// =============================================================================

// Thrown for errors that retrying can't fix: the job goes straight to "failed".
// (BullMQ calls this UnrecoverableError.)
export class PermanentError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const between = (min, max) => min + Math.random() * (max - min);

export const handlers = {
  // Usually works; sometimes the "SMTP server" times out and we retry.
  async send_email(job) {
    await sleep(between(300, 1200));
    if (Math.random() < 0.15) throw new Error("SMTP timeout");
    return { messageId: `msg-${job.id}`, idempotencyKey: job.id };
  },

  async resize_image(job) {
    await sleep(between(1000, 3000));
    return { width: job.payload.width ?? 800, format: "webp" };
  },

  // Fails most of the time: watch attempts climb and run_at back off 2s, 4s, 8s...
  async flaky() {
    await sleep(between(200, 600));
    if (Math.random() < 0.7) throw new Error("Random failure (70% of the time)");
    return { luck: "finally" };
  },

  async always_fails() {
    await sleep(300);
    throw new Error("This job always fails: watch it use up all its attempts");
  },

  // Runs longer than the 15s lease. It survives only because the heartbeat
  // keeps extending the lease while we're working.
  async slow(job) {
    const seconds = Number(job.payload.seconds ?? 30);
    await sleep(seconds * 1000);
    return { sleptSeconds: seconds };
  },

  // Simulates the worker process dying mid-job (OOM, kill -9, power cut).
  // No "fail" is reported. The job stays "running" until its lease expires,
  // then another worker picks it up again: at-least-once in action.
  // (Docker restarts this worker thanks to `restart: unless-stopped`.)
  async crash(job) {
    console.log(`[job ${job.id}] crashing the whole worker process on purpose`);
    await sleep(500);
    process.exit(1);
  },

  async needs_email(job) {
    if (!job.payload.to) throw new PermanentError("payload.to is required (won't retry)");
    await sleep(500);
    return { sentTo: job.payload.to };
  },
};
