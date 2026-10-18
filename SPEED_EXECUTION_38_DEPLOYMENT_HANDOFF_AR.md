# دليل النشر إلى الإنتاج — SPEED ERP (التنفيذ 38)

> **حالة هذا المستند:** خطة تنفيذ جاهزة للتحويل إلى المشغّل. **لم يتم النشر، ولم
> تُطبَّق أي هجرة (Migration)، ولم يُلمس الإنتاج.** كل خطوة تحتاج وصولاً أو
> تفويضاً من المالك موقّعة بصراحة في مكانها.
>
> **قاعدة أساسية:** كل قيمة مكتوبة هنا مأخوذة من المستودع أو من التقارير السابقة.
> أي قيمة غير مؤكدة مكتوب بجانبها **«غير مؤكد — يجب التحقق على الخادم»**.

---

## 1. المتطلبات والصلاحيات المطلوبة

| الصلاحية | الغرض | الحالة في بيئة التطوير |
| --- | --- | --- |
| وصول SSH/شل إلى خادم الإنتاج | تنفيذ أوامر النشر وإعادة التشغيل | **غير متوفر** (لا `/var/www`، لا `pm2`، لا `ssh`) |
| حساب PM2 للتطبيق `speed` | إعادة التشغيل | **غير متوفر** |
| مدير قاعدة بيانات Supabase (SQL Editor) | تطبيق الهجرات 001–007 | **غير متوفر** (لا مسار DDL من بيئة التطوير) |
| تفويض المالك لدمج الفرع إلى `main` | النشر يقرأ من `origin main` | **مطلوب صراحةً** |
| `GITHUB_TOKEN` للدفع (push) | نشر الفروع | متوفر في بيئة التطوير، **ولا يُستخدم دون إذن** |

**ملاحظة أمنية:** لا تُرسل كلمات المرور أو مفاتيح service-role أو سلسلة اتصال
قاعدة البيانات في أي محادثة أو تقرير. تُضبط على الخادم في ملف `.env.local` فقط.

---

## 2. الإصدار المُجمّد (Source Commit + Checksum)

| العنصر | القيمة |
| --- | --- |
| الفرع | `feat/final-hardening-round5` |
| التزام المصدر (HEAD) | `dd28b5e821ed29aa9e9541c3b19956ec0548906f` (المختصر `dd28b5e`) |
| الالتزام الأب | `595e7d4` (التنفيذ 36) |
| `origin/main` الحالي | `29a005c4a9ddc964f6d92662c25ca991ca7fb477` |
| العلاقة بـ `origin/main` | **22 التزاماً للأمام، 0 للخلف** — تقدّم سريع آمن (Fast-Forward) |
| الملف المضغوط | `release/speed-dd28b5e.tar.gz` |
| بصمة SHA-256 | `5a4c38b40ddd5eca089daa41929dfdad12707e7f8d09e3367a5c6b3c8bce4a7a` |
| عدد الملفات | 462 (مطابق تماماً لـ `git ls-files`) |

**ملاحظة:** الملف المضغوط مخزّن محلياً فقط ومستثنى من Git (`/release/`)، ويجب
نقله إلى الخادم عبر قناة آمنة عند الحاجة. النشر الفعلي يقرأ الالتزامات من
`origin main`، وليس من الملف المضغوط.

---

## 3. فحوصات ما قبل النشر (على الخادم)

نفّذ كل سطر وتأكد من النتيجة المتوقعة:

```bash
cd /var/www/speed.harbourconsultancies.com

# 1) الالتزام الحالي قبل أي تغيير — سجّله للرجوع إليه
git rev-parse HEAD

# 2) يجب أن يكون الفرع main
git rev-parse --abbrev-ref HEAD        # المتوقع: main

# 3) يجب أن يكون الشجرة نظيفة (لا تعديلات غير محفوظة)
git status --porcelain                 # المتوقع: لا مخرجات

# 4) تأكد من وجود ملف البيئة قبل أي عملية
test -f .env.local && echo "env present" || echo "STOP: .env.local missing"

# 5) مساحة القرص (البناء يحتاج مساحة)
df -h /var/www

# 6) إصدار Node
node -v
```

