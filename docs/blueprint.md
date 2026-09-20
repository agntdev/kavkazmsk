# KavkazMsk — Bot specification

**Archetype:** community

**Voice:** warm and encouraging — write every user-facing message, button label, error, and empty state in this voice.

A Russian-language Telegram classifieds bot for the Caucasus community in Moscow: users can post moderated text/photo listings, browse and filter by category and neighbourhood, contact sellers via Telegram or optional phone reveal, and report content. Admins receive notifications for pending listings and flags and can moderate from an admin chat.

> This is the complete contract for the bot. Implement EVERY entry point, flow, feature, integration, and edge case below. The completeness review checks the bot against this document after each build pass.

## Primary audience

- Russian-speaking residents of Moscow from the Caucasus community
- Visitors in Moscow seeking goods, services, housing, jobs, or community notices
- Local sellers and service providers seeking simple classifieds

## Success criteria

- Users can create a listing via the guided wizard and receive a preview within the chat
- Recent listings are discoverable and filterable by category and neighbourhood from the Browse menu
- Contact seller opens a Telegram chat or reveals phone only when seller opted-in
- Admin chat receives notifications for new pending listings and user reports within 10s of action
- Moderation actions (approve/reject/remove/ban) performed from admin chat change listing status and history persistently
- Users can edit, renew, delete, and mark their own listings; these actions are reflected immediately in Browse and My Ads

## Entry points

Every feature must be reachable from the bot's command/button surface (button-first; only /start and /help are slash commands).

- **/start** (command, actor: user, command: /start) — Open the main menu and welcome text in Russian
  - outputs: main_menu
- **Post объявление** (button, actor: user, callback: post:start) — Start the guided Post ad wizard (title → category → description → price → photos → location → contact pref → confirm)
  - inputs: title(text), category(selection), description(text), price(text/number, optional), photos(up to 8), location(selection or text), contact_preference(selection)
  - outputs: listing:draft, preview, notification_to_admin_if_pending
- **Browse объявления** (button, actor: user, callback: browse:start) — Open browsing UI with filters for category and neighbourhood and pagination
  - inputs: category(filter, optional), neighbourhood(filter, optional), pagination(callback)
  - outputs: listing:list, listing:detail
- **Мои объявления** (button, actor: user, callback: myads:start) — Show user's active and archived listings with actions (edit/renew/delete/mark sold)
  - inputs: user_id(from Telegram)
  - outputs: listing:list(user)
- **Правила** (button, actor: user, callback: rules:view) — Show posting rules and prohibited content guidance
  - outputs: rules_text
- **/help** (command, actor: user, command: /help) — Fallback help surface describing main features and admin contact
  - outputs: help_text

## Flows

### Post ad wizard
_Trigger:_ callback:post:start or /post

1. Collect title via ForceReply (text, max 120 chars)
2. Show category list (seeded 9 categories) as inline buttons — store selection
3. Collect description via ForceReply (text, max 2000 chars)
4. Collect price (slash command or ForceReply; allow text like 'б/п' for negotiable)
5. Collect up to 8 photos (photo uploads, with 'Done' button to continue)
6. Ask location: show seeded Moscow neighbourhoods as buttons + 'Other' → ForceReply text
7. Ask contact preference: 'Via Telegram' (default) or 'Show phone' (ForceReply phone or text)
8. Confirm preview with 'Publish' / 'Edit' / 'Cancel' buttons
9. On Publish: apply moderation rule (auto-publish or mark pending depending on account/flags) and send preview to user and notify admin if pending

_Data touched:_ Listing, User, Photo, Category, ListingHistory

### Browse & filter
_Trigger:_ callback:browse:start or /browse

1. Show recent and pinned ads page (paginated inline keyboard)
2. Allow filter by category via inline buttons
3. Allow filter by neighbourhood via inline buttons or 'All Moscow'
4. Open listing detail on selection with actions: Contact seller, Report, Save, Back
5. Contact seller: if seller chose Telegram → open t.me link or inline mention; if phone → reveal masked phone with confirmation

_Data touched:_ Listing, Category, User, SavedListing

### View listing & contact
_Trigger:_ callback:listing:open

