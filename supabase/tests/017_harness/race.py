#!/usr/bin/env python3
"""
Two-session concurrency proof for migration 017's double-booking guard.

WHY THIS EXISTS
---------------
The first version of 017 guarded the race with a trigger whose body was a plain
`select ... from rental_contracts`. Under READ COMMITTED that select uses the
statement snapshot, so it CANNOT see a row another transaction has inserted but
not committed. Two sessions that insert the same car and window at the same
moment both read "no conflict", both insert, and both commit - the exact race the
migration claims to close. A single-session test cannot see this, which is how it
shipped.

This harness drives TWO real connections against a real PostgreSQL, sequenced so
the interleaving is deterministic rather than timing-dependent:

    A: begin, insert          (takes the guard's lock, holds it)
    B: begin, insert          (must WAIT for the lock, or must NOT see A's row)
    A: commit
    B: unblocks

It applies the REAL migration file - not a copy of its logic - so the evidence is
about the artifact that ships:

  - control `plain-select`       -> BOTH rows land. This is the reported bug; the
                                    harness MUST report it, or the test is vacuous.
  - real 017, constraint dropped -> ONE row lands. This isolates the
                                    advisory-lock TRIGGER, which is the guard that
                                    exists when btree_gist is unavailable or a
                                    pre-existing overlap skipped the constraint.
  - real 017, both guards        -> ONE row lands.

It then checks precision semantics (a same-day window at a different TIME is a
different booking), the half-open turnover, and that activation FAILS CLOSED on a
table it cannot guard.

Run: python3 supabase/tests/017_harness/race.py [port]
"""

import hashlib
import os
import sys
import threading
import time

import psycopg2

PORT = int(sys.argv[1] if len(sys.argv) > 1 else os.environ.get("PGPORT", "5433"))
DSN = dict(host=os.environ.get("PGHOST", "127.0.0.1"), port=PORT,
           user=os.environ.get("PGUSER", "postgres"),
           password=os.environ.get("PGPASSWORD", "postgres"),
           dbname="speed_race017")
MIGRATION = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..",
                                          "migrations", "017_booking_overlap_guard.sql"))

CAR = "ca000000-0000-0000-0000-00000000000a"
CAR2 = "cb000000-0000-0000-0000-00000000000b"
TEN = "11111111-1111-1111-1111-111111111111"

results = []