**إذا فشل أي فحص من 2 أو 3 أو 4 — توقّف. لا تُكمل.**

---

## 4. النسخ الاحتياطي (التطبيق + قاعدة البيانات)

### 4.1 نسخة احتياطية للتطبيق (على الخادم)

```bash
mkdir -p /root/backups
TS=$(date +%F-%H%M)
tar czf /root/backups/speed-app-$TS.tgz \
  --exclude=node_modules --exclude=.next \
  -C /var/www/speed.harbourconsultancies.com .
# تحقق من سلامة النسخة
tar tzf /root/backups/speed-app-$TS.tgz >/dev/null && echo "backup OK: $TS"
# احفظ الالتزام الحالي مع النسخة
git rev-parse HEAD > /root/backups/speed-app-$TS.commit
```

**يجب حفظ ملف `.env.local` داخل النسخة الاحتياطية أو نسخه منفصلاً، وعدم
استبداله أو حذفه أبداً.**

### 4.2 نسخة احتياطية لقاعدة البيانات (Supabase)

- من لوحة Supabase للمشروع `chlkmdobhvfnldqkgdji`: **Database → Backups**.
  إن كانت النسخ التلقائية أو PITR مفعّلة، سجّل وقت أقرب نقطة استرجاع.
- أو عبر `pg_dump` باستخدام سلسلة الاتصال الصحيحة:
  ```bash
  pg_dump "$DATABASE_URL" -Fc -f /root/backups/speed-db-$TS.dump
  ```
  **غير مؤكد:** سلسلة `DATABASE_URL` الحالية في المستودع تشير إلى مضيف pooler
  قديم مرفوض (حسب التنفيذ 05.4/05.5). **يجب أن يزوّد المالك سلسلة الاتصال
  الصحيحة** — لا تُخمّن ولا تُطبع.

**لا تُكمل النشر بدون نسخة احتياطية مؤكدة للتطبيق وقاعدة البيانات.**

---

## 5. نشر الإصدار (أوامر آمنة)

> النشر يقرأ من `main`. قبل تنفيذ هذا القسم، يجب أن يكون المالك قد دمج الفرع
> إلى `main` (القسم 7). إذا لم يتم الدمج بعد، **توقّف**.

```bash
cd /var/www/speed.harbourconsultancies.com

# سجّل الالتزام قبل السحب (لخطة الرجوع)
git rev-parse HEAD | tee /tmp/speed-pre-deploy.commit

# سحب تقدّم سريع فقط — لا دمج ولا إعادة كتابة تاريخ
git fetch origin
git pull --ff-only origin main

# تحقق: يجب أن يكون الالتزام = dd28b5e821ed29aa9e9541c3b19956ec0548906f
git rev-parse HEAD

# التثبيت والبناء
npm ci          # أو: npm install إن لم يوجد package-lock محدث
npm run build

# إعادة التشغيل مع تحميل متغيرات البيئة
pm2 restart speed --update-env
pm2 save
```

**إذا فشل `npm run build` — توقّف ولا تُعد التشغيل. راجع قسم الرجوع (القسم 8).**

---

## 6. فحص الصحة والسجلات

```bash
# حالة العمليات
pm2 status
pm2 describe speed

# السجلات (آخر 100 سطر) — راقب أي خطأ
pm2 logs speed --lines 100

# فحص من نفس الخادم على المنفذ المحلي 3090
curl -s -o /dev/null -w 'local / -> %{http_code}\n' http://127.0.0.1:3090/
curl -s -o /dev/null -w 'local /login -> %{http_code}\n' http://127.0.0.1:3090/login

# فحص عبر النطاق العام
curl -s -o /dev/null -w 'public / -> %{http_code}\n' https://speed.harbourconsultancies.com/
curl -s -o /dev/null -w 'public /login -> %{http_code}\n' https://speed.harbourconsultancies.com/login
curl -s -o /dev/null -w 'anon /dashboard -> %{http_code} %{redirect_url}\n' https://speed.harbourconsultancies.com/dashboard
curl -s -o /dev/null -w 'anon /api/me -> %{http_code}\n' https://speed.harbourconsultancies.com/api/me
```

