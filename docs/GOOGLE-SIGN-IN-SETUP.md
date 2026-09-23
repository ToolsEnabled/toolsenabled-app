# Sign in with Google — registering the client this product signs in with

> **The flow is proven; the shipping client is NOT registered yet.** On
> 2026-08-11 a client in the owner's personal project (`840383906222-…`,
> secret in the vault as `product_google_signin_client_secret`) completed a
> real Google sign-in end to end (`node tools/google-signin-live-qa.mjs`,
> 21/21). That run proved the CODE. It did not produce a client this product
> can ship: that client lives in the owner's personal project, and this
> document's own closing paragraph forbids shipping it. Until the product's
> own Desktop client is registered (the procedure below, ~10 minutes) and its
> id lands in `config/google-signin.json`, every install honestly reports
> Google sign-in as not configured — and `tools/check-asar-manifest.mjs`
> refuses any build that ships the vault client instead.

The flow is built and **tested against Google's own servers**, not against a
stand-in. What this document describes is registering a Google OAuth client
**to this product**, which means clicking through the Google Cloud Console. It
takes about ten minutes and no decisions.

When you finish you will have **two** strings — a client id, which looks like

    123456789012-a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6.apps.googleusercontent.com

and a client secret, which looks like `GOCSPX-…`.

**An earlier version of this document said to copy the id and ignore the
secret. That was wrong, and it was measured wrong.** Google refuses a Desktop-app
token exchange that arrives without the secret:

    HTTP 400  {"error":"invalid_request","error_description":"client_secret is missing."}

with a correct PKCE S256 verifier present. A build configured with the id alone
opens the browser, signs the person in at Google, and then fails on the last
step — every time, for everybody. Both strings are needed.

**Neither string is a password, and the second one is not really a secret.**
Google's own words for installed applications: *"the client secret is obviously
not treated as a secret."* It is a second public name for the application. It
grants nothing on its own — PKCE, generated fresh per sign-in and never leaving
the customer's computer, is what proves an exchange is genuine. This is what
every desktop program that signs in with Google does, `gcloud` included.

**What that does mean:** the client you make here must be **for this product and
for sign-in only**. Never reuse the `google_client_id` in the vault — that one
holds Drive, Gmail and Calendar grants for the owner's own accounts, and
publishing its identifiers inside an installer would hand every customer the
application identity those grants were issued to.

---

## Before you start: what you are actually agreeing to

**What the product will ask Google for.** Three scopes: `openid`, `email`,
`profile`. That is a person's Google account identifier, their email address,
and their display name. It is **not** access to Drive, Gmail, Calendar,
Contacts, Photos or anything else, and the code refuses to start a sign-in if
that list ever widens (`GOOGLE_SIGNIN_SCOPE_REFUSED`).

**Why that matters commercially.** Those three are Google's *non-sensitive*
scopes. Asking for them keeps this product out of Google's sensitive-scope
review entirely — no security assessment, no annual re-verification, no
third-party audit, no fee. The moment a Drive or Gmail scope is added, all of
that arrives. Do not add one to this client.

**What is stored on a customer's computer afterwards.** Their Google account
identifier and their verified email address. **No Google password, no access
token, no refresh token.** The product never calls a Google API on anybody's
behalf, so there is nothing for a stored token to do except be stolen. Once
Google has said who somebody is, the product mints its own local session.

**A shipped program cannot keep a secret**, which is why PKCE — not the client
secret — is what actually protects this flow. A fresh random verifier is made
for every sign-in, never leaves the customer's computer, and only its SHA-256
goes to Google in the browser URL. An authorization code stolen on the way back
is useless without it. The client secret rides along because Google's Desktop-app
clients require it, and it is public in every desktop application that has one.

---

## Step 1 — pick or create the Google Cloud project

1. Open <https://console.cloud.google.com/>, signed in as yourself.
2. Top left, the project picker. Either reuse an existing project or press
   **New Project**.
   - Name: `ToolsEnabled` (this name is internal; customers never see it).
   - No organisation and no billing account is needed. **Sign-in with these
     scopes costs nothing and will not create a billing line.**
3. Press **Create**, and wait for the picker to switch to the new project.

## Step 2 — the consent screen (what a customer sees)

Menu → **APIs & Services** → **OAuth consent screen**.

1. **User type: External.** Press **Create**.
   - "External" is right even though you are the only one so far: "Internal" is
     only available to Google Workspace organisations and would limit sign-in to
     your own domain.
2. App information:
   - **App name:** `ToolsEnabled` — *this is the name a customer reads in the
     Google dialog: "ToolsEnabled wants to access your Google Account."* Make it
     the name you ship under.
   - **User support email:** your address, from the dropdown.
   - **App logo:** optional. Skip it for now — uploading one triggers a brand
     verification review you do not need yet.
3. **Developer contact information:** your address again. Press **Save and
   continue**.