1. Render listing preview (photos carousel, title, price, location, contact preference, created_at, status)
2. Actions: Contact seller (open Telegram or reveal phone), Report (open report subflow), Save (toggle bookmark)
3. If contact via Telegram: create ephemeral contact hint and include seller's Telegram @username or open chat deep-link
4. If show phone chosen: reveal phone only after explicit confirmation and log consent

_Data touched:_ Listing, User, Report, SavedListing

### My ads management
_Trigger:_ callback:myads:start or /myads

1. List user's listings with status badges and quick-action inline buttons
2. Edit flow: re-run wizard prefilled for editable fields (title, description, price, photos, location, contact_pref)
3. Renew: update created_at or bump position (no payment in v1)
4. Delete/Mark sold: update status and write to ListingHistory and broadcast change to Browse
5. Prevent edits on removed/banned listings

_Data touched:_ Listing, ListingHistory, User

### Report & moderation notifications
_Trigger:_ callback:listing:report

1. Collect report reason via inline choices (spam, illegal, inappropriate, other) and optional comment via ForceReply
2. Save report and send structured notification to ADMIN_CHAT_ID with listing link and reporter id (anonymized to admin if reporter requested)
3. Admin can approve/reject/remove/ban via inline admin controls in admin chat; actions update listing status and write history
4. Notify reporter (optional) about action taken (if reporter provided contact)

_Data touched:_ Report, Listing, User, ListingHistory

### Admin moderation actions
_Trigger:_ message or callback in ADMIN_CHAT_ID

1. Receive new-pending or flagged listing notification with inline buttons: Approve, Reject(with reason), Remove, Ban user
2. On Approve: set listing.status=published, record history, notify owner
3. On Reject: set listing.status=removed/rejected, record reason in ListingHistory, notify owner with feedback
4. On Ban: set user.banned=true, optionally remove all user's listings and notify admins and user

_Data touched:_ Listing, ListingHistory, User, Report

## Owner-supplied settings

The OWNER provides these; they are collected in chat and injected into the environment at deploy. Read each one from the environment where it is used (`ctx.env.<KEY>` / `env.<KEY>` on Cloudflare Workers; `process.env.<KEY>` only as a Node/harness fallback — never the sole read). Do NOT invent your own way of learning the value, do NOT ask for it in a bot message, and do NOT hardcode a default.

- **ADMIN_CHAT_ID** — where new listing notifications and reports are sent
  - this is the OWNER's own chat id; the platform already knows it. Read `ADMIN_CHAT_ID` via `ctx.env` (prefer toolkit `adminChatId` / `requireOwner`) — never ask a user, never treat whoever writes first as the admin, never invent claim-admin or open manage for everyone.
  - may be UNSET at runtime: the bot must still start, and the feature needing ADMIN_CHAT_ID must say so plainly instead of failing.

Your behavioral specs run WITHOUT these values, so no spec may depend on one.

## Data entities

Durable data (must survive a restart) uses the toolkit's persistent store, never in-memory maps.

An entity that merely NAMES an owner-supplied setting above (an admin chat, an API account) is not something to store or discover — read it from the environment.

- **User** _(retention: persistent)_ — Telegram user profile and optional contact data
  - fields: telegram_id, username, display_name, phone(optional), joined_at, banned(boolean), first_listing_submitted_at
- **Listing** _(retention: persistent)_ — Classified listing created by a user
  - fields: id, owner_telegram_id, title, description, photos(array of photo_ids), category, price(optional text), location(neighbourhood or text), contact_preference(enum:telegram|phone), phone_stored_if_opted(optional), status(enum:published|pending|removed|sold), pinned(boolean), created_at, updated_at
- **Photo** _(retention: persistent)_ — Stored photo metadata and file reference
  - fields: photo_id, file_id(telegram), owner_listing_id, uploaded_at, width, height, size_bytes
- **Category** _(retention: persistent)_ — Seeded listing categories
  - fields: id, title, description, seeded(boolean)
- **Report** _(retention: persistent)_ — User-submitted report/flag against a listing
  - fields: id, reporter_telegram_id(optional), listing_id, reason(enum), comment(optional), created_at, handled_by_admin_id(optional), resolution(optional)