**النتائج المتوقعة:** الجذر و`/login` = 200، و`/dashboard` بدون جلسة = 307 نحو
`/login`، و`/api/me` بدون جلسة = 401. هذه القيم مُتحقق منها فعلياً من الإنتاج
الحالي قبل النشر (التنفيذ 37) ويجب أن تبقى كما هي بعده.

---

## 7. قرار الفرع — تسلسل آمن (يتطلب تفويض المالك)

الخادم ينشر من `main`، لكن `origin/main` لا يحتوي التزامات التنفيذ 33–37. لنشر
الإصدار **دون فقدان أي التزام** ودون إعادة كتابة التاريخ:

```bash
# نفّذها من نسخة محلية نظيفة (وليس على الخادم)
git fetch origin

# تأكد أن الدمج تقدّم سريع بحت
git merge-base --is-ancestor origin/main feat/final-hardening-round5 && echo "FF-safe"
git rev-list --count origin/main..feat/final-hardening-round5   # المتوقع: 22

# تأكد أن التزامات التنفيذ 33-37 موجودة ضمن الإصدار (لن تُحذف بصمت)
for s in bbc5e3a 795292f f008ec7 595e7d4 dd28b5e; do
  git merge-base --is-ancestor $s dd28b5e && echo "ok $s" || echo "MISSING $s"
done

# دمج تقدّم سريع إلى main ثم دفع عادي (بدون --force)
git checkout main
git merge --ff-only origin/main
git merge --ff-only feat/final-hardening-round5
git push origin main
```

**لا تستخدم `--force` ولا `reset --hard` أبداً.** الدفع أعلاه تقدّم سريع بحت.

---

## 8. الرجوع (Rollback) — مع الحفاظ على البيانات المالية

### 8.1 رجوع التطبيق

```bash
cd /var/www/speed.harbourconsultancies.com
PREV=$(cat /tmp/speed-pre-deploy.commit)
git reset --hard "$PREV"     # يستعيد ملفات Git فقط — لا يمسّ قاعدة البيانات
npm ci && npm run build
pm2 restart speed --update-env
pm2 save
```

أو استعد النسخة الاحتياطية المضغوطة:
```bash
tar xzf /root/backups/speed-app-<TS>.tgz -C /var/www/speed.harbourconsultancies.com
```

### 8.2 قواعد صارمة

- **لا تستعد نسخة قاعدة بيانات قديمة فوق معاملات أحدث.** استرجاع قاعدة البيانات
  يفقد كل المعاملات التي جرت بعده.
- **لا تعكس القيود المالية يدوياً.** لتصحيح قيد خاطئ، استخدم مستند عكس
  (return / reverse) من داخل التطبيق، لا حذفاً مباشراً.
- رجوع الهجرات: لكل هجرة ملف `*_rollback.sql` مطابق. **الرجوع لا يحذف أي عمود ولا
  أي صف** (غير مُدمّر)، لكنه يعيد فتح الثغرة الأمنية — اعتبره حادثاً لا خطوة روتينية.

---

## 9. تفعيل قاعدة البيانات (SQL Editor في Supabase)

**المشروع الصحيح:** `chlkmdobhvfnldqkgdji` — تأكد من ظهور هذا المعرّف في أعلى
محرّر SQL قبل أي تنفيذ.

**ترتيب التطبيق الإلزامي:**

| # | الملف | يعتمد على |
| --- | --- | --- |
| 1 | `supabase/PRODUCTION_ACTIVATION_001_002_003.sql` | — |
| 2 | `supabase/PRODUCTION_ACTIVATION_004.sql` | 001,002 |
| 3 | `supabase/PRODUCTION_ACTIVATION_005_006.sql` | 003 (للـ005)، 002 (للـ006) |
| 4 | `supabase/PRODUCTION_ACTIVATION_007.sql` | 002 |

