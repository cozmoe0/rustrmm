# Ticketing and helpdesk API (Phase 9)

This document covers tickets, comments, SLAs, client contacts, email notifications, email-to-ticket
over IMAP, time tracking, canned responses, alert-to-ticket rules and end-user "Request support"
from the agent.

It uses the same conventions as `api-automation.md`:

- Routes live under `/api/v1`.
- Requests use the session cookie and `X-CSRF-Token`.
- Errors use the standard envelope.
- Results are filtered by the caller's scope. Tickets always belong to a client.

## Permissions

| Permission | Covers |
|---|---|
| `tickets.view` | Read tickets, comments, contacts, SLAs |
| `tickets.manage` | Create and edit tickets, comment, assign, change status, merge, link |
| `tickets.time` | Log, edit and delete your own time entries; view time reports for your scope |
| `tickets.settings` | Queues, SLA policies, canned responses, email settings, alert-to-ticket rules, contacts import |

How scope applies:

- A ticket with a `site_id` is visible to grants on that site, its client or the installation;
  a ticket without a site needs a client-level or global grant (the same rule as alerts).
  Tickets outside the caller's scope answer `404`; visible tickets without the needed permission
  answer `403` with `details.permission`.
- Installation-wide objects (queues, SLA policies, shared canned responses, e-mail settings,
  alert-to-ticket rules) need a **global** `tickets.settings` grant to change. Contact import
  needs `tickets.settings` over the client. Deleting a ticket needs `tickets.settings` over its
  client.

## Tickets

```jsonc
// Ticket
{ "id": "…", "number": 1042,               // per-installation sequence, shown as #1042
  "subject": "Printer offline in reception", "description": "…markdown…",
  "client_id": "…", "client_name": "…", "site_id": "…" | null,
  "site_name": "…" | null,
  "contact": { "id", "name", "email" } | null,
  "status": "open",                        // new | open | pending | on_hold | resolved | closed
  "priority": "high",                      // low | normal | high | urgent
  "type": "incident",                      // incident | request | problem | change | alert
  "queue": { "id", "name" },
  "assignee": { "id", "name" } | null,
  "tags": ["printers"],
  "cc": ["office@example.com"],            // extra recipients of public comments
  "devices": [{ "id", "hostname" }], "alerts": [{ "id", "title", "status" }],
  "tickets": [{ "id", "number", "subject", "status" }],   // linked tickets
  "source": "console",                     // console | email | agent | alert | api
  "sla": { "policy_id", "policy_name",
           "first_response_due": "…", "first_response_at": "…" | null, "first_response_breached": false,
           "resolution_due": "…", "resolved_at": "…" | null, "resolution_breached": false,
           "paused": false } | null,       // paused while pending or on_hold, when the policy says so
  "time_spent_minutes": 45, "billable_minutes": 30,
  "created_by_name": "…", "created_at": "…", "updated_at": "…", "last_activity_at": "…",
  "closed_at": "…" | null,
  "merged_into": { "id", "number" } | null }
```

Ticket details:

- **Numbers** come from a per-installation sequence (`ticket_sequence`); the first ticket is
  `#1001`. Numbers are never reused, even after a delete.
- **Status flow.** New tickets start as `new`. A technician's first public comment moves `new` to
  `open`. A reply from the contact (by e-mail) reopens a `pending`, `on_hold` or `resolved`
  ticket to `open`. A reply to a `closed` ticket opens a follow-up ticket linked to it instead.
  `closed_at` is set while the status is `closed`.
- `sla` is `null` only when no policy applies (the default policy always exists, so normally
  never).
- `created_by_name` is the technician, the contact or requester (e-mail, agent), or `System`
  (alert rules).

### Comment

```jsonc
// Comment
{ "id": "…", "ticket_id": "…",
  "author": { "type": "user" | "contact" | "system", "id", "name" },
  "visibility": "public" | "internal",
  "body": "…markdown…",
  "source": "console" | "email" | "agent" | "system",
  "attachments": [{ "id", "file_name", "size_bytes", "content_type" }],
  "created_at": "…", "edited_at": null }
```

- **Public comments** are emailed to the contact and CCs.
- **Internal notes** never leave the console.
- **Bodies** are rendered as sanitised Markdown. Raw HTML is never rendered.
- A contact author whose address is not a known contact has `id: null` and `name` set to
  `Name <address>`.
- A technician's public comment counts as the **first response** for the SLA.

### Ticket routes

