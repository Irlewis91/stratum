# Setting up STRATUM Sync

STRATUM Sync keeps every producer's beats in their account so they open on Mac, Windows, phones and tablets. It runs on
[Supabase](https://supabase.com) (free to start: 1 GB of beats, 50,000 producers a month). About 15 minutes, once.

## 1. Create the Supabase project
1. Sign up at supabase.com and choose **New project**. Name it `stratum`, pick a strong database password (keep it in
   your password manager; STRATUM never needs it) and the region nearest most of your producers.
2. When it is ready, open **SQL Editor › New query**, paste everything in [`supabase/schema.sql`](../supabase/schema.sql),
   and press **Run**. It should say "Success. No rows returned".

## 2. Email sign-in with a code
1. **Authentication › Sign In / Providers › Email**: leave it enabled.
2. **Authentication › Emails › Templates**: in both **Magic Link** and **Confirm signup**, replace the message with
   something like `Your STRATUM sign-in code is {{ .Token }}`. The code is what producers type into STRATUM.
3. The free plan sends only a few emails an hour. Before launch, add your own email sender under
   **Authentication › Emails › SMTP Settings** (for example Resend or Postmark).

## 3. Discord sign-in
1. At https://discord.com/developers/applications choose **New Application** and name it `STRATUM`.
2. **OAuth2**: copy the **Client ID**, press **Reset Secret** and copy the **Client Secret**.
3. Under **Redirects**, add `https://<your-project-ref>.supabase.co/auth/v1/callback`
   (Supabase shows this exact address in step 4).
4. In Supabase, **Authentication › Sign In / Providers › Discord**: switch it on, paste the Client ID and Client Secret, save.

## 4. Where sign-in may return
**Authentication › URL Configuration**:
- **Site URL:** `https://matovalabs.github.io/stratum/`
- **Redirect URLs:** add both:
  - `https://matovalabs.github.io/stratum/**`  (phones, tablets and browsers, plus the Mac app)
  - `https://app.stratum/**`  (the Windows app)

## 5. Connect STRATUM
In **Project Settings › API** (or **Connect**), copy the **Project URL** and the **anon / publishable** key. Never use
the `service_role` / secret key. Put them in [`web/js/sync-config.js`](../web/js/sync-config.js) (or send them to whoever
builds STRATUM). The Sync button appears once both are set.

Both values are meant to be public: what each producer can reach is enforced by the rules from step 1.

## Checking it
`python3 tests/mock-sync-server.py 8799` runs a stand-in server, and `STRATUM.app/Contents/MacOS/STRATUM --sync-test
http://127.0.0.1:8799` checks sign-in and syncing in the Mac app without touching the real project.
