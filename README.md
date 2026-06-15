# Cosmarab — صفحة هبوط كريم تفتيح الشفاه (COD / السعودية)

صفحة هبوط واحدة عالية التحويل، مبنية بـ HTML/CSS/JS خام (بدون مكتبات) — سريعة جداً ومناسبة لإعلانات Snapchat / TikTok / Meta والدفع عند الاستلام.

## الملفات
- `index.html` — الصفحة كاملة (التصميم + قمع الطلب التفاعلي + صفحة الشكر).
- `vercel.json` — إعدادات النشر + رؤوس أمان.

## القمع (Funnel)
1. **Hero** — هوك قوي + ألم عاطفي + قبل/بعد + زر «شوف العروض».
2. **العروض** (مبكراً): 3 عروض دفع عند الاستلام:
   - قطعة واحدة — **199 ر.س**
   - قطعتان (الثانية بنص السعر) — **299 ر.س** ⭐ الأكثر طلباً
   - 3 قطع (اشترِ 2 والثالثة مجاناً) — **398 ر.س** 👑 أفضل صفقة
3. **تدفّق الطلب** (يفتح عند الضغط على عرض):
   - خطوة 1: العرض المختار + الكمية + إضافات (Upsells) + ملخص حي.
   - خطوة 2: الاسم / الجوال / المدينة + ملخص حي + «تأكيد الطلب».
4. **صفحة الشكر** — تأكيد + تعليمات COD + «بنتصل فيك خلال دقائق» + ترقية اختيارية.

---

## ⚠️ مهم: ربط استلام الطلبات (TODO)
حالياً الطلب يظهر فقط في صفحة الشكر ويُطبع في الـ console. لاستقبال الطلبات فعلياً، افتح `index.html`
وابحث عن `TODO — CONNECT ORDER DELIVERY HERE` داخل دالة `submit`، واختر أحد الخيارين:

- **واتساب:** ضع رقمك مكان `9665XXXXXXXX` وفعّل كود `window.open('https://wa.me/...')`.
- **Webhook (Google Sheets / Make / n8n):** فعّل كود `fetch('https://YOUR_WEBHOOK_URL', ...)`.

## 📊 ربط البكسل (Pixel)
في أعلى `<head>` يوجد كود Snapchat Pixel معلّق. أزل التعليق وضع `SNAP_PIXEL_ID`.
الأحداث جاهزة تلقائياً: `PAGE_VIEW` · `VIEW_CONTENT` (فتح عرض) · `ADD_TO_CART` (خطوة 2) · `PURCHASE` (تأكيد).
الكود يدعم أيضاً `ttq` (TikTok) و `fbq` (Meta) إذا أضفتها.

---

## التشغيل محلياً
```bash
# أي سيرفر ثابت، مثال:
npx serve .
# أو افتح index.html مباشرة في المتصفح
```

## النشر على GitHub + Vercel
```bash
git init
git add .
git commit -m "Cosmarab COD landing page"
git branch -M main
git remote add origin https://github.com/<USERNAME>/<REPO>.git
git push -u origin main
```
ثم على [vercel.com](https://vercel.com):
1. **Add New → Project** واختر المستودع.
2. Framework Preset: **Other** — لا حاجة لأمر build (موقع ثابت).
3. **Deploy**.

أو عبر CLI:
```bash
npm i -g vercel
vercel --prod
```

## تخصيص سريع
- **الأسعار/العروض:** عدّل `data-price` و `data-qty` و `data-was` في عناصر `.offer` داخل `index.html`.
- **الإضافات (Upsells):** عدّل `data-price` في عناصر `.upsell` وكائن `UPSELLS` في الـ JS.
- **الألوان:** متغيرات `:root` أعلى `<style>` (`--red`, `--ink`).
- **الصور:** استبدل روابط Unsplash في الـ Hero و«قبل/بعد» بصور المنتج الحقيقية لرفع التحويل.
