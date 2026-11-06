import { InterruptedError } from "../termination.js";

// A judge whose CALL failed (the transport threw: an API error such as a 401, a timeout, a missing CLI) did not
// grade anything. A judge whose REPLY could not be read (no valid grade, an ambiguous one, a structured-output
// failure) did grade, badly. The two are told apart by where the throw came from, never by the message: the judges
// wrap whatever their `complete()` call throws in a `JudgeCallError`, and every other throw is a malformed grade.
// (`instanceof` the transport's own error class would not do: a timeout or a spawn failure rejects a plain `Error`.)

/** What a result records about a failed judge call. `message` is one line, scrubbed by the caller before it is stored. */
export interface JudgeCallInfo {
  status?: number;
  origin?: string;
  message: string;
  retryable: boolean;
}

export class JudgeCallError extends Error {
  readonly status: number | undefined;
  readonly origin: string | undefined;
  readonly apiMessage: string | undefined;
  readonly retryable: boolean;
  constructor(readonly cause: unknown) {
    const e = cause as { message?: unknown; status?: unknown; origin?: unknown; apiMessage?: unknown; retryable?: unknown };
    super(typeof e?.message === "string" ? e.message : String(cause));
    this.name = "JudgeCallError";
    this.status = typeof e?.status === "number" ? e.status : undefined;
    this.origin = typeof e?.origin === "string" ? e.origin : undefined;
    this.apiMessage = typeof e?.apiMessage === "string" ? e.apiMessage : undefined;
    // A plain Error from an injected test transport carries no flag: it keeps the old behaviour (retried).
    this.retryable = typeof e?.retryable === "boolean" ? e.retryable : true;
  }

  /** The one-line description a check message and a warning carry: the API status and the CLI's reason when the
   *  transport read them, else the first line of the transport's own message. */
  summary(): string {
    if (this.status !== undefined)
      return `API ${this.status}${this.origin ? `, ${this.origin}` : ""}${this.apiMessage ? `: ${this.apiMessage}` : ""}`;
    return this.message.split("\n")[0]!;
  }

  info(scrubLine: (s: string) => string): JudgeCallInfo {
    return {
      ...(this.status !== undefined ? { status: this.status } : {}),
      ...(this.origin !== undefined ? { origin: this.origin } : {}),
      message: scrubLine(this.summary()).slice(0, 300),
      retryable: this.retryable,
    };
  }
}

/** Wrap a transport throw; an interrupt is passed through unchanged (it must reach the run's own handler). */
export function asJudgeCallError(e: unknown): unknown {
  if (e instanceof JudgeCallError) return e;
  if (e instanceof InterruptedError) return e;
  return new JudgeCallError(e);
}
