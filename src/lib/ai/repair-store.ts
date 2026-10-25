/**
 * Persistent AI repair execution store (Execution 23, Phase R3).
 *
 * Two interchangeable implementations of the same port:
 *
 *   • `createMemoryRepairStore()`   — in-memory, for tests and as a fallback.
 *   • `createSupabaseRepairStore()` — the durable store backed by the
 *     `ai_repair_executions` table (see `supabase/migrations/006_ai_repair.sql`).
 *
 * The store is the single source of truth for idempotency. Execution *claims* a
 * key atomically before any side effect; the unique constraint on
 * `(tenant_id, idempotency_key)` is what makes that claim safe across concurrent
 * requests, process restarts and a lost response. A key that was claimed but not
 * finalised is `unresolved` and is never re-run blindly.
 *
 * No secrets are stored: only ids, fingerprints, statuses, timestamps and the
 * shape of the change (keys, not financial values).
 */

export type RepairRecordStatus = "claimed" | "succeeded" | "failed" | "conflict" | "unresolved";

export interface RepairRecord {
  tenantId: string | null;
  userId: string | null;
  userEmail: string | null;
  proposalId: string;
  action: string;
  planFingerprint: string;
  contentFingerprint: string;
  idempotencyKey: string;
  status: RepairRecordStatus;
  verificationOk: boolean | null;
  reference: string | null;
  detail: string | null;
  changedKeys: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ClaimInput {
  tenantId: string | null;
  userId: string | null;
  userEmail: string | null;
  proposalId: string;
  action: string;
  planFingerprint: string;
  contentFingerprint: string;
  idempotencyKey: string;
}

export type ClaimResult =
  | { outcome: "claimed"; record: RepairRecord }
  | { outcome: "duplicate"; record: RepairRecord }
  | { outcome: "key_reused"; record: RepairRecord };

export interface FinalizeInput {
  status: RepairRecordStatus;
  verificationOk: boolean | null;
  reference: string | null;
  detail: string | null;
  changedKeys: string[];
}

export interface RepairStore {
  /**
   * Whether the backing store survives a process restart. A memory store is
   * per-process, so two requests served by different workers (or the same worker
   * after a restart) cannot see each other's claims. Financial writes require a
   * durable store: without one a retry after a lost response would post a second
   * invoice, because nothing outside this process remembers the first.
   */
  readonly durable: boolean;
  /** Atomically claims the key, or reports how it is already used. */
  claim(input: ClaimInput): Promise<ClaimResult>;
  /** Marks a claimed key as resolved (or unresolved) exactly once. */
  finalize(tenantId: string | null, idempotencyKey: string, patch: FinalizeInput): Promise<boolean>;
  get(tenantId: string | null, idempotencyKey: string): Promise<RepairRecord | null>;
  history(tenantId: string | null, limit?: number): Promise<RepairRecord[]>;
}

const nowIso = () => new Date().toISOString();

function samePlan(a: RepairRecord, input: ClaimInput): boolean {
  return a.action === input.action && a.planFingerprint === input.planFingerprint && a.contentFingerprint === input.contentFingerprint;
}

/* -------------------------------------------------------------------------- */
/* In-memory implementation                                                    */
/* -------------------------------------------------------------------------- */

export function createMemoryRepairStore(): RepairStore {
  const byKey = new Map<string, RepairRecord>();
  const k = (tenantId: string | null, key: string) => `${tenantId ?? "∅"}::${key}`;

  return {
    durable: false,
    async claim(input) {
      const id = k(input.tenantId, input.idempotencyKey);
      const existing = byKey.get(id);
      if (existing) {
        if (!samePlan(existing, input)) return { outcome: "key_reused", record: existing };
        return { outcome: "duplicate", record: existing };
      }
      const record: RepairRecord = {
        tenantId: input.tenantId,
        userId: input.userId,
        userEmail: input.userEmail,
        proposalId: input.proposalId,
        action: input.action,
        planFingerprint: input.planFingerprint,
        contentFingerprint: input.contentFingerprint,
        idempotencyKey: input.idempotencyKey,
        status: "claimed",
        verificationOk: null,
        reference: null,
        detail: null,
        changedKeys: [],
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      byKey.set(id, record);
      return { outcome: "claimed", record };
    },
    async finalize(tenantId, idempotencyKey, patch) {
      const id = k(tenantId, idempotencyKey);
      const existing = byKey.get(id);
      if (!existing) return false;
      byKey.set(id, {
        ...existing,
        status: patch.status,
        verificationOk: patch.verificationOk,
        reference: patch.reference,
        detail: patch.detail,
        changedKeys: patch.changedKeys.slice(0, 50),
        updatedAt: nowIso(),
      });
      return true;
    },
    async get(tenantId, idempotencyKey) {
      return byKey.get(k(tenantId, idempotencyKey)) ?? null;
    },
    async history(tenantId, limit = 50) {
      return Array.from(byKey.values())
        .filter((r) => (r.tenantId ?? null) === (tenantId ?? null))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, limit);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Supabase implementation                                                     */
/* -------------------------------------------------------------------------- */

interface SupabaseQuery extends PromiseLike<{ data: unknown; error: { message?: string; code?: string } | null }> {
  eq(column: string, value: string | null): SupabaseQuery;
  is(column: string, value: null): SupabaseQuery;
  order(column: string, opts?: { ascending?: boolean }): SupabaseQuery;
  limit(n: number): SupabaseQuery;
  maybeSingle(): Promise<{ data: unknown; error: { message?: string; code?: string } | null }>;
  select(columns?: string): SupabaseQuery;
}

export interface SupabaseClientLike {
  from(table: string): {
    insert(row: Record<string, unknown>): Promise<{ error: { message?: string; code?: string } | null }>;
    update(row: Record<string, unknown>): SupabaseQuery;
    select(columns?: string): SupabaseQuery;
  };
}

const UNIQUE_VIOLATION = "23505";

function toRecord(row: Record<string, unknown>): RepairRecord {
  return {
    tenantId: (row.tenant_id as string) ?? null,
    userId: (row.user_id as string) ?? null,
    userEmail: (row.user_email as string) ?? null,
    proposalId: String(row.proposal_id ?? ""),
    action: String(row.action ?? ""),
    planFingerprint: String(row.plan_fingerprint ?? ""),
    contentFingerprint: String(row.content_fingerprint ?? ""),
    idempotencyKey: String(row.idempotency_key ?? ""),
    status: (row.status as RepairRecordStatus) ?? "claimed",
    verificationOk: row.verification_ok === null || row.verification_ok === undefined ? null : Boolean(row.verification_ok),
    reference: (row.reference as string) ?? null,
    detail: (row.detail as string) ?? null,
    changedKeys: Array.isArray(row.changed_keys) ? (row.changed_keys as string[]) : [],
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

function scoped(query: SupabaseQuery, tenantId: string | null): SupabaseQuery {
  return tenantId ? query.eq("tenant_id", tenantId) : query.is("tenant_id", null);
}

export function createSupabaseRepairStore(client: SupabaseClientLike): RepairStore {
  const table = "ai_repair_executions";

  async function read(tenantId: string | null, key: string): Promise<RepairRecord | null> {
    const q = client.from(table).select("*").eq("idempotency_key", key);
    const { data, error } = await scoped(q, tenantId).maybeSingle();
    if (error || !data) return null;
    return toRecord(data as Record<string, unknown>);
  }

  return {
    durable: true,
    async claim(input) {
      const insert = await client.from(table).insert({
        tenant_id: input.tenantId,
        user_id: input.userId,
        user_email: input.userEmail,
        proposal_id: input.proposalId,
        action: input.action,
        plan_fingerprint: input.planFingerprint,
        content_fingerprint: input.contentFingerprint,
        idempotency_key: input.idempotencyKey,
        status: "claimed",
        changed_keys: [],
      });
      if (!insert.error) {
        return {
          outcome: "claimed",
          record: {
            ...input,
            status: "claimed",
            verificationOk: null,
            reference: null,
            detail: null,
            changedKeys: [],
            createdAt: nowIso(),
            updatedAt: nowIso(),
          },
        };
      }
      // A concurrent claim or a replayed key: the unique constraint won. Read it.
      if (insert.error.code === UNIQUE_VIOLATION || /duplicate key/i.test(insert.error.message ?? "")) {
        const existing = await read(input.tenantId, input.idempotencyKey);
        if (!existing) throw new Error("claim raced but the row could not be read");
        return { outcome: samePlan(existing, input) ? "duplicate" : "key_reused", record: existing };
      }
      throw new Error(insert.error.message ?? "claim failed");
    },
    async finalize(tenantId, idempotencyKey, patch) {
      const q = client
        .from(table)
        .update({
          status: patch.status,
          verification_ok: patch.verificationOk,
          reference: patch.reference,
          detail: patch.detail,
          changed_keys: patch.changedKeys.slice(0, 50),
          updated_at: nowIso(),
        })
        .eq("idempotency_key", idempotencyKey);
      const { error } = await scoped(q, tenantId);
      return !error;
    },
    get: read,
    async history(tenantId, limit = 50) {
      const q = client.from(table).select("*").order("created_at", { ascending: false });
      const { data, error } = await scoped(q, tenantId).limit(limit);
      if (error || !Array.isArray(data)) return [];
      return (data as Record<string, unknown>[]).map(toRecord);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Resilient wrapper                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Wraps the durable store so that a broken/unavailable table degrades to the
 * in-memory store instead of failing the whole request. This is what lets the
 * app run before migration 006 is applied — the same pattern as `hasColumn`
 * elsewhere. The limitation is explicit: a degraded store is per-process and
 * does not survive a restart, and this is reported (never hidden).
 *
 * `durable` reports whether the PRIMARY is still answering, and it flips to
 * `false` the moment the wrapper degrades. Financial writes consult it and
 * refuse rather than post against a store that cannot stop a double-post
 * (see `executeRepair`).
 */
export function createResilientRepairStore(primary: RepairStore, fallback: RepairStore = createMemoryRepairStore()): RepairStore {
  let degraded = false;
  let warned = false;
  const degrade = (error: unknown) => {
    degraded = true;
    if (!warned) {
      warned = true;
      console.error("[repair] durable store unavailable, using in-memory fallback:", (error as Error)?.message ?? error);
    }
  };

  return {
    get durable() {
      return primary.durable && !degraded;
    },
    async claim(input) {
      if (!degraded) {
        try {
          return await primary.claim(input);
        } catch (error) {
          degrade(error);
        }
      }
      return fallback.claim(input);
    },
    async finalize(tenantId, key, patch) {
      if (!degraded) {
        try {
          return await primary.finalize(tenantId, key, patch);
        } catch (error) {
          degrade(error);
        }
      }
      return fallback.finalize(tenantId, key, patch);
    },
    async get(tenantId, key) {
      if (!degraded) {
        try {
          return await primary.get(tenantId, key);
        } catch (error) {
          degrade(error);
        }
      }
      return fallback.get(tenantId, key);
    },
    async history(tenantId, limit) {
      if (!degraded) {
        try {
          return await primary.history(tenantId, limit);
        } catch (error) {
          degrade(error);
        }
      }
      return fallback.history(tenantId, limit);
    },
  };
}
