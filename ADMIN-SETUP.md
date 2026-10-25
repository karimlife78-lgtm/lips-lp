# 🛠️ Cosmarab Admin — Setup (10 minutes, one time)

Your private control center lives at **`cosmarab.com/admin`**. It's password-protected and gives you:

| View | What it does |
|---|---|
| **Command** | Tracking health for every funnel, a "needs attention" list (missing or stub pixels, missing purchase events, hijacked pages, broken smart-links, losing campaigns), 14-day spend chart, one-click TikTok/Snap ad URLs. |
| **Pages** | Every published page scanned live: TikTok / Snap / Meta pixel IDs, purchase events, SKU, which sheet + tab its orders land in, smart-link overrides. Rename the label, set a main URL, add extra URLs. |
| **Ad Launcher** | Builds the destination URL for TikTok, Snap, Meta or a custom source, with each platform's dynamic macros. Direct or `/r/` smart-link. Runs a pre-launch pixel check. |
| **Campaigns** | Daily spend + leads log (+ confirmed / delivered from the call center). CPL, est. net profit and a SCALE / WATCH / KILL call per platform and per page. |
| **Smart-links** | Stable links for ads (`cosmarab.com/r/snap-oct`). Change where they point anytime, with **no ad re-launch**. Flags links that point to missing pages or hide real ones. |
| **Profit Lab** | The COD Network breakeven + profit-at-scale P&L, a CPL × delivery-rate sensitivity grid, and per-page AOV / cost. |
| **System** | Connections, which env vars are set, full pixel audit, backup export / import. |

Press **Ctrl K** (or `/`) anywhere to jump to any page, copy any ad URL, or run an action.

> The admin does **not** read or show orders, and nothing in it touches the order flow (`/api/submit-order`, the sheets, the Apps Scripts). Campaign numbers are entered by hand and stored in your browser, so export a backup from **System** now and then.

---

## Step 1 — Set 5 environment variables in Vercel

Go to **vercel.com → your `lipslp` project → Settings → Environment Variables** and add:

| Name | Value | Notes |
|---|---|---|
| `ADMIN_USER` | _your username_ | e.g. `cosmarab` |
| `ADMIN_PASS` | _your password_ | pick something strong |
| `ADMIN_SECRET` | _random 40+ chars_ | signs your login cookie — see below |
| `SHEET_TOKEN` | _random 30+ chars_ | shared secret for the sheet |
| `GOOGLE_SCRIPT_URL` | _your Apps Script URL_ | you may already have this set |

Generate the two random secrets (run in any terminal, or just mash the keyboard):
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> `GOOGLE_SCRIPT_URL` is the **same** variable your order form already uses — if orders are reaching your sheet today, it's set. You're just adding the other four.

---

## Step 2 — Upgrade your Google Apps Script (enables Orders + Smart-Links)

The admin **reads** orders from your sheet, so the script needs a read endpoint.

1. Open your Google **Sheet → Extensions → Apps Script**.
2. Delete everything, paste the full contents of **`apps-script.gs`** (in this project).
3. Change `SHEET_TOKEN` at the top to the **exact same value** you put in Vercel.
4. **Deploy → New deployment → Web app** · Execute as **Me** · Who has access **Anyone** · Deploy.
5. Copy the **Web App URL** → that's your `GOOGLE_SCRIPT_URL` in Vercel (update if changed).

> Re-deploy after any future edit: **Deploy → Manage deployments → ✎ → New version**.

The script auto-creates two tabs the first time: **`Orders`** and **`Redirects`**.

> ⚠️ **Column change:** orders now save with an extra `timestamp` (ISO) column first and a `source` column last. If you have an old `Orders` tab, rename it (e.g. `Orders_old`) so the script makes a fresh one with the correct headers — otherwise old rows may misalign in the table.

---

## Step 3 — Deploy & log in

```bash
git add -A && git commit -m "Add password-protected admin: dashboard, profit calc, ad smart-links"
git push
npx vercel --prod --name lipslp
```

Then open **`https://cosmarab.com/admin`** and sign in. Done. 🎉

---

## How the Ad Smart-Links work (your ads superpower)

1. In the admin → **Ad Smart-Links**, create one: slug `snap-oct` → target `https://cosmarab.com/`.
2. Put **`cosmarab.com/r/snap-oct`** as the link in your Snapchat/TikTok ad.
3. Need to point that ad somewhere else later (new offer, A/B page, maintenance)? Just edit the target in the admin. The ad keeps running — **no review, no re-launch.**

Any `?utm_source=…` / click-ID params on the smart-link are **forwarded** to the destination, so tracking stays intact.

## How channel reporting works

The landing page now auto-detects traffic source (`utm_source`, `?src=`, or referrer) and saves it with each order. Tag your ad links like `cosmarab.com/?utm_source=tiktok` (or use a Smart-Link) and the **Revenue by Channel** card fills itself in.

## Security notes
- Login is a signed, HttpOnly cookie (HMAC-SHA256). Sessions expire after 12h.
- The Orders read endpoint and Smart-Link writes are gated by `SHEET_TOKEN` — random visitors can't read your data even if they find the script URL.
- `/admin` is marked `noindex` so it won't show up in Google.
- Calculator fees/assumptions are stored privately in your browser (localStorage), not on any server.