- **ListingHistory** _(retention: persistent)_ — Audit trail of status changes and admin actions
  - fields: id, listing_id, changed_by(telegram_id or 'system'), action(enum:created,approved,rejected,removed,edited,renewed,marked_sold,condensed), reason(optional), timestamp
- **SavedListing** _(retention: persistent)_ — User bookmarks of listings
  - fields: user_telegram_id, listing_id, saved_at

## Integrations

- **Telegram** (required) — Bot API messaging, deep-links, file/photo uploads and user identity
Call external APIs against their real contract (correct endpoints, ids, params); credentials from env. Do not fake responses.

## Owner controls

- Set or update ADMIN_CHAT_ID (notify target)
- Approve / Reject / Remove listings from admin chat
- Ban / Unban users from admin chat
- Seed and edit category list (add/remove categories)
- Pin / Unpin listings
- Configure neighbourhood seed list
- View export of listings and reports (CSV)
- Set moderation policy toggle: first-listing moderation ON/OFF

## Notifications

- Notify ADMIN_CHAT_ID when a listing is pending approval or flagged (structured message with listing preview and inline admin actions)
- Notify owner when listing is published, approved, rejected (with reason), removed or marked sold
- Notify reporter optionally when admin resolves their report
- Notify user on edit/renew/delete confirmations
- In-chat ephemeral notifications for upload success/failure and input validation errors

## Permissions & privacy

- Phone is only stored and shown if user explicitly chooses 'Show phone' during posting; otherwise contact is via Telegram only
- Photos and listing content are stored persistently for as long as the listing exists; owner can delete listing which removes photos from listing and flags for cleanup
- Reporter identity is preserved in reports but can be anonymized to admins if reporter requests (configurable)
- Users can request account/data deletion; this removes personal data (phone) and anonymizes listings while keeping non-personal listing content for audit
- All user-facing texts default to Russian with brief English fallbacks

## Edge cases

- User uploads >8 photos — accept first 8 and inform user; provide clear error message
- Photo upload fails or file too large — provide retry and accept compressed fallback
- User provides invalid phone format — store as raw text but mark as unverified and warn
- Location not in seeded list — accept free-text neighbourhood and flag for admin review if suspicious
- Concurrent edits: user attempts to edit listing while admin removes it — surface error and refresh state
- Admin chat unreachable or ADMIN_CHAT_ID misconfigured — queue admin notifications and surface owner-visible error in setup diagnostics
- User blocks the bot or deletes Telegram account — listings remain but contact via Telegram unavailable; phone reveal (if given) remains according to preference
- Spam and mass-posting: detect simple rate limits (e.g., max X posts/day per user) and place new listings into pending moderation
- Deleted user: keep listings with owner id anonymized or optionally remove per owner request

## Required tests

- Dialog-level acceptance: Post ad wizard happy path including photos and phone reveal
- Publish flow: auto-publish vs pending moderation behavior for first listing and flagged listings
- Browse filters: category and neighbourhood filtering and pagination correctness
- Contact action: Telegram deep-link opens and phone reveal only when opted-in and after confirmation
- My Ads actions: edit, renew, delete, mark sold and verify ListingHistory records changes
- Report flow: create report and verify ADMIN_CHAT_ID receives structured notification and admin actions update status
- Admin actions: approve/reject/remove/ban executed from admin chat update listing/user state and notify owner
- Persistence: photos, listings, and history survive bot restart and queries return consistent data
- Edge case tests: upload >8 photos, oversized image, invalid phone, location free-text, concurrent edit/remove race
- Permissions/privacy: phone not revealed unless opted-in, deletion request removes phone and anonymizes data

## Assumptions

- Primary UI language is Russian; short English fallback strings are acceptable
- Seed categories: For sale (goods), Services, Jobs, Housing, Vehicles, Events, Community, Lost & Found, Other
- Seed neighbourhood list will be provided later; default includes 'All Moscow' and several common boroughs
- Moderation policy: auto-publish unless user is new or listing flagged; first listing for new accounts may be marked pending
- No payments or promoted/pinned paid listings in v1; pinning is manual via admin controls
- Phone verification is out of scope; phone stored as provided by user
- Bot operates under Telegram Bot API limits and stores files via Telegram file_id references
