#!/usr/bin/env python3
"""
Two-session concurrency proof for migration 018's booking guard.

WHY THIS EXISTS
---------------
018 changes the WINDOW the guard compares (day -> instant) but must not weaken
the race safety 017 established. A single-session test cannot see a race, so this
drives TWO real connections, sequenced so the interleaving is deterministic rather
than timing-dependent:

    A: begin, insert            (takes the guard's advisory lock, holds it)
    B: begin, insert            (must WAIT for the lock)
    A: commit
    B: unblocks and must be REFUSED

It applies the REAL migration file - not a copy of its logic - so the evidence is
about the artifact that ships.

WHAT IT PROVES
  1. CONTROL, no guard: BOTH sessions commit the same overlapping window. This is
     the bug; the harness MUST report it, or the test is vacuous.
  2. REAL 018: exactly ONE row lands, the loser gets `exclusion_violation`.
  3. The lock is per-car: a DIFFERENT car is NOT blocked, so the guard does not
     serialise the whole table.
  4. Precision: a same-day window at a different TIME is admitted, an overlapping
     one is refused - the point of 018 over 017.
  5. Cross-tenant: the same car and window in another company is admitted.

Run: python3 supabase/tests/018_harness/race.py [port] [user]
"""

import os
import sys
import threading
import time

import psycopg2

# The default is the local unix socket (the directory holding .s.PGSQL.<port>).
# Pass a port to use TCP instead: python3 race.py 5432 postgres
SOCKET_DIR = os.environ.get("PGHOST", "/var/run/postgresql")
# Resolve the migration from this file's location, so the harness runs from any
# working directory (a hard-coded /tmp path breaks as soon as it is copied).
MIGRATION = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..", "..", "migrations", "018_booking_time_precision.sql",
)
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5432
USER = sys.argv[2] if len(sys.argv) > 2 else "postgres"
DB = "speed_race018"
CAR_A = "aaaaaaaa-0000-0000-0000-0000000000aa"
CAR_B = "bbbbbbbb-0000-0000-0000-0000000000bb"
T1 = "11111111-1111-1111-1111-111111111111"
T2 = "22222222-2222-2222-2222-222222222222"

passes = 0
failures = 0


def check(label, ok, detail=""):
    global passes, failures
    if ok:
        passes += 1
        print(f" PASS | {label}" + (f" -- {detail}" if detail else ""))
    else:
        failures += 1
        print(f" FAIL | {label}" + (f" -- {detail}" if detail else ""))


def connect(dbname=DB):
    # A directory host makes libpq use the unix socket there.
    return psycopg2.connect(host=SOCKET_DIR, port=PORT, user=USER, dbname=dbname)


def admin():
    c = connect("postgres")
    c.autocommit = True
    return c


def recreate():
    c = admin()
    with c.cursor() as cur:
        cur.execute(f"drop database if exists {DB}")
        cur.execute(f"create database {DB}")
    c.close()


def apply_sql(sql):
    c = connect()
    c.autocommit = True
    with c.cursor() as cur:
        cur.execute(sql)
    c.close()


def apply_file(path):
    with open(path, encoding="utf-8") as fh:
        apply_sql(fh.read())


BASE_SCHEMA = """
create extension if not exists pgcrypto;
create table public.settings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid, key text, value text, unique (tenant_id, key)
);
create table public.rental_contracts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid, car_id uuid not null, customer_id uuid,
  contract_number text, start_date date, end_date date,
  status text default 'pending', total_amount numeric default 0
);
create or replace function public.booking_blocks_car(p_status text)
returns boolean language sql immutable as $$
  select lower(coalesce(p_status,'')) in
    ('pending','active','confirmed','reserved','approved','ongoing','rented');
$$;
insert into public.settings (tenant_id, key, value)
values ('11111111-1111-1111-1111-111111111111','company_timezone','Asia/Bahrain'),
       ('22222222-2222-2222-2222-222222222222','company_timezone','UTC');
"""