| Route | Permission | Notes |
|---|---|---|
| `GET /tickets?status=&priority=&queue_id=&assignee=me\|none\|<id>&client_id=&site_id=&contact_id=&device_id=&q=&sla=breached\|due_soon&sort=&cursor=&limit=50` | `tickets.view` | `{ items: [Ticket], next_cursor, counts: { new, open, pending, on_hold, mine, unassigned, breached, resolved, due_soon } }` |
| `POST /tickets` | `tickets.manage` | Body `{ subject, description, client_id, site_id?, contact_id?, priority, type, queue_id?, assignee_id?, tags?, device_ids?, alert_ids? }` |
| `GET /tickets/{id}` | `tickets.view` | `{ ticket, comments: [Comment], activity: [{ at, actor_name, kind, from, to }], time_entries: [TimeEntry] }` |
| `PATCH /tickets/{id}` | `tickets.manage` | Partial update of `subject`, `description`, `status`, `priority`, `type`, `queue_id`, `assignee_id`, `contact_id`, `site_id` or `tags`. Every change is recorded in `activity` |
| `POST /tickets/{id}/comments` | `tickets.manage` | `multipart/form-data` with the fields `body`, `visibility` and repeated `files` (each at most 25 MiB; all common document and image types; executables are refused). Returns the `Comment` |
| `PATCH /tickets/{id}/comments/{cid}` | `tickets.manage` | Author only, within 15 minutes |
| `POST /tickets/{id}/merge` | `tickets.manage` | Body `{ into_ticket_id }`. Moves comments and links, then closes this ticket |
| `POST /tickets/{id}/links` | `tickets.manage` | Body `{ device_ids?, alert_ids?, ticket_ids? }` |
| `DELETE /tickets/{id}/links` | `tickets.manage` | Same body as adding links |
| `POST /tickets/bulk` | `tickets.manage` | Body `{ ids, action: "assign" \| "status" \| "priority" \| "queue" \| "tag", value }` |
| `GET /tickets/attachments/{id}` | `tickets.view` | Download with `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox` |
| `GET /devices/{id}/tickets` | `tickets.view` | |
| `GET /tickets/stats?client_id=&from=&to=` | `tickets.view` | `{ opened, resolved, avg_first_response_minutes, avg_resolution_minutes, sla_met_pct, by_priority, by_queue, backlog_trend: [{ date, open }] }` |
| `DELETE /tickets/{id}` | `tickets.settings` | Deletes the ticket with its comments, activity, links and time entries (audited as `ticket.deleted`). `204` |

Notes on the ticket routes:

