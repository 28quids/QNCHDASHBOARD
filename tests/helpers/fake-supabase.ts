/**
 * An in-memory stand-in for the PostgREST query builder.
 *
 * The repository and the sync store are the only modules that talk to Supabase, and both
 * need testing without a database or provider credentials. This implements just enough of
 * the builder for them: filters, single-row and array payloads, upsert-on-conflict, and the
 * unique-violation error that `claimRun` depends on.
 *
 * It is a fake, not a Postgres emulator. It enforces only the unique constraints declared
 * in `UNIQUE_COLUMNS`, and applies no foreign keys, checks or row-level security.
 *
 * Embedded relations are declared in `EMBEDS` rather than inferred. PostgREST derives them from
 * real foreign keys, which a fake has no access to, and guessing from a name would silently
 * return an empty relation for anything that did not match the guess — the failure mode being
 * a test that passes because the child rows it was asserting on were never attached.
 */

export type Row = Record<string, unknown>;

/** Unique constraints the fake enforces, as (table → columns) forming one key. */
const UNIQUE_COLUMNS: Record<string, string[]> = {
  sync_runs: ["job_key"],
  sync_cursors: ["connection_id", "resource_name"],
  shopify_customers: ["organisation_id", "external_id"],
  shopify_orders: ["organisation_id", "external_id"],
  shopify_order_lines: ["organisation_id", "external_id"],
  shopify_refunds: ["organisation_id", "external_id"],
  shopify_refund_lines: ["organisation_id", "external_id"],
  product_variants: ["organisation_id", "external_id"],
};

/**
 * Relations a `select` may embed, as (parent table → embed name → how to resolve it).
 *
 * `many` returns an array of children keyed on a foreign key pointing back at the parent;
 * `one` returns a single parent row the child points at, which is the `!inner` form.
 */
const EMBEDS: Record<string, Record<string, { table: string; foreignKey: string; cardinality: "one" | "many" }>> = {
  xero_bank_transactions: {
    xero_bank_transaction_lines: {
      table: "xero_bank_transaction_lines",
      foreignKey: "bank_transaction_id",
      cardinality: "many",
    },
  },
  integration_connections: {
    integration_tokens: { table: "integration_tokens", foreignKey: "connection_id", cardinality: "many" },
  },
  ad_daily_metrics: {
    ad_accounts: { table: "ad_accounts", foreignKey: "ad_account_id", cardinality: "one" },
  },
};

export const TABLE_DEFAULTS: Record<string, Row> = {
  sync_runs: {
    status: "queued",
    attempt_count: 0,
    records_received: 0,
    records_written: 0,
    error_code: null,
    error_message: null,
    started_at: null,
    completed_at: null,
  },
};

type Operation = "select" | "insert" | "update" | "upsert" | "delete";

/**
 * The embedded relation names in a PostgREST projection.
 *
 * Only top-level embeds are read: `a, b, child(x, y)` yields `child`. Nested embeds are not
 * used by this codebase, and pretending to support them would return the wrong shape rather
 * than failing.
 */
