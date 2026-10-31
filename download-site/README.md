# STRATUM download site

The page producers download STRATUM from, starting with Alpha v11. They sign in with Discord, the site checks that they are in the **Stratum** server (id `1561488145688694806`), and only members get the Mac and Windows downloads. It runs on Vercel and has no dependencies.

- `public/index.html` is the page.
- `api/login` sends producers to Discord. It asks only for their name and server list (`identify guilds`).
- `api/callback` checks the sign-in and server membership, then sets a signed cookie that lasts 30 days.
- `api/download?file=mac|windows|manual` sends members to the file.
- `api/me` reports the sign-in state to the page; `api/logout` signs out.

Test it with `node tests/download-gate-test.mjs`, which uses a stand-in Discord.

## Setting it up

1. **Discord application.** At https://discord.com/developers/applications, choose New Application and name it "STRATUM". Under OAuth2:
   - Copy the **Client ID**.
   - Reset and copy the **Client Secret**.
   - Add the redirect `https://<your-site>/api/callback`.
2. **Invite that never expires.** In the Stratum server, create an invite set to *Expire after: Never*. Done: discord.gg/PtpChEj8Gc never expires (it is the default in `lib/gate.js`).
3. **Vercel project.** Use this folder as the project root. Set these environment variables in the Vercel dashboard (type them in yourself, never paste the secret into a chat):

   | Variable | Value |
   |---|---|
   | `DISCORD_CLIENT_ID` | from step 1 |
   | `DISCORD_CLIENT_SECRET` | from step 1 |
   | `SESSION_SECRET` | any long random text, different from the Discord secret; it signs the sign-in cookie, and sign-in stays off without it |
   | `DISCORD_INVITE` | the never-expiring invite from step 2 |
   | `SITE_URL` | e.g. `https://stratum-download.vercel.app` (must match the Discord redirect) |
   | `DOWNLOAD_MAC_URL`, `DOWNLOAD_WINDOWS_URL`, `DOWNLOAD_MANUAL_URL` | where each file lives (see below) |

4. **The files.** Put the v11 DMG, the Windows zip and the manual somewhere that isn't listed publicly, such as Vercel Blob storage, which gives each file a long random address. Set the download variables to those addresses. Don't attach them to the public GitHub release.

The gate is for building the community, not for copy protection. A member could share a file's address, and the source code is public on GitHub. To change that, give each release's files new addresses.