def reset_rows():
    c = connect()
    c.autocommit = True
    with c.cursor() as cur:
        cur.execute("delete from public.rental_contracts")
    c.close()


def insert(cur, num, car=CAR_A, tenant=T1, sd="2026-03-01", st="09:00", ed="2026-03-01", et="11:00"):
    """Insert a booking, optionally with wall-clock columns only."""
    if st is None:
        cur.execute(
            "insert into public.rental_contracts"
            " (tenant_id, car_id, contract_number, start_date, end_date, status)"
            " values (%s,%s,%s,%s,%s,'pending')",
            (tenant, car, num, sd, ed),
        )
    else:
        cur.execute(
            "insert into public.rental_contracts"
            " (tenant_id, car_id, contract_number, start_date, start_time,"
            "  end_date, end_time, status)"
            " values (%s,%s,%s,%s,%s,%s,%s,'pending')",
            (tenant, car, num, sd, st, ed, et),
        )


def count_rows(car=None):
    c = connect()
    with c.cursor() as cur:
        if car:
            cur.execute("select count(*) from public.rental_contracts where car_id=%s", (car,))
        else:
            cur.execute("select count(*) from public.rental_contracts")
        n = cur.fetchone()[0]
    c.close()
    return n


def race(apply_migration=True):
    """
    Run the deterministic two-session race and return (rows_landed, loser_sqlstate).
    """
    reset_rows()
    a = connect()
    b = connect()
    outcome = {"b_error": None, "b_done": False}

    def session_b():
        try:
            b.autocommit = False
            with b.cursor() as cur:
                insert(cur, "B-1")
            b.commit()
        except Exception as exc:  # noqa: BLE001 - the SQLSTATE is the assertion
            outcome["b_error"] = getattr(exc, "pgcode", None)
            b.rollback()
        finally:
            outcome["b_done"] = True

    a.autocommit = False
    with a.cursor() as cur:
        insert(cur, "A-1")

    # B must block on A's advisory lock; start it and give it a moment.
    t = threading.Thread(target=session_b)
    t.start()
    time.sleep(1.5)
    blocked = not outcome["b_done"]

    a.commit()
    t.join(timeout=10)

    a.close()
    b.close()
    return count_rows(CAR_A), outcome["b_error"], blocked