4. **Scopes.** Press **Add or remove scopes** and tick exactly these three:
   - `.../auth/userinfo.email`
   - `.../auth/userinfo.profile`
   - `openid`

   They are all in the "Your non-sensitive scopes" group. **Add nothing else.**
   Press **Update**, then **Save and continue**.
5. **Test users.** While the app is in *Testing*, only addresses listed here can
   sign in — up to 100. Add your own address so you can try it. Press **Save and
   continue**, then **Back to dashboard**.

### Testing vs Published — the decision to make later, not now

The consent screen starts in **Testing**. That is correct for now and has two
consequences worth knowing before they surprise you:

- only the test users you listed can sign in; everyone else is refused by
  Google with an error the product will show them; and
- a sign-in issued in Testing expires after **7 days**, so you would be asked to
  sign in again weekly.

When you are ready for customers, come back to this screen and press **Publish
app**. With only these three non-sensitive scopes, publishing does **not**
require Google's verification review — the app moves to "In production" and the
7-day expiry goes away. That is the whole reason the scope list is what it is.

## Step 3 — create the client

Menu → **APIs & Services** → **Credentials**.

1. **Create credentials** → **OAuth client ID**.
2. **Application type: Desktop app.**
   - Not "Web application". This is the choice that makes the whole flow
     possible, and it has been **verified against Google directly**: with a
     Desktop-app client, Google accepts an arbitrary loopback redirect
     (`http://127.0.0.1:<any port>/…`) and sends the browser straight on to
     sign-in. The same request with an off-machine redirect is refused
     `redirect_uri_mismatch`, which is what a Web application client would do to
     every loopback port too. A Web application client demands a fixed,
     pre-registered redirect URI, and a desktop program cannot have one.
   - You do **not** enter a redirect URI. Google allows any loopback port for
     this client type, which is what lets each sign-in take a fresh one.
3. **Name:** `ToolsEnabled desktop` (internal only).
4. Press **Create**.
5. A dialog shows the **Client ID** and a **Client secret**. **Copy both.** The
   secret is required — see the top of this document for why, and for why it is
   not the kind of secret that needs protecting. It still does not belong in a
   chat message or a screenshot.

## Step 4 — give the client to the product

Three ways. Any of them is fine.

**A. This installation only — in the vault.** This is where this product's own
credential catalogue says credentials live, it is protected by Windows rather
than sitting in a plain-text file, and it needs no rebuild. Two records, named
exactly:

    product_google_signin_client_id
    product_google_signin_client_secret

Each is stored by running the vault's own masked prompt against **this
installation's** state root — the same store the product itself reads:

```powershell
$env:TOOLSENABLED_STATE_ROOT = "$env:APPDATA\ToolsEnabled\capability"
$secrets = "$env:LOCALAPPDATA\Programs\ToolsEnabled\resources\capability\tools\secrets.ps1"
powershell -ExecutionPolicy Bypass -STA -File $secrets prompt-set product_google_signin_client_id
powershell -ExecutionPolicy Bypass -STA -File $secrets prompt-set product_google_signin_client_secret
```

**The state root is the part that goes wrong.** A vault in a source checkout and
the vault the installed product reads are two different files, and a client
stored in the first one is invisible to the second — the same split that once
hid the owner's payment card from his own installation. If sign-in still says it
is not switched on, the refusal on that screen now prints the full path of the
vault it read; compare it with the one you wrote to.

**Do not use `google_client_id` / `google_client_secret` for this.** Those are
already in the vault on a developer machine and they are a *different* client —
the capability layer's, holding Drive, Gmail and Calendar grants. Sign-in
refuses to use them and says so by name.

**B. This installation only — a file, no rebuild.** Create this file:

    %APPDATA%\ToolsEnabled\google-signin.json

with exactly this in it, your two strings substituted:

```json
{
  "clientId": "PASTE-YOUR-CLIENT-ID-HERE.apps.googleusercontent.com",
  "clientSecret": "PASTE-YOUR-CLIENT-SECRET-HERE"
}
```

Restart ToolsEnabled. The sign-in screen changes from "Sign in with Google — not
available on this copy" to a working button. This is the exact path the live
test exercises, so it is known to work end to end.

**C. Every copy you ship — goes in the installer.** Create the same file at
`config/google-signin.json` in the app tree
(`C:\Users\<you>\Desktop\wt-capability`) and rebuild. `config/` is a shared file
in this repo's lane rules, so hand the change to the coordinator rather than
committing it from a lane.

The product looks in four places in this order and uses the first it finds: the
`TOOLSENABLED_GOOGLE_CLIENT_ID` environment variable, then this installation's
vault (A), then the per-installation file (B), then the shipped file (C). The
vault outranks the files because a `google-signin.json` is a plain file anything
running as you can drop into `%APPDATA%`, and that must not outrank a protected
record you stored on purpose. An environment variable still beats everything: it
is how one launch, or one test run, is overridden.