- **List.**
  - `status`, `priority`, `queue_id`, `client_id`, `device_id` also accept comma-separated
    lists. Extra filters: `site_id`, `type`, `source` (lists) and `tag` (one tag).
  - The default `status` is `new,open,pending,on_hold`; `status=all` lists every status.
  - `q` searches the subject, description, client name, contact name and e-mail, and matches
    `1042` or `#1042` to the number.
  - `sla=breached`: either target breached. `sla=due_soon`: a running clock with an unmet
    target due within 60 minutes.
  - `sort` is `last_activity` (default, newest first), `created`, `oldest`, `updated`, `number`,
    `priority` (urgent first) or `due` (soonest resolution due first).
  - `next_cursor` is opaque; `limit` is 1–200.
  - `contact_id` (comma-separated) filters by the ticket's contact.
  - `counts` ignore `status` and match the other filters. `new`, `open`, `pending`, `on_hold`,
    `mine` (the caller's), `unassigned`, `breached` and `due_soon` count active tickets;
    `resolved` counts tickets in status `resolved`. `due_soon` uses the `sla=due_soon` rule (a
    running clock with an unmet target due within 60 minutes).
- **Create** returns `201` with the Ticket.
  - `priority` defaults to the queue's `default_priority`, and `type` to `incident`.
  - `queue_id` defaults to "Support"; `assignee_id` defaults to the queue's
    `default_assignee_id` (when that user is active).
  - Also accepted: `cc` (up to 20 addresses).
  - `subject` is 1–200 characters on one line; `description` at most 100 000; at most 20
    tags of up to 40 characters.
  - Sites, contacts, devices and alerts must belong to `client_id`; devices and alerts are
    limited to 50 each.
  - Linking an alert sets its `ticket_id` (when unset) and records the alert event
    `ticket_created`.
- **Patch** returns the updated Ticket.
  - `assignee_id`, `contact_id` and `site_id` accept `null` to clear.
  - Also accepted: `client_id` (moves the ticket, for example out of the e-mail holding client;
    needs `tickets.manage` on the target, clears a site or contact of the old client unless new
    ones are given) and `cc`.
  - A priority or client change recomputes the SLA due times.
- **Activity kinds:** `created` (`to` = source), `subject`, `description`, `status`, `priority`,
  `type`, `queue`, `assignee`, `contact`, `site`, `client`, `tags`, `cc` (`from`/`to` hold display
  values), `linked` and `unlinked` (`device …`, `alert …`, `ticket #…`), `merged`,
  `sla_breached` (`first_response`, `resolution` or both), `time_logged`, `time_deleted` and
  `email_failed`.
- **Comments.**
  - The route also accepts JSON `{ body, visibility }` (no files). `visibility` defaults to
    `internal`. A comment needs a body (at most 100 000 characters) or files.
  - At most 10 files; the route accepts up to 110 MiB in total.
  - Accepted extensions: images (png, jpg, jpeg, gif, webp, bmp, tif, tiff, heic, heif, svg,
    ico), documents (pdf, txt, log, csv, tsv, md, rtf, json, xml, yaml, yml, ini, conf, cfg, doc,
    docx, xls, xlsx, ppt, pptx, odt, ods, odp, vsdx, pages, numbers, key), archives (zip, 7z, gz,
    tgz, tar, rar), mail (eml, msg), media (mp4, mov, webm, mp3, wav, m4a) and diagnostics (evtx,
    etl, dmp, pcap, pcapng, har).
  - Content starting with a PE, ELF, Mach-O or `#!` signature is refused whatever its name.
  - The stored `content_type` comes from the extension. Refusals answer `422`; the comment
    returns `201`.
- **Comment edit** body `{ body }`. It answers `403` for anyone but the author and
  `409 edit_window_closed` after 15 minutes.
- **Merge.**
  - Both tickets must be visible with `tickets.manage` and belong to the same client.
  - Comments, attachments, time entries, links (devices, alerts, tickets), the alerts'
    `ticket_id` and e-mail threads move to the target.
  - This ticket is closed with `merged_into` set and linked from the target. Merged tickets
    cannot be merged again (`409 already_merged`).
  - Returns `{ ticket }` (the target).
- **Links** return the updated Ticket. Ticket links are mutual. Devices and alerts must belong
  to the ticket's client. Removing an alert link clears the alert's `ticket_id`.
- **Bulk.**
  - `value` is a user id (`null` or `""` unassigns), a status, a priority or a queue id.
  - For `tag` it is a tag to add, or `-tag` to remove one.
  - Returns `{ updated, skipped, updated_ids, skipped_ids }`. Tickets outside the caller's scope,
    or unchanged, are skipped. At most 500 ids.
- **Device tickets** list every status unless `status` is given; same shape as `GET /tickets`.
  They need visibility of the device.
- **Stats.**
  - `from`/`to` are `YYYY-MM-DD` (inclusive days) or RFC 3339. The default is the last 30
    days; at most 366 days. The response also echoes `from` and `to`.
  - `opened` counts tickets created in the range; `resolved` counts tickets whose `resolved_at`
    is in the range (merged tickets excluded).
  - The averages are wall-clock minutes, `null` without data.
  - `sla_met_pct` is the share of resolved tickets with an SLA and no breach (one decimal),
    `null` without data.
  - `by_priority: [{ priority, opened, resolved }]` (urgent first).
  - `by_queue: [{ queue_id, queue_name, opened, resolved }]`.
  - `backlog_trend` gives one entry per day: tickets open at the end of that day.

## Queues, SLAs and canned responses

- **Queue.** `{ id, name, description, default_assignee_id?, default_priority, email_address? }`.
  A default "Support" queue exists.
- **SLA policy.**

  ```jsonc
  { "id", "name", "client_ids": [] /* empty = default */, "business_hours": { "timezone", "days": [1,2,3,4,5], "start": "08:00", "end": "18:00", "holidays": ["2026-12-25"] } | null /* null = 24x7 */,
    "targets": { "urgent": { "first_response_minutes": 30, "resolution_minutes": 240 }, "high": {…}, "normal": {…}, "low": {…} },
    "pause_on": ["pending", "on_hold"] }
  ```

  Due times are computed in business minutes. A ticket uses the first SLA policy that matches its
  client, otherwise the default policy.
- **Canned response.** `{ id, name, body, visibility, shared: bool, owner_id }`. The body supports
  the placeholders `{{contact.first_name}}`, `{{ticket.number}}`, `{{technician.name}}` and
  `{{client.name}}`.
- **Routes.** Each has a full CRUD set: `/ticket-queues`, `/sla-policies` and `/canned-responses`.
  These need `tickets.settings`, except canned responses: a user can manage their own private
  canned responses with `tickets.manage`.

Details:

- **CRUD shape.** `GET /x` returns `{ items }`, `GET /x/{id}` the object, `POST /x` returns `201`
  with the object, `PUT /x/{id}` takes the full object and returns it, and `DELETE /x/{id}`
  returns `204`. Queues and SLA policies are readable with `tickets.view`.
- **Queues.**
  - Responses add `builtin`, `open_tickets`, `created_at` and `updated_at`. `open_tickets` counts
    the active tickets of the queue that the caller can see (client/site scope of
    `tickets.view`).
  - The Support queue (`builtin-support-queue`) cannot be deleted (`409 builtin`). Deleting
    another queue moves its tickets to Support.
  - `name` is unique (case-insensitive, 1–80 characters).
  - `default_priority` defaults to `normal`. `email_address` routes new mail sent to that
    address into the queue.
- **SLA policies.**
  - Responses add `builtin`, `created_at` and `updated_at`.
  - The default policy `builtin-default-sla` ("Default (24x7)") is seeded with these targets:

    | Priority | First response | Resolution |
    |---|---|---|
    | urgent | 30 min | 4 h |
    | high | 1 h | 8 h |
    | normal | 4 h | 24 h |
    | low | 8 h | 72 h |

  - The default policy may be edited (for example to business hours) but not deleted
    (`409 builtin`) or limited to clients.
  - "First" means the oldest policy listing the client. The default is the built-in policy, or
    else the oldest one without clients.
  - Creating, changing or deleting a policy recomputes the due times of every active ticket.
- **Business hours.**
  - `days` are ISO weekdays (1 = Monday … 7 = Sunday). `start`/`end` are local `HH:MM` in
    `timezone`, and `end` may be `24:00`.
  - An `end` at or before `start` is an overnight window that ends the next day.
  - `holidays` are local dates (`YYYY-MM-DD`, at most 400); a window starting on a holiday does
    not count.
  - Local times skipped by a DST change start at the next valid instant.
  - Targets are 1–525 600 minutes; `pause_on` may hold `pending` and `on_hold` (both by default).
- **The SLA clock.**
  - `due = created_at + target + paused`, in business time, where `paused` is the business time
    spent paused.
  - The clock stops while the status is in `pause_on`, and also while `resolved` or `closed`
    (`resolved_at` is set then and cleared on reopening).
  - While paused the due times are frozen and `paused` is `true`. Resuming moves them by the
    pause.
  - A target is breached when the moment it was met (first response, resolution), or the moment
    the clock stopped, or now, lies after its due time. So a pause after the due time stays
    breached, and lowering the priority can clear a breach that the new target no longer
    implies.
  - Running clocks are checked every 30 s. A newly breached target records the activity
    `sla_breached` and publishes `ticket.updated`.
- **Canned responses.**
  - `GET` (list and single) needs `tickets.manage` (or a global `tickets.settings`). The list
    holds the shared responses and the caller's private ones.
  - Creating or changing a shared response, or sharing or unsharing one, needs a global
    `tickets.settings`. Private responses belong to their creator only. Responses add
    `created_at` and `updated_at`.
  - `visibility` defaults to `public`. `name` is 1–120 characters; `body` is 1–20 000.
  - Placeholders are filled by the server with
    `POST /canned-responses/{id}/render`, body `{ ticket_id }`, which returns
    `{ body, visibility }` for that ticket and the caller.
  - `{{contact.name}}` and `{{ticket.subject}}` are also supported. Unknown placeholders stay as
    written; missing values render empty.
  - The e-mail signature supports the same placeholders.

## Contacts

```jsonc
// Contact
{ "id": "…", "client_id": "…", "site_id": "…" | null, "name": "Dana Reyes", "email": "dana@example.com",
  "phone": "…", "title": "Office manager", "is_primary": true, "notify": true, "notes": "…" }
```

| Route | Permission | Notes |
|---|---|---|
| `GET /contacts?client_id=&q=` | `tickets.view` | |
| `POST` / `PUT` / `DELETE /contacts[/{id}]` | `tickets.manage` | |
| `POST /contacts/import` | `tickets.settings` | CSV upload with header row `name,email,phone,title,site`; returns `{ created, updated, errors: [{ row, message }] }` |

A contact's email address is unique per client.

Details:

- **Fields.** Contacts also carry `client_name`, `site_name`, `created_at` and `updated_at`;
  `GET /contacts/{id}` reads one.
  - `email` is optional but unique per client, case-insensitively; a duplicate answers
    `409 contact_exists`.
  - Setting `is_primary` clears it on the client's other contacts. `notify` defaults to `true`.
  - `client_id` is required on `POST` and cannot change.
- **List.** `GET /contacts` returns `{ items }` (at most `limit`, default 500, max 2000). `q`
  searches the name, e-mail and phone. `client_id` takes a list.
- **Import.**
  - Send `text/csv` with `?client_id=`, or `multipart/form-data` with a `file` field (and
    `client_id` as a field or in the query); at most 5 MiB, 10 000 rows, UTF-8.
  - Headers are matched case-insensitively in any order (extra columns are ignored); `name` and
    `email` are required in every row.
  - Rows update the contact with the same e-mail address, otherwise create one. `site` is
    matched by site name within the client.
  - `row` numbers count the header as row 1.
  - Audited as `contact.imported` with the counts.

## Time entries

```jsonc
// TimeEntry
{ "id": "…", "ticket_id": "…", "user": { "id", "name" }, "started_at": "…", "minutes": 30,
  "billable": true, "note": "Replaced toner", "created_at": "…" }
```

| Route | Permission | Notes |
|---|---|---|
| `POST /tickets/{id}/time` | `tickets.time` | |
| `PUT` / `DELETE /time-entries/{id}` | `tickets.time` | Own entries only, unless the caller has `tickets.settings` |
| `GET /time-entries?client_id=&user_id=&from=&to=&billable=` | `tickets.time` | `{ items, totals: { minutes, billable_minutes, by_client: […], by_user: […] } }`. Add `format=csv` for a CSV export |

The console offers a running timer on the ticket page, which posts an entry when stopped.

Details:

- **Fields.** Entries also carry `ticket_number`, `ticket_subject`, `client_id` and
  `client_name`.
  - The body is `{ minutes (1–1440), started_at?, billable? (default true), note? (≤ 2000) }`;
    `started_at` defaults to now minus `minutes`.
  - `POST` returns `201` and records the activity `time_logged`; `PUT` returns the entry,
    `DELETE` returns `204`.
  - Editing another user's entry needs `tickets.settings` over the client.
- **List.**
  - `from`/`to` take `YYYY-MM-DD` (inclusive days) or RFC 3339 and filter on `started_at`.
    `ticket_id` is an extra filter.
  - Totals: `by_client: [{ client_id, client_name, minutes, billable_minutes }]` and
    `by_user: [{ user_id, user_name, minutes, billable_minutes }]`, largest first.
  - The CSV has the columns `date,started_at,client,ticket,subject,user,minutes,billable,note`
    (`ticket` as `#1042`, `billable` as `yes`/`no`; cells that start like a spreadsheet formula
    are prefixed with `'`).

## Email

- **Outbound.** Uses the SMTP settings from Phase 6.
- **Events that send email** (each can be switched off in the email settings):
  - Ticket created, to the contact ("we received your request" with the ticket number).
  - Public comment added, to the contact and CCs.
  - Status changed to resolved, to the contact.
  - Assignment, to the technician.
- **Subjects** carry `[#1042]`. A `Reply-To` address of the form `support+t1042.<hmac>@domain`
  makes replies thread back to the right ticket.
- **Inbound (IMAP).**
  - Polls every 60 s (IMAPS, or STARTTLS on 143).
  - The mailbox and folder are configurable. Processed mail moves to a `Processed` folder.
  - **Threading.** Replies are matched by the `t<number>.<hmac>` tag in the recipient address, with
    `[#number]` in the subject plus a known sender as fallback. A matched reply becomes a public
    comment from the contact. Quoted history is stripped below standard reply markers.
  - **New tickets.** Mail from a known contact creates a new ticket for that contact's client. Mail
    from an unknown sender either goes to an "Unassigned client" holding queue or is dropped,
    depending on the settings. Unknown senders are never auto-created as contacts.
  - **Size limits.** Messages over 25 MiB are skipped. Attachments are saved like comment
    attachments.
  - **Loop protection.** Mail from the server's own from-address is ignored, as is mail carrying
    `Auto-Submitted: auto-*`.
- **Settings.** Read with `GET /settings/ticket-email`, write with `PUT` (`tickets.settings`, plus a
  step-up for `PUT`):

  ```jsonc
  { "outbound": { "enabled": true, "notify_contact_on_create": true, "notify_on_public_comment": true, "notify_on_resolve": true, "notify_technician_on_assign": true, "reply_address": "support@example.com" },
    "inbound": { "enabled": false, "host": "", "port": 993, "security": "tls" | "starttls", "username": "", "password": "••••••", "folder": "INBOX", "processed_folder": "Processed", "unknown_sender": "holding_queue" | "drop" },
    "signature": "…markdown…" }
  ```

- **Test.** `POST /settings/ticket-email/test-imap` tries an IMAP login and returns `{ ok, error? }`.

Outbound details:

- **Recipients and queueing.**
  - Contact mail goes only to contacts with `notify: true` and an address; the CCs come from the
    ticket's `cc`.
  - The server's own addresses are never recipients, and nothing is queued while SMTP is not
    configured.
  - Mail is queued in `ticket_email_outbox` and sent by a worker, retried after 30 s, 2 min,
    10 min and 1 h. After the fifth failure the message is marked `failed` and the ticket gets
    the activity `email_failed`.
- **Reply address.**
  - `reply_address` is the base address; when empty, the SMTP sender is used. It must not
    contain `+`.
  - The tag is `t<number>.<first 12 hex characters of HMAC-SHA256>` over `ticket-reply/<number>`,
    keyed with a key derived from the master key. It is compared case-insensitively.
  - Assignment mail to technicians carries no reply tag.
- **Message.**
  - Customer mail starts with the line `##- Please type your reply above this line -##`.
  - It continues with the body (Markdown rendered to sanitised HTML, plus the plain Markdown
    as text), the signature (placeholders filled) and `Ticket #1042: <subject>`.
  - The "created" mail repeats the subject and description; the "resolved" mail explains that a
    reply reopens the ticket.
- **Headers and attachments.**
  - `Message-ID` is `ticket-<number>-<uuid>@<sender domain>`. Every message carries
    `In-Reply-To`/`References` with the ticket's first known message id, so mail clients thread
    it.
  - Public-comment attachments are attached when they add up to at most 10 MiB; otherwise their
    names are listed.

Inbound details:

- **Connection.**
  - `security` may also be `none`, but only for a mail server on this host (loopback); a remote
    host answers `422`.
  - The client uses AUTHENTICATE PLAIN when offered, otherwise LOGIN, and never sends a password
    in clear text to a remote host. It falls back to COPY + `\Deleted` + EXPUNGE without the
    MOVE extension, and creates the processed folder when missing.
  - Folder names are ASCII without quotes.
- **Polling.** Each poll handles up to 50 messages in `folder`, oldest UID first. Every handled
  message moves to `processed_folder`, including skipped and failed ones.
- **Dedupe.** `processed_emails` holds one row per `Message-ID` (or content hash) with
  `outcome`: `comment`, `ticket`, `ignored`, `dropped`, `too_large` or `failed`. A message seen
  before is not processed again.
- **Loop protection** also ignores mail from the reply address, the IMAP user name and any
  `+tag` variant of them.
- **Threading.**
  - Recipients are read from `To`, `Cc`, `Delivered-To`, `X-Original-To` and `Envelope-To`.
  - After the tag, `In-Reply-To`/`References` are matched against the message ids in
    `email_threads` (inbound and outbound).
  - The subject fallback needs a sender who is the ticket's contact, one of its CCs, or a
    contact of its client.
  - A reply to a merged ticket goes to the surviving ticket.
- **Quote stripping** is conservative.
  - The body is cut at the reply marker, `On … wrote:` (also wrapped onto two lines, and the
    German, French, Spanish and Dutch forms), `-----Original Message-----`, an Outlook
    `____` separator followed by `From:`, or a `From:`/`Sent:`/`To:` header block.
  - Trailing `>` quotes are dropped; inline answers are kept. When nothing would remain the
    whole text is kept.
- **New tickets from mail.**
  - The sender's contact is the primary match first, then the oldest when an address exists in
    several clients.
  - The queue is the one whose `email_address` is a recipient, otherwise Support.
  - The ticket's `cc` takes the mail's CCs (except the server's own addresses), and the
    description is the full body (not stripped).
- **Unknown senders** with `holding_queue` get a ticket in the client "Unassigned e-mail"
  (`builtin-unassigned-email`) and the queue "Unassigned e-mail" (`builtin-holding-queue`).
  Both are created on first use; the description starts with `From: Name <address>`.
  Technicians move such tickets with `PATCH { client_id, contact_id }`.
- **Attachments** follow the comment rules (25 MiB each, at most 20). Refused files are named
  in the comment. A new ticket's attachments go on a first public system comment.
- **Settings.**
  - `GET` (and the `PUT` response) also returns
    `inbound_status: { last_poll_at, last_error, last_processed }`. `port` defaults to 993 for
    `tls` and 143 otherwise.
  - Enabling polling needs `host` and `username`. The password is field-encrypted (AAD
    `settings/ticket_email/imap_password`); omitting it or sending `"••••••"` keeps it, and
    `null` or `""` clears it.
  - `GET`, `PUT` and the test need a global `tickets.settings`.
- **Test.** `test-imap` signs in and selects the folder. It takes the saved settings, or an
  optional body `{ inbound: { … } }` to test unsaved values (a placeholder password uses the
  saved one), and answers `409 imap_not_configured` without a host or user.

## Alert-to-ticket rules

```jsonc
{ "id", "name", "enabled": true,
  "filters": { "client_ids": [], "severities": ["critical"], "check_types": [], "sources": [] },
  "after_minutes": 10,              // only when the alert is still open and unacknowledged after N minutes (0 = immediately)
  "ticket": { "queue_id", "priority": "high", "assignee_id"? },
  "close_ticket_on_resolve": false }
```

Routes are a full CRUD set at `/alert-ticket-rules` (`tickets.settings`). A created ticket links
the alert: the alert's `ticket_id` is set, and an alert event of kind `ticket_created` is recorded.
At most one ticket is created per alert. A manual "Create ticket" action on an alert
(`POST /alerts/{id}/ticket`, `tickets.manage`) creates a ticket prefilled from the alert.

Details:

- **Rule objects.** Rules carry `created_at` and `updated_at`. `ticket.priority` defaults to
  `high` and `queue_id` to Support.
  - Every non-empty filter list must contain the alert's value. `severities` may hold `info`,
    `warning` and `critical`; `sources` may hold `check` and `server`.
  - `after_minutes` is 0–10080. The CRUD shape is the one described for queues.
- **Evaluation.**
  - Rules with `after_minutes: 0` run when an alert opens or reopens; delayed rules run every
    30 s.
  - The alert must be `open` (not acknowledged), have no ticket and not be in maintenance.
    Delayed rules only consider alerts opened after the rule was created.
  - The oldest matching rule wins.
  - The alert is claimed atomically before the ticket is created, so concurrent rules and
    clicks never create a second ticket.
- **The created ticket.**
  - Subject: `<alert title> (<hostname>)`. Description: the message and a fact table.
  - `type` and `source` are `alert`; the device and the alert are linked; the creator is
    `System`.
  - The alert event `ticket_created` carries `{ ticket_id, number, rule_id }`.
- **`close_ticket_on_resolve`.** When the alert resolves (automatically or manually) the
  ticket gets an internal system note and its status becomes `resolved`, if it is still active.
- **Manual ticket.**
  - Optional body `{ subject?, description?, priority?, queue_id?, assignee_id? }` overrides
    the prefill. Without a `priority`, the alert severity maps critical → high, warning →
    normal and info → low.
  - Returns `201` with the Ticket. An alert that already has a ticket answers
    `409 ticket_exists` with `details.ticket_id`.
  - The alert must be visible with `alerts.view` or `tickets.view`, and `tickets.manage` is
    needed over its client or site.

## Agent "Request support"

- **Endpoint.** `POST /agent/v1/support-request` on the agent listener.
- **Authentication.** The device signs the request with its key: the header
  `X-RustRMM-Device: <device_id>`, the header `X-RustRMM-Signature: <ed25519 over "rustrmm/v1/support" ‖ body>`,
  and a timestamp in the body that must be within 5 minutes.
- **Body.**

  ```jsonc
  { "user": "CORP\\alex", "name": "Alex Doe", "email": "alex@example.com" | null,
    "subject": "…", "description": "…", "screenshot_jpeg_b64": "…" | null, "timestamp": 1794…, "nonce": "…" }
  ```

- **Result.** A ticket in the device's client, with source `agent`, the device linked, and the
  screenshot attached. The contact is matched by email, or by the user name in contact notes.
  The endpoint is rate limited to 5 requests per device per hour.
- **Agent command.** `rustrmm-agent support` opens a minimal native dialog in the user's session:
  - On Windows, a small window run by the desktop helper from Phase 8, or a PowerShell WinForms
    dialog launched in the user session as a fallback.
  - On Linux, `zenity` if present.
  - On macOS, `osascript`.

  The dialog collects the subject and description and lets the user attach a screenshot. The agent
  then sends the request through the service. A tray icon is optional and comes later.

Endpoint details (shared definitions in `rustrmm_proto::support`):

- **Signature and timestamp.**
  - The signature covers the bytes `rustrmm/v1/support` followed by the exact request body.
  - It is sent as base64url without padding; standard base64 and padding are also accepted.
  - The signing device must be `active`.
  - `timestamp` is unix **seconds**, accepted within ±300 s of the server clock.
- **Nonce.** `nonce` is 16–128 URL-safe characters (the agent sends 22). Each (device, nonce)
  pair is accepted once; nonces are remembered for 10 minutes in `support_nonces`, so replays
  are refused across restarts too.
- **Order of checks and answers.**
  1. A body over 8 MiB: `413 too_large`.
  2. A missing or unknown device, a bad signature or a device that is not active:
     `401 unauthenticated`.
  3. An invalid body: `400 bad_request`.
  4. A timestamp outside the window: `401 stale_request`.
  5. A replayed nonce: `409 replayed`.
  6. Over the rate limit: `429 rate_limited` (only authenticated, fresh requests count).
- **Success** answers `201 { ticket_id, number }`.
- **Content.**
  - `subject` is at most 200 characters; an empty subject becomes `Support request from <name>`.
  - `description` is at most 20 000 characters; the ticket description ends with
    `Submitted from **<hostname>** by <name> (<user>) <email>`.
  - The screenshot must be a JPEG of at most 5 MiB. It is attached as `screenshot.jpg` to a
    first public comment from the requester.
  - The ticket is in the device's site, `type: incident`, with the Support queue's default
    priority.
  - A known contact receives the "created" mail. Addresses that match no contact are recorded
    in the description, never mailed.
  - The device timeline records `ticket.created`.
- **Agent command details.**
  - The command runs as the signed-in user. Before the dialog opens it captures the screen with
    the Phase 8 capture code (Windows DXGI/GDI and Linux X11 in-process; macOS `screencapture`,
    downscaled with `sips`) at up to 1280 px.
  - The Windows dialog is the PowerShell WinForms form, run in the user's own session (the
    command already runs there, so the desktop helper is not needed). Linux uses three `zenity`
    dialogs (subject and e-mail, description, screenshot); macOS uses `osascript` prompts. A
    result message follows (MessageBox, `zenity --info`, `display dialog`).
  - An empty subject takes the first line of the description.
- **Delivery.**
  - When the process can read the device key (elevated, or a development `--data-dir`) it signs
    and posts directly, trying each server URL.
  - Otherwise it hands the request to the running service over a local channel. On Windows
    that is the named pipe `\\.\pipe\rustrmm-support`: SYSTEM and Administrators get full
    access, interactive users read and write without the right to create instances, the client
    checks that the server runs in session 0, and remote clients are rejected. Elsewhere it is
    the socket `/run/rustrmm-agent/support.sock` (macOS: `/var/run/rustrmm-agent-support.sock`).
  - The service takes `user` from the operating system (the pipe client's token, or the socket
    peer credentials), never from the client, and allows five relayed requests per user per
    hour before signing and posting.
  - In development (`--data-dir`) the channel lives next to the data directory and is limited to
    the current user.
- **Testing.** The hidden options
  `support --no-dialog --subject … --description … [--email …] [--screenshot]` skip the dialog.
  `rustrmm-agent selftest` includes a `support` check, a round trip over a temporary local
  channel.

## Events, audit and data model

- **Events:**
  - `ticket.created` with `{ ticket }`.
  - `ticket.updated` with `{ ticket_id, changes }`.
  - `ticket.comment` with `{ ticket_id, comment_id, visibility }`.
  - `tickets.counts`, throttled.
- **Audit:** `ticket.deleted` (only `tickets.settings` can delete), `ticket.merged`,
  `ticket_settings.*` and `contact.imported`. Ordinary ticket edits are recorded in the ticket
  activity, not the audit log.
- **Data model:** migration `0009_tickets.sql` adds these tables:
  - `tickets`, with a number sequence in `settings` or its own table;
  - `ticket_comments`, `ticket_attachments` (blob store) and `ticket_activity`;
  - `ticket_links`, `ticket_queues`, `sla_policies`, `canned_responses`;
  - `contacts`, `time_entries`;
  - `alert_ticket_rules`;
  - `email_threads` (Message-ID mapping) and `processed_emails` (dedupe by Message-ID).

Details:

- **Event payloads.**
  - `changes` maps each field to `{ from, to }` (raw values; ids for references; `description`
    carries `null`s).
  - Other keys mark non-field changes: `sla_breached`, `links`, `merged_from`, `time_entries`
    and `deleted`.
  - `ticket.comment` is also published when a comment is edited.
  - `tickets.counts` is
    `{ client_id, new, open, pending, on_hold, unassigned, breached, total }` for one client,
    at most once per 2 s per client (a trailing event carries the latest numbers).
  - Every event carries the ticket's client, so subscribers only receive tickets they may see.
- **`fleet.summary`.** Count changes also publish the data-less `fleet.summary`.
  `GET /fleet/summary` fills `open_tickets` with the active tickets (`new`, `open`, `pending`,
  `on_hold`) visible with `tickets.view`, honouring `client_id`/`site_id`.
- **Audit actions:** `ticket.deleted`, `ticket.merged`, `contact.imported`,
  `ticket_settings.queue_created|queue_updated|queue_deleted`,
  `ticket_settings.sla_created|sla_updated|sla_deleted`,
  `ticket_settings.canned_created|canned_updated|canned_deleted` (shared responses only),
  `ticket_settings.alert_rule_created|alert_rule_updated|alert_rule_deleted`,
  `ticket_settings.email_updated` (the IMAP password never; `password_changed` instead) and
  `ticket_settings.imap_tested`.
- **Alerts.** Alerts gain the event kind `ticket_created`, and `alert.updated` is published when
  a ticket is linked. The alert `ticket_id` column already existed (Phase 6).
- **Further tables in `0009_tickets.sql`:**

  | Table | Holds |
  |---|---|
  | `ticket_sequence` | the number sequence (one row) |
  | `ticket_email_outbox` | queued outbound ticket mail and its retry state |
  | `support_nonces` | accepted support-request nonces until they expire |

  Housekeeping (hourly) drops expired nonces, dedupe rows older than 90 days and finished
  outbox rows older than 30 days.
- **Blobs.** Attachments use the content-addressed store `<data dir>/files/<sha256>` shared with
  Phase 7 uploads. The default queue and SLA policy are seeded idempotently at start-up.