def main():
    recreate()
    apply_sql(BASE_SCHEMA)
    apply_file(MIGRATION)

    print("\n-- CONTROL: without the guard, BOTH sessions commit the same window --")
    # Drop the trigger and constraint to show the race the guard exists to close.
    apply_sql(
        "drop trigger if exists rental_contracts_no_double_booking on public.rental_contracts;"
        "alter table public.rental_contracts drop constraint if exists rental_contracts_no_car_overlap;"
    )
    rows, _, _ = race()
    check("the control shows the race (both rows land, so the test is not vacuous)", rows == 2, f"rows={rows}")

    print("\n-- REAL 018: exactly ONE row lands, the loser is refused --")
    apply_file(MIGRATION)
    rows, err, blocked = race()
    check("the second session BLOCKED on the advisory lock", blocked, "the lock is doing the work")
    check("exactly one booking landed", rows == 1, f"rows={rows}")
    check("the loser was refused with exclusion_violation (23P01)", err == "23P01", f"sqlstate={err}")

    print("\n-- the lock is per-car, not global --")
    reset_rows()
    a = connect()
    b = connect()
    a.autocommit = False
    b.autocommit = False
    err_b = None
    with a.cursor() as cur:
        insert(cur, "A-car1", car=CAR_A)
    try:
        with b.cursor() as cur:
            insert(cur, "B-car2", car=CAR_B)  # a DIFFERENT car must not block
        b.commit()
    except Exception as exc:  # noqa: BLE001
        err_b = getattr(exc, "pgcode", None)
        b.rollback()
    a.commit()
    a.close()
    b.close()
    check("a different car is not blocked by the first car's lock", err_b is None, f"sqlstate={err_b}")
    check("both cars' bookings landed", count_rows() == 2, f"rows={count_rows()}")

    print("\n-- precision: same day, different TIME is a different booking --")
    reset_rows()
    apply_sql("delete from public.rental_contracts")
    c = connect()
    c.autocommit = True
    ok1 = ok2 = None
    with c.cursor() as cur:
        insert(cur, "P-1", st="09:00", et="11:00")
        try:
            insert(cur, "P-2", st="11:00", et="13:00")  # adjacent -> allowed
            ok1 = "allowed"
        except Exception as exc:  # noqa: BLE001
            ok1 = getattr(exc, "pgcode", None)
        try:
            insert(cur, "P-3", st="10:00", et="12:00")  # overlaps -> refused
            ok2 = "allowed"
        except Exception as exc:  # noqa: BLE001
            ok2 = getattr(exc, "pgcode", None)
    c.close()
    check("an adjacent booking (11:00 return, 11:00 pickup) is allowed", ok1 == "allowed", f"got={ok1}")
    check("an overlapping booking (10:00-12:00 vs 09:00-11:00) is refused", ok2 == "23P01", f"got={ok2}")

    print("\n-- cross-tenant: the same car and window in another company is admitted --")
    reset_rows()
    c = connect()
    c.autocommit = True
    err = None
    with c.cursor() as cur:
        insert(cur, "X-t1", car=CAR_A, tenant=T1)
        try:
            insert(cur, "X-t2", car=CAR_A, tenant=T2)
        except Exception as exc:  # noqa: BLE001
            err = getattr(exc, "pgcode", None)
    c.close()
    check("another company may book the same car for the same window", err is None, f"sqlstate={err}")
    check("both companies' rows exist", count_rows() == 2, f"rows={count_rows()}")

    print("\n-- a legacy row (wall-clock columns only) is still guarded --")
    reset_rows()
    c = connect()
    c.autocommit = True
    err = None
    with c.cursor() as cur:
        insert(cur, "L-1", st=None, sd="2026-06-01", ed="2026-06-03")
        try:
            insert(cur, "L-2", st=None, sd="2026-06-02", ed="2026-06-04")
        except Exception as exc:  # noqa: BLE001
            err = getattr(exc, "pgcode", None)
    c.close()
    check("a legacy-column overlap is refused (the derive is load-bearing)", err == "23P01", f"sqlstate={err}")

    print("\n-- timezone correctness: the stored instant is in the company's zone --")
    reset_rows()
    c = connect()
    c.autocommit = True
    with c.cursor() as cur:
        insert(cur, "TZ-1", car=CAR_A, tenant=T1, st="09:00", et="10:00")
        insert(cur, "TZ-2", car=CAR_B, tenant=T2, st="09:00", et="10:00")
        cur.execute(
            "select contract_number, start_at at time zone 'UTC' from public.rental_contracts"
            " order by contract_number"
        )
        got = dict(cur.fetchall())
    c.close()
    # Bahrain 09:00 == 06:00Z; UTC 09:00 == 09:00Z. Same wall clock, two instants.
    check(
        "the Bahrain tenant's 09:00 is stored as 06:00Z",
        str(got.get("TZ-1", "")).startswith("2026-03-01 06:00"),
        f"got={got.get('TZ-1')}",
    )
    check(
        "the UTC tenant's 09:00 is stored as 09:00Z",
        str(got.get("TZ-2", "")).startswith("2026-03-01 09:00"),
        f"got={got.get('TZ-2')}",
    )

    print("\n-----------------------------------------")
    print(f"RESULT: {passes} passed, {failures} failed")
    if failures == 0:
        print("018 RACE HARNESS: PASS")
        return 0
    print("018 RACE HARNESS: FAIL")
    return 1


if __name__ == "__main__":
    sys.exit(main())
