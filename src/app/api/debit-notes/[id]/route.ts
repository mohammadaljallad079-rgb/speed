import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { nextDocumentNumber } from "@/lib/numbering";
import {
  buildDebitNoteReversalJournal,
  findPostedDebitNoteJournal,
  type DebitNoteJournal,
} from "@/lib/accounting/debit-note-posting";
import { writeJournal } from "@/lib/accounting/manual-posting";
import { logAudit, requireContext, toErrorResponse } from "@/lib/auth";

/**
 * Cancel a supplier debit note — server-authoritative, with a ledger reversal.
 *
 * The screen used to set `status = 'cancelled'` from the browser and leave the
 * note's journal in place: the note disappeared from the payable while the
 * ledger still credited the payable account, so the supplier balance and the
 * books disagreed. A posted note is not silently cancelled; it is REVERSED
 * (mirroring its own journal), which is auditable and leaves history intact.
 *
 * Idempotent by note number: a retry returns `already_cancelled` without writing
 * a second reversal journal.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let createdReversalId: string | null = null;
  try {
    const context = await requireContext(request, { module: "purchases", action: "edit" });
    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: "id is required", code: "bad_request" }, { status: 400 });
    }

    let noteQuery = supabaseAdmin
      .from("debit_notes")
      .select("id,note_number,status,amount,tenant_id")
      .eq("id", id);
    noteQuery = context.tenantId
      ? noteQuery.eq("tenant_id", context.tenantId)
      : noteQuery.is("tenant_id", null);
    const { data: note, error } = await noteQuery.maybeSingle();
    if (error) throw error;
    if (!note) return NextResponse.json({ error: "Debit note not found", code: "not_found" }, { status: 404 });

    const row = note as Record<string, unknown>;
    if (row.status === "cancelled") {
      return NextResponse.json({ ok: true, already_cancelled: true });
    }
    const noteNumber = String(row.note_number ?? "");
    if (!noteNumber) {
      return NextResponse.json({ error: "The note has no number to reverse", code: "bad_request" }, { status: 400 });
    }

    const tenantId = context.tenantId ?? null;
    const existing = await findPostedDebitNoteJournal(supabaseAdmin as never, noteNumber, tenantId);
    const reversalNumber = await nextDocumentNumber(supabaseAdmin as never, "journal_entry", "JV");
    let reversalId: string | null = null;

    if (existing) {
      // Read the original journal's lines and mirror them. The reversal must be
      // built from what was actually posted, never from the note's current
      // amount, so a later edit cannot make the mirror disagree.
      let lineQuery = supabaseAdmin
        .from("journal_lines")
        .select("account_id,debit,credit")
        .eq("journal_entry_id", existing.id);
      const { data: lines } = await lineQuery;
      const original = {
        header: { reference_number: noteNumber } as DebitNoteJournal["header"],
        lines: ((lines as any[]) ?? []).map((l) => ({
          account_id: String(l.account_id),
          debit: Number(l.debit ?? 0),
          credit: Number(l.credit ?? 0),
          description: `Reversal - ${noteNumber}`,
        })),
      } as DebitNoteJournal;
      const journal = buildDebitNoteReversalJournal(original, {
        journalNumber: reversalNumber,
        date: new Date().toISOString().slice(0, 10),
        description: `Reversal - debit note ${noteNumber}`,
      });
      if (!journal) {
        return NextResponse.json(
          { error: "Cannot reverse the note: its journal could not be read", code: "unverified" },
          { status: 409 },
        );
      }
      reversalId = await writeJournal(supabaseAdmin as never, journal, tenantId);
      createdReversalId = reversalId;
    }

    const { error: updErr } = await supabaseAdmin
      .from("debit_notes")
      .update({ status: "cancelled" })
      .eq("id", id);
    if (updErr) throw updErr;

    await logAudit(context, {
      action: "update",
      entity: "debit_notes",
      entityId: id,
      metadata: { reversal: true, note_number: noteNumber, journal_id: reversalId },
    });
    return NextResponse.json({ ok: true, journal_id: reversalId, created: !!existing });
  } catch (error) {
    if (createdReversalId) {
      try {
        await supabaseAdmin.from("journal_entries").delete().eq("id", createdReversalId);
      } catch {
        /* best effort */
      }
    }
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