function parseEmbeds(projection: string, table: string): string[] {
  const names: string[] = [];
  for (const match of projection.matchAll(/([A-Za-z_][A-Za-z0-9_]*)(?:!inner)?\s*\(/g)) {
    const name = match[1];
    if (EMBEDS[table]?.[name]) names.push(name);
  }
  return names;
}
type Result = { data: unknown; error: unknown; count?: number };

/** Comparison filters, evaluated with the same string/number ordering PostgREST would use. */
type Comparison = [column: string, value: unknown, test: (a: never, b: never) => boolean];

const COMPARISONS = {
  gte: (a: string, b: string) => a >= b,
  gt: (a: string, b: string) => a > b,
  lte: (a: string, b: string) => a <= b,
  lt: (a: string, b: string) => a < b,
} as const;

class FakeQuery implements PromiseLike<Result> {
  private readonly equals: Array<[string, unknown]> = [];
  private readonly includes: Array<[string, readonly unknown[]]> = [];
  private readonly comparisons: Comparison[] = [];
  private readonly negations: Array<[string, unknown]> = [];
  private readonly orderings: Array<[string, boolean]> = [];
  private embeds: string[] = [];
  private counting = false;
  private headOnly = false;
  private limitTo: number | null = null;
  private cardinality: "many" | "one" | "maybe" = "many";

  constructor(
    private readonly tables: Record<string, Row[]>,
    private readonly table: string,
    private readonly operation: Operation,
    private readonly payload: Row | Row[] | null,
    private readonly conflictTarget: string[] = [],
  ) {}

  eq(column: string, value: unknown): this {
    this.equals.push([column, value]);
    return this;
  }

  in(column: string, values: readonly unknown[]): this {
    this.includes.push([column, values]);
    return this;
  }

  /** PostgREST's `is` only takes null/true/false; only the null case is used here. */
  is(column: string, value: null | boolean): this {
    this.equals.push([column, value]);
    return this;
  }

  gte(column: string, value: unknown): this {
    this.comparisons.push([column, value, COMPARISONS.gte as never]);
    return this;
  }

  gt(column: string, value: unknown): this {
    this.comparisons.push([column, value, COMPARISONS.gt as never]);
    return this;
  }

  lte(column: string, value: unknown): this {
    this.comparisons.push([column, value, COMPARISONS.lte as never]);
    return this;
  }

  lt(column: string, value: unknown): this {
    this.comparisons.push([column, value, COMPARISONS.lt as never]);
    return this;
  }

  /**
   * Whole rows are returned regardless of the projection, but two things about it matter.
   *
   * The projection is parsed for embedded relations, which have to be attached for the caller to
   * find them. And `{ count, head }` is honoured, because a caller using it is asking "does this
   * table hold anything at all" — a question whose answer changes behaviour, so a fake that
   * quietly returned an undefined count would let a wrong answer pass a test.
   */
  select(projection?: string, options?: { count?: "exact" | "planned" | "estimated"; head?: boolean }): this {
    if (projection) this.embeds = parseEmbeds(projection, this.table);
    if (options?.count) this.counting = true;
    if (options?.head) this.headOnly = true;
    return this;
  }

  /**
   * PostgREST's negated filter. Only `not(column, "is", null)` is used, which is the form that
   * matters: a null foreign key means the row could not be attributed to anything.
   */
  not(column: string, operator: string, value: unknown): this {
    if (operator !== "is") throw new Error(`fake-supabase does not implement not(${operator})`);
    this.negations.push([column, value]);
    return this;
  }

  order(column: string, options: { ascending?: boolean } = {}): this {
    this.orderings.push([column, options.ascending !== false]);
    return this;
  }

  limit(count: number): this {
    this.limitTo = count;
    return this;
  }

  single(): this {
    this.cardinality = "one";
    return this;
  }

  maybeSingle(): this {
    this.cardinality = "maybe";
    return this;
  }

  private rows(): Row[] {
    return (this.tables[this.table] ??= []);
  }

  private matches(row: Row): boolean {
    return (
      this.equals.every(([column, value]) => (row[column] ?? null) === value) &&
      this.includes.every(([column, values]) => values.includes(row[column])) &&
      this.comparisons.every(([column, value, test]) => test(row[column] as never, value as never)) &&
      this.negations.every(([column, value]) => (row[column] ?? null) !== value)
    );
  }

  /**
   * Attaches the declared embeds to a row.
   *
   * A copy is returned rather than the stored row mutated, so reading a relation never leaves
   * the child rows attached to the table for the next query to trip over.
   */
  private expand(row: Row): Row {
    if (this.embeds.length === 0) return row;

    const expanded: Row = { ...row };
    for (const name of this.embeds) {
      const relation = EMBEDS[this.table]?.[name];
      if (!relation) throw new Error(`fake-supabase has no embed ${this.table}.${name}`);

      const children = this.tables[relation.table] ?? [];
      expanded[name] =
        relation.cardinality === "many"
          ? children.filter((child) => child[relation.foreignKey] === row.id)
          : (children.find((candidate) => candidate.id === row[relation.foreignKey]) ?? null);
    }
    return expanded;
  }

  private asArray(): Row[] {
    if (this.payload === null) return [];
    return Array.isArray(this.payload) ? this.payload : [this.payload];
  }

  private keyOf(row: Row, columns: string[]): string {
    return columns.map((column) => String(row[column])).join(" ");
  }

  private execute(): Result {
    const rows = this.rows();
    const uniqueOn = UNIQUE_COLUMNS[this.table] ?? [];

    if (this.operation === "insert") {
      const written: Row[] = [];
      for (const item of this.asArray()) {
        const candidate: Row = { id: `${this.table}-${rows.length + written.length + 1}`, ...TABLE_DEFAULTS[this.table], ...item };
        if (uniqueOn.length > 0) {
          const key = this.keyOf(candidate, uniqueOn);
          if (rows.some((row) => this.keyOf(row, uniqueOn) === key)) {
            return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
          }
        }
        rows.push(candidate);
        written.push(candidate);
      }
      return this.shape(written);
    }

    if (this.operation === "upsert") {
      const target = this.conflictTarget.length > 0 ? this.conflictTarget : uniqueOn;
      const written: Row[] = [];
      for (const item of this.asArray()) {
        const existing =
          target.length > 0
            ? rows.find((row) => this.keyOf(row, target) === this.keyOf(item, target))
            : undefined;
        if (existing) {
          // Only the supplied columns are overwritten, matching ON CONFLICT DO UPDATE.
          Object.assign(existing, item);
          written.push(existing);
        } else {
          const candidate: Row = { id: `${this.table}-${rows.length + 1}`, ...TABLE_DEFAULTS[this.table], ...item };
          rows.push(candidate);
          written.push(candidate);
        }
      }
      return this.shape(written);
    }

    const matched = rows.filter((row) => this.matches(row));

    if (this.operation === "delete") {
      for (const row of matched) {
        const index = rows.indexOf(row);
        if (index >= 0) rows.splice(index, 1);
      }
      return this.shape(matched);
    }

    if (this.operation === "update") {
      for (const row of matched) Object.assign(row, this.payload);
      return this.shape(matched);
    }

    const ordered = [...matched];
    for (const [column, ascending] of [...this.orderings].reverse()) {
      ordered.sort((a, b) => {
        const left = a[column] as never;
        const right = b[column] as never;
        if (left === right) return 0;
        return (left < right ? -1 : 1) * (ascending ? 1 : -1);
      });
    }

    const limited = this.limitTo === null ? ordered : ordered.slice(0, this.limitTo);
    return this.shape(limited.map((row) => this.expand(row)));
  }

  private shape(matched: Row[]): Result {
    if (this.counting) {
      // `head` asks for the count without the rows, which is what makes an existence check cheap.
      return { data: this.headOnly ? null : matched, error: null, count: matched.length };
    }
    if (this.cardinality === "many") return { data: matched, error: null };
    if (matched.length === 1) return { data: matched[0], error: null };
    if (this.cardinality === "maybe" && matched.length === 0) return { data: null, error: null };
    return { data: null, error: { code: "PGRST116", message: `expected one row, got ${matched.length}` } };
  }

  then<TResult1 = Result, TResult2 = never>(
    onfulfilled?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    try {
      return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
    } catch (error) {
      return Promise.reject(error).then(onfulfilled, onrejected);
    }
  }
}

export function createFakeSupabase(seed: Record<string, Row[]> = {}) {
  // Cloned, not aliased. Writes would otherwise mutate the caller's seed, so a fixture
  // shared between tests would accumulate rows from whichever ran first.
  const tables: Record<string, Row[]> = structuredClone(seed);
  const client = {
    from(table: string) {
      return {
        select: (projection?: string, options?: { count?: "exact" | "planned" | "estimated"; head?: boolean }) =>
          new FakeQuery(tables, table, "select", null).select(projection, options),
        insert: (payload: Row | Row[]) => new FakeQuery(tables, table, "insert", payload),
        update: (payload: Row) => new FakeQuery(tables, table, "update", payload),
        upsert: (payload: Row | Row[], options?: { onConflict?: string }) =>
          new FakeQuery(tables, table, "upsert", payload, options?.onConflict?.split(",") ?? []),
        delete: () => new FakeQuery(tables, table, "delete", null),
      };
    },

    /** Only the functions the application actually calls. An unknown name is an error, not a no-op. */
    async rpc(name: string, args: Record<string, unknown>): Promise<Result> {
      if (name !== "replace_daily_financials") {
        return { data: null, error: { code: "42883", message: `function ${name} does not exist` } };
      }
      return replaceDailyFinancials(tables, args);
    },
  };
  return { client, tables };
}

/**
 * Mirrors supabase/migrations/0006. The version swap is the part worth testing: republishing a
 * date must stand the previous version down rather than leave two rows claiming to be current.
 */
function replaceDailyFinancials(tables: Record<string, Row[]>, args: Record<string, unknown>): Result {
  const organisationId = args.p_organisation_id as string;
  const version = args.p_calculation_version as string;
  const payload = args.p_rows as Row[];

  const rows = (tables.daily_financials ??= []);
  const dates = new Set(payload.map((row) => row.business_date as string));

  for (const row of rows) {
    if (row.organisation_id === organisationId && row.is_current && dates.has(row.business_date as string)) {
      row.is_current = false;
    }
  }

  for (const item of payload) {
    const existing = rows.find(
      (row) =>
        row.organisation_id === organisationId &&
        row.business_date === item.business_date &&
        row.calculation_version === version,
    );
    if (existing) Object.assign(existing, item, { is_current: true });
    else rows.push({ organisation_id: organisationId, calculation_version: version, is_current: true, ...item });
  }

  return { data: payload.length, error: null };
}