**قبل الملف الثالث (005/006):** شغّل استعلام الفحص المسبق الموجود داخل الملف
(كشف القيود المكرّرة). **يجب أن يُرجع صفر صفوف.** إذا أعاد أي صف، أوقف العمل
وصحّح القيود المكرّرة أولاً — وإلا سيفشل الـ005 بالتصميم (وهو ملفوف في معاملة
واحدة، فأي فشل يُلغي الملف بالكامل).

**قواعد إلزامية:**
- **لا تتجاهل أي جملة SQL فاشلة، ولا تُكمل بعد متطلب فاشل.**
- كل الملفات إضافية (Additive) وقابلة لإعادة التشغيل (Idempotent) — إعادة
  التشغيل آمنة ولا تكرّر شيئاً.
- لا تحذف جداول ولا أعمدة ولا صفوفاً.

---

## 10. اختبارات الدخان بعد النشر + الأدلة المطلوبة

### 10.1 اختبارات لا تحتاج تسجيل دخول (يمكن تنفيذها فوراً)

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://speed.harbourconsultancies.com/
curl -s -o /dev/null -w '%{http_code}\n' https://speed.harbourconsultancies.com/login
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://speed.harbourconsultancies.com/dashboard
curl -s -o /dev/null -w '%{http_code}\n' https://speed.harbourconsultancies.com/api/me
curl -s -o /dev/null -w '%{http_code}\n' https://speed.harbourconsultancies.com/api/public/vehicles
```
المتوقع: 200 / 200 / 307→login / 401 / 200.

### 10.2 اختبارات تحتاج هويات مُصادَقة (مشغّل بصلاحية)

1. **دخول مدير الشركة** (`admin` مقيّد بمستأجر SPEED): تسجيل الدخول → الوصول إلى
   `/dashboard` → تنفيذ عملية إدارية داخل الشركة فقط.
2. **دخول المدير العام** (`super_admin`، بلا مستأجر): تسجيل الدخول → الوصول إلى
   `/dashboard` → الوصول إلى مناطق الإدارة العامة فقط.
3. **فصل المستأجرين بهويتين:** هوية المستأجر (أ) لا تستطيع قراءة أو تعديل أو حذف
   سجلات المستأجر (ب)؛ ولا إدخال صفوف إلى المستأجر (ب).
4. **دورة مالية كاملة:** فاتورة بيع، فاتورة إيجار، مشتريات، رواتب، تحويل بنكي،
   قيد يومية، ثم تقرير مالي — والتأكد أن القيود متوازنة (مدين = دائن).
5. **حماية التكرار:** إعادة إرسال نفس الطلب لا تُنشئ قيداً ثانياً.

يمكن استخدام سكربت التحقق الجاهز (يتطلب بيانات الاعتماد كمتغيرات بيئة على الخادم،
ولا يطبع كلمات المرور):
```bash
npm run verify:admins
```

### 10.3 الأدلة التي يجب جمعها

- مخرجات `git rev-parse HEAD` على الخادم (يجب = `dd28b5e...`).
- مخرجات `pm2 status` و`pm2 logs speed --lines 100` (خالية من الأخطاء).
- أكواد HTTP لكل فحص في 10.1.
- لقطات/سجلات لاختبارات 10.2 مع إخفاء أي بيانات حساسة.
- نتيجة استعلامات ما بعد التطبيق (POST-FLIGHT) من حزم الهجرات.
- نتيجة `npm run build` (نجاح).

---

## 11. ما هو غير مؤكد ويجب التحقق منه على الخادم

- الالتزام المنشور حالياً على الخادم (`git rev-parse HEAD` هناك).
- توفر نسخ احتياطية تلقائية لقاعدة البيانات ووقت آخر نقطة استرجاع.
- سلسلة اتصال `DATABASE_URL` الصحيحة (المخزّنة حالياً في المستودع غير صالحة).
- إصدار Node الفعلي على الخادم.
- هل هناك تعديلات غير محفوظة على الخادم (يجب أن تكون الشجرة نظيفة).
