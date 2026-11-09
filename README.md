# Ads Pilot

A dashboard for your Facebook ads. It pulls your numbers every hour, suggests changes (pause, budget up or down, refresh ads), and emails you those suggestions to approve with a click. Approved changes are sent to Facebook through the Meta Marketing API, and every change is logged with who made it.

## Run it locally

```bash
npm install
cp .env.example .env    # then edit .env
npm start               # http://localhost:3000
```

With no `.env` file it runs on **sample data**, and the team password is `demo`.

## What's in it

| Piece | File |
|---|---|
| KPIs: leads, cost per lead, spend, click→lead rate, CTR, CPC, CPM, frequency | `src/metrics.js`, `public/app.js` |
| Suggestion rules (all thresholds come from `.env`) | `src/engine.js` |
| Facebook connection (read insights, pause, change budget) | `src/sources/meta.js` |
| Daily email with Approve/Dismiss links | `src/email.js` |
| Server, login, scheduler | `src/server.js` |

### Several brands

Put every ad account in `META_AD_ACCOUNT_IDS`, separated by commas, for example `act_111,act_222,act_333`. The dashboard then has a brand picker, with **All brands** as the default.

Each brand has its own **target cost per lead, daily spend cap, max budget move and judge-after spend**, which you edit under **⚙ Targets & limits**. Saving replaces that brand's waiting suggestions with ones based on the new numbers, and the change is recorded in the activity log. The values in `.env` are only the starting values for a newly added brand.

### Ad set budgets

Some campaigns set their budget on each ad set instead of on the campaign. For those, a budget suggestion changes every active ad set by the same percentage, so the split between them stays the same. Campaigns with a lifetime budget never get budget suggestions, but pause and creative suggestions still apply.

### Suggestion rules (last 7 days compared with the 7 days before)

- **Pause:** 0 leads after spending 2× the target cost per lead, or cost per lead more than 2× target.
- **Cut budget by 20%:** cost per lead more than 30% above target.
- **Raise budget by 20%:** cost per lead at least 20% under target with 5+ leads, and never above `DAILY_SPEND_CAP`.
- **Refresh ads:** frequency above 3.5, or click-through rate down 30%+ week over week.
- **Review audience:** click-through rate under 0.8%.

Nothing changes until someone approves it. Suggestions expire after 3 days.

### AI review (Claude)

Claude reads each brand's last 7 days against the week before and that brand's target. It writes a headline, what's working, what needs attention, 2–4 things to do this week, and new ad copy to test (with a **Copy** button). It only gives advice and never changes anything in Facebook.

- **Turn it on:** add `ANTHROPIC_API_KEY` to `.env`. You get a key from console.anthropic.com under API Keys; that account needs billing set up.
- **When it runs:** whenever someone clicks **Write this week's review**, for the brand shown or for All brands. It also runs automatically on `AI_WEEKLY_DAY` (Monday by default) just before the daily email, and that email then opens with the review.
- **Better ad copy:** in **⚙ Targets & limits**, fill in "What this brand sells, and to whom" for each brand.
- **Cost:** it uses Claude Opus 5.5 at `AI_EFFORT=medium`. One review is a few thousand tokens in and out, which is a few cents. `AI_EFFORT=low` is cheaper and faster; `high` is more thorough.
- **Refusal fallback:** in the rare case Claude's safety filters decline a request, the API automatically retries on Anthropic's recommended backup model (the `fallbacks: "default"` setting in `src/ai.js`).
- **What gets sent to Anthropic:** campaign names, the numbers shown on the dashboard, your targets and the brand description. No customer or lead details are sent.

### Why the email buttons open a confirm page

Work email systems (Microsoft 365, Google, Mimecast) open every link in an email to scan it for viruses. If a link applied the change directly, the scanner would approve everything. So the email button opens a page with one **Yes, apply** button.

## Connecting real Facebook data

1. In **Meta Business Settings → Users → System users**, create a system user (Admin) and give it access to your ad account.
2. At **developers.facebook.com**, create an app (type: Business) and add the **Marketing API** product. Connect the app to your Business.
3. Generate a token for the system user with `ads_read` and `ads_management`. System-user tokens don't expire.
4. In `.env`, set `META_ACCESS_TOKEN` and `META_AD_ACCOUNT_IDS=act_…` (the number is in Ads Manager's URL; separate several with commas).
5. Run `npm run check-meta`. It confirms the token, lists the campaigns and where each budget is set, and shows which result type will count as a lead.
6. Set `DATA_SOURCE=meta`, delete the `data` folder to clear the sample data, then run `npm start`.

Because only your own company's ad accounts are used, Meta's full app review isn't needed.

**Budget note:** budget suggestions work on campaigns with a campaign-level budget (Advantage+ / CBO). If a campaign's budget is set on its ad sets, the table shows "Ad sets" and the pause and creative suggestions still work.

## Email

Fill in the SMTP settings in `.env`. Google Workspace and Microsoft 365 both work with an app password, as do SendGrid and Resend. The email goes out daily at `DIGEST_HOUR`, or right away with **Send email now** on the dashboard.

## Hosting online

The app needs one always-on server with a disk that keeps its data (the database is a SQLite file). The repo includes a `Dockerfile` and a Render blueprint (`render.yaml`).

**Render (recommended), about $7–8 a month:**

1. Put this folder in a private GitHub repo.
2. In Render, choose **New → Blueprint** and pick the repo. It creates the web service and a 1 GB disk, and generates `APP_SECRET`.
3. Fill in the values it asks for: `BASE_URL`, `DASHBOARD_PASSWORD`, `META_ACCESS_TOKEN`, `META_AD_ACCOUNT_IDS` and the SMTP settings.
4. After the first deploy, set `BASE_URL` to the `https://…onrender.com` address, or add your own domain such as `ads.storagematerials.com`.

Use the paid "starter" plan rather than the free one, because the free plan sleeps and would miss the hourly sync and the daily email. `TZ` is set to Central time so the email arrives at `DIGEST_HOUR` your time; change it if you're in another time zone.

The same Docker image also runs on **Railway** or **Fly.io**: mount a volume at `/app/data`.