If the vault cannot be read at all, that does **not** knock out B and C — a
working file is still used. What it changes is what the screen says when nothing
resolves: *could not read the vault*, never *the vault is empty*.

## Step 5 — try it

Open ToolsEnabled → Settings → **Open sign-in**, or the first-run walkthrough.
Press **Sign in with Google**. Your browser opens, you pick your account, and
the window says `Signed in as <your name>` with your address underneath.

If something goes wrong, the screen says which of these it was, and you are left
signed out either way:

| What the screen says | What it means | What to do |
| --- | --- | --- |
| *not switched on in this version … that vault was read just now and holds neither* | Step 4 has not been done, or it was done against a different store | the sentence prints the vault it read — compare it with the one you wrote to |
| *could not read this installation's own vault just now … not the same as it holding none* | the vault is locked, damaged, or belongs to another Windows account | nothing has been decided about your setup; fix the vault and look again |
| *does hold `google_client_id`, but that is the … client … for Drive, Gmail and Calendar* | the capability layer's client was stored, not a sign-in client | register a separate Desktop client and store it under the two `product_google_signin_*` names |
| *holds `product_google_signin_client_id` but no …`_secret`* | only half the pair was stored | store the secret from that same Google client |
| *is not in the form Google issues* | the string does not end in `.apps.googleusercontent.com` | you pasted the secret into `clientId`, or only part of the id |
| *Google did not complete the sign-in (invalid_request)* | the client secret is missing from the file, and Google's Desktop-app clients require it | add `clientSecret` to the same file the `clientId` is in — it must be the secret for **that** client |
| *Google did not complete the sign-in (invalid_client)* | the id and the secret are not from the same client | copy both again from the same client's dialog |
| *could not reach Google* | no network | use an account on this computer instead |
| *Google did not complete the sign-in (access_denied)* | you pressed Cancel, or your address is not a listed test user | add yourself under Test users, or publish the app |
| *did not carry a valid Google signature* | the reply was not really Google's | do not retry blindly; something is intercepting the connection |
| *has not verified the email address on that account* | Google does not vouch for that address | use an account whose address Google has verified |

---

## What this does not do, said plainly

- It is **not** a login to Claude or ChatGPT and carries no subscription. Those
  stay in their own programs (SHIPMENT-PLAN blocker B14).
- It does **not** replace the account-on-this-computer. That still works, is
  still offered, and is the right answer with no network or for anyone who will
  not use Google.
- It proves who somebody is **to this installation**. It is not an attestation
  to any remote party, and anyone already signed in to Windows as that user can
  still remove the local account files.

## For whoever reads the code next

| What | Where |
| --- | --- |
| the flow: PKCE, loopback, system browser | `shell/google-signin.cjs` |
| id_token verification against Google's JWKS | `shell/google-oidc.cjs` |
| where the client id comes from, and the refusals | `shell/google-signin-config.cjs` |
| how the main process reads the vault at all | `shell/vault-presence.cjs` |
| the account a verified identity becomes | `shell/product-account.cjs`, `signInWithGoogle` |
| the channels (none of which takes an identity from the page) | `shell/main.cjs`, `mc-account:google-*` |
| the screen | `src/account-markup.js`, `src/views/account.js` |
| refusals, forgeries and replays | `tools/test/google-signin.test.mjs` |
| the account rules | `tools/test/google-account.test.mjs` |
| the packaged product, driven against a **local** provider | `tools/google-signin-packaged-qa.mjs` |
| the packaged product, driven against **Google itself** | `tools/google-signin-live-qa.mjs` |

**The engine's `src/lib/google-oauth.js` is a different thing, and its client
must not be shipped here.** That is the capability layer: a refresh-token flow
that lets the owner's own agents call Google APIs as him, with
`google_client_id` / `google_client_secret` / `google_refresh_token__<alias>` in
the vault, holding Drive, Gmail and Calendar grants.

The distinction is **not** that one holds a secret and the other cannot — both
send one, because Google requires it. The distinction is *whose grants hang off
the client*. Publishing the vault client's identifiers inside an installer would
put the application identity that holds the owner's Drive and Gmail access into
every customer's hands. Register a separate Desktop-app client for sign-in, with
the three identity scopes and nothing else.

**What has been proven, and when.** On 2026-08-11 the vault's Desktop-app client
was used to drive the packaged build through a complete, genuine Google sign-in:
Google's authorization server, Google's token endpoint, Google's JWKS, a real
account, a real verified email on screen, and a session that survived a restart —
21 checks, no simulation but the hand that clicked. That run establishes that the
flow, the code and this document's procedure are correct. It does **not**
establish that the shipping client exists: it borrowed the vault's client, which
is exactly the one the paragraph above says never to ship.
