import { NextRequest, NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/supabase-admin";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { fullName, email, phone, password } = body ?? {};

    if (!fullName || !email || !phone || !password) {
      return NextResponse.json({ error: "الرجاء تعبئة جميع الحقول المطلوبة." }, { status: 400 });
    }

    // Check if user already exists by email
    const { data: existingUsersData, error: listError } = await supabaseAdmin.auth.admin.listUsers({
      page: 1,
      perPage: 1000,
    });

    if (listError) {
      return NextResponse.json({ error: listError.message ?? "تعذر التحقق من المستخدم." }, { status: 400 });
    }

    const existingUser = existingUsersData?.users?.find(u => u.email === email) ?? null;
    let authUserId: string | null = null;
    let createdAuthUser = false;

    if (existingUser) {
      // SECURITY: this is a public, unauthenticated endpoint. It must never be
      // able to reset the password of an existing account, which would hand an
      // attacker full control of any known e-mail address. An existing account
      // must go through the authenticated password-recovery flow instead.
      return NextResponse.json(
        { error: "هذا البريد الإلكتروني مسجّل مسبقاً. الرجاء تسجيل الدخول." },
        { status: 409 },
      );
    } else {
      const { data: userData, error: authError } = await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: {
          full_name: fullName,
          phone,
        },
      });

      if (authError || !userData.user) {
        return NextResponse.json({ error: authError?.message ?? "تعذر إنشاء المستخدم." }, { status: 400 });
      }

      authUserId = userData.user.id;
      createdAuthUser = true;

      const { error: confirmError } = await supabaseAdmin.auth.admin.updateUserById(authUserId, {
        email_confirm: true,
      });

      if (confirmError) {
        await supabaseAdmin.auth.admin.deleteUser(authUserId);
        return NextResponse.json({ error: confirmError.message ?? "تعذر تفعيل البريد الإلكتروني." }, { status: 400 });
      }
    }

    if (!authUserId) {
      return NextResponse.json({ error: "تعذر إنشاء الحساب." }, { status: 400 });
    }

    const { data: existingCustomer, error: existingCustomerError } = await supabaseAdmin
      .from("customers")
      .select("id")
      .eq("email", email)
      .maybeSingle();

    if (existingCustomerError) {
      if (createdAuthUser) {
        await supabaseAdmin.auth.admin.deleteUser(authUserId);
      }
      return NextResponse.json({ error: existingCustomerError.message ?? "تعذر التحقق من بيانات العميل." }, { status: 400 });
    }

    let customerId = existingCustomer?.id ?? null;

    if (customerId) {
      const { error: updateCustomerError } = await supabaseAdmin
        .from("customers")
        .update({ full_name: fullName, phone, status: "active" })
        .eq("id", customerId);

      if (updateCustomerError) {
        if (createdAuthUser) {
          await supabaseAdmin.auth.admin.deleteUser(authUserId);
        }
        return NextResponse.json({ error: updateCustomerError.message ?? "تعذر تحديث بيانات العميل." }, { status: 400 });
      }
    } else {
      const { data: customerRows, error: customerError } = await supabaseAdmin
        .from("customers")
        .insert({
          full_name: fullName,
          email,
          phone,
          status: "active",
        })
        .select("id");

      if (customerError || !customerRows || customerRows.length === 0) {
        if (createdAuthUser) {
          await supabaseAdmin.auth.admin.deleteUser(authUserId);
        }
        return NextResponse.json({ error: customerError?.message ?? "تعذر حفظ بيانات العميل." }, { status: 400 });
      }

      customerId = customerRows[0].id;
    }

    const { error: userError } = await supabaseAdmin.from("users").upsert(
      {
        id: authUserId,
        full_name: fullName,
        email,
        role: "client",
        customer_id: customerId,
        phone,
        is_active: true,
      },
      { onConflict: "id" }
    );

    if (userError) {
      return NextResponse.json({ error: userError.message ?? "تعذر تفعيل الحساب." }, { status: 400 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: "تعذر إنشاء الحساب." }, { status: 500 });
  }
}