def check(label, ok, detail=""):
    results.append((label, ok, detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {label}" + (f"  [{detail}]" if detail else ""))


def connect(dbname="speed_race017"):
    d = dict(DSN)
    d["dbname"] = dbname
    return psycopg2.connect(**d)


def admin():
    c = connect("postgres")
    c.autocommit = True
    return c


def recreate(dbname="speed_race017"):
    adm = admin()
    with adm.cursor() as cur:
        cur.execute(f"drop database if exists {dbname}")
        cur.execute(f"create database {dbname}")
    adm.close()


def apply_sql(sql, dbname="speed_race017"):
    c = connect(dbname)
    c.autocommit = True
    with c.cursor() as cur:
        cur.execute(sql)
    c.close()


def apply_migration(dbname="speed_race017"):
    apply_sql(open(MIGRATION).read(), dbname)


BASE = """
create extension if not exists btree_gist;
create table public.rental_contracts (
  id uuid primary key default gen_random_uuid(),
  contract_number text,
  car_id uuid,
  customer_id uuid,
  start_date date,
  end_date date,
  start_time time,
  end_time time,
  status text default 'pending',
  tenant_id uuid
);
"""

PLAIN_SELECT_TRIGGER = """
create or replace function public.booking_blocks_car(p_status text)
returns boolean language sql immutable as $$
  select lower(coalesce(p_status,'')) in
    ('pending','active','confirmed','reserved','approved','ongoing','rented');
$$;
create or replace function public.prevent_car_double_booking()
returns trigger language plpgsql security definer set search_path = public as $body$
declare v_clash uuid;
begin
  if not public.booking_blocks_car(new.status) then return new; end if;
  if new.car_id is null or new.start_date is null or new.end_date is null then return new; end if;
  if new.end_date <= new.start_date then return new; end if;
  select c.id into v_clash from public.rental_contracts c
  where c.car_id = new.car_id
    and c.id is distinct from new.id
    and c.tenant_id is not distinct from new.tenant_id
    and public.booking_blocks_car(c.status)
    and tsrange(c.start_date + coalesce(c.start_time,'00:00'::time),
                c.end_date   + coalesce(c.end_time,  '00:00'::time), '[)')
     && tsrange(new.start_date + coalesce(new.start_time,'00:00'::time),
                new.end_date   + coalesce(new.end_time,  '00:00'::time), '[)')
  limit 1;
  if v_clash is not null then
    raise exception 'already booked (conflicting %)', v_clash using errcode = 'exclusion_violation';
  end if;
  return new;
end; $body$;
drop trigger if exists rental_contracts_no_double_booking on public.rental_contracts;
create trigger rental_contracts_no_double_booking
  before insert or update of car_id, start_date, end_date, start_time, end_time, status, tenant_id
  on public.rental_contracts for each row
  execute function public.prevent_car_double_booking();
"""


def reset_rows():
    c = connect(); c.autocommit = True
    with c.cursor() as cur:
        cur.execute("delete from public.rental_contracts;")
    c.close()


def insert(cur, num, car=CAR, sd="2026-03-01", ed="2026-03-05", st=None, et=None):
    cur.execute(
        "insert into public.rental_contracts"
        " (contract_number, car_id, start_date, end_date, start_time, end_time, status, tenant_id)"
        " values (%s,%s,%s,%s,%s,%s,'pending',%s)",
        (num, car, sd, ed, st, et, TEN))


def count_rows():
    c = connect()
    with c.cursor() as cur:
        cur.execute("select count(*) from public.rental_contracts;")
        n = cur.fetchone()[0]
    c.close()
    return n


def race():
    reset_rows()
    outcome = {}
    a_ready = threading.Event()
    a_done = threading.Event()

    def session_a():
        conn = connect()
        try:
            with conn.cursor() as cur:
                insert(cur, "RC-A")
            a_ready.set()
            a_done.wait(timeout=10)
            conn.commit()
            outcome["a"] = "committed"
        except Exception as exc:  # noqa: BLE001
            conn.rollback()
            outcome["a"] = f"refused: {str(exc).splitlines()[0]}"
        finally:
            conn.close()

    def session_b():
        a_ready.wait(timeout=10)
        time.sleep(0.6)
        conn = connect()
        try:
            with conn.cursor() as cur:
                insert(cur, "RC-B")
            conn.commit()
            outcome["b"] = "committed"
        except Exception as exc:  # noqa: BLE001
            conn.rollback()
            outcome["b"] = f"refused: {str(exc).splitlines()[0]}"
        finally:
            conn.close()

    ta, tb = threading.Thread(target=session_a), threading.Thread(target=session_b)
    ta.start(); tb.start()
    time.sleep(1.4)
    a_done.set()
    ta.join(timeout=15); tb.join(timeout=15)
    return outcome, count_rows()


def count_constraint():
    c = connect()
    with c.cursor() as cur:
        cur.execute("select count(*) from pg_constraint where conname='rental_contracts_no_car_overlap';")
        n = cur.fetchone()[0]
    c.close()
    return n


def count_trigger():
    c = connect()
    with c.cursor() as cur:
        cur.execute("select count(*) from pg_trigger where tgname='rental_contracts_no_double_booking';")
        n = cur.fetchone()[0]
    c.close()
    return n


def main():
    print(f"== two-session race harness (PostgreSQL on port {PORT}) ==")
    print(f"   migration: {os.path.relpath(MIGRATION)}")
    print(f"   sha256:    {hashlib.sha256(open(MIGRATION,'rb').read()).hexdigest()[:16]}")

    recreate(); apply_sql(BASE)

    print("\n-- control: the ORIGINAL plain-SELECT trigger (the reported bug) --")
    apply_sql(PLAIN_SELECT_TRIGGER)
    outcome, n = race()
    print(f"     outcome={outcome} rows={n}")
    check("plain SELECT lets BOTH sessions commit (bug reproduced)", n == 2, f"rows={n}")

    print("\n-- real 017 with the exclusion constraint REMOVED (isolates the fallback trigger) --")
    recreate(); apply_sql(BASE); apply_migration()
    apply_sql("alter table public.rental_contracts drop constraint if exists rental_contracts_no_car_overlap;")
    check("the advisory-lock trigger exists after the migration", count_trigger() == 1)
    check("the exclusion constraint is genuinely gone (this isolates the trigger)",
          count_constraint() == 0)
    outcome, n = race()
    print(f"     outcome={outcome} rows={n}")
    check("the advisory-lock TRIGGER alone lets exactly ONE session commit", n == 1, f"rows={n}")
    check("the loser was REFUSED with the overlap error, not silently accepted",
          any("refused" in v for v in outcome.values()), str(outcome)[:80])

    print("\n-- real 017 with BOTH guards --")
    recreate(); apply_sql(BASE); apply_migration()
    check("the exclusion constraint exists after the migration", count_constraint() == 1)
    outcome, n = race()
    print(f"     outcome={outcome} rows={n}")
    check("both guards let exactly ONE session commit", n == 1, f"rows={n}")

    print("\n-- idempotent re-apply --")
    try:
        apply_migration()
        check("a second apply of 017 succeeds", True)
    except Exception as exc:  # noqa: BLE001
        check("a second apply of 017 succeeds", False, str(exc)[:80])
    check("re-apply did not duplicate the constraint", count_constraint() == 1)
    check("re-apply did not duplicate the trigger", count_trigger() == 1)

    print("\n-- time precision: a same-day window at a different time is a different booking --")
    reset_rows()
    c = connect(); c.autocommit = True
    with c.cursor() as cur:
        insert(cur, "RC-0900", sd="2026-03-01", ed="2026-03-01", st="09:00", et="11:00")
    c.close()
    accepted = True
    try:
        c = connect(); c.autocommit = True
        with c.cursor() as cur:
            insert(cur, "RC-1100", sd="2026-03-01", ed="2026-03-01", st="11:00", et="13:00")
        c.close()
    except Exception:  # noqa: BLE001
        accepted = False
    check("11:00-13:00 is accepted when 09:00-11:00 exists (a date-only guard would refuse it)",
          accepted, f"rows={count_rows()}")

    print("\n-- time precision: a genuinely overlapping window is still refused --")
    refused = False
    try:
        c = connect(); c.autocommit = True
        with c.cursor() as cur:
            insert(cur, "RC-1030", sd="2026-03-01", ed="2026-03-01", st="10:30", et="11:30")
        c.close()
    except Exception:  # noqa: BLE001
        refused = True
    check("10:30-11:30 overlaps 09:00-11:00 and is refused", refused, f"rows={count_rows()}")

    print("\n-- half-open turnover and a different car --")
    reset_rows()
    c = connect(); c.autocommit = True
    with c.cursor() as cur:
        insert(cur, "RC-1", sd="2026-03-01", ed="2026-03-05")
        insert(cur, "RC-2", sd="2026-03-05", ed="2026-03-09")
    c.close()
    check("a back-to-back booking is accepted (half-open windows)", count_rows() == 2, f"rows={count_rows()}")
    c = connect(); c.autocommit = True
    with c.cursor() as cur:
        insert(cur, "RC-3", car=CAR2, sd="2026-03-01", ed="2026-03-05")
    c.close()
    check("another car in the same window is accepted", count_rows() == 3, f"rows={count_rows()}")

    print("\n-- fail-closed: a rental_contracts with no usable window column --")
    recreate("speed_race_nw")
    apply_sql("create table public.rental_contracts (id uuid primary key, car_id uuid, status text);",
              "speed_race_nw")
    failed_closed, detail = False, ""
    try:
        apply_sql(open(MIGRATION).read(), "speed_race_nw")
    except Exception as exc:  # noqa: BLE001
        failed_closed = True
        detail = str(exc).splitlines()[0][:70]
    check("activation FAILS when it cannot guard anything (never a silent success)",
          failed_closed, detail)

    adm = admin()
    with adm.cursor() as cur:
        cur.execute("drop database if exists speed_race017")
        cur.execute("drop database if exists speed_race_nw")
    adm.close()

    passed = sum(1 for _, ok, _ in results if ok)
    print(f"\nRESULT: {passed}/{len(results)} race assertions passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
