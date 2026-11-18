/*
 * Deterministic Phase 9 demo data, coherent with the seeded clients, sites, devices, users and alerts:
 * contacts per client, queues, SLA policies (24x7 default, Pacific business hours, a premium tier),
 * canned responses, alert-to-ticket rules, e-mail settings and about 80 tickets across every status,
 * priority and source (console, e-mail, alert rules and agent "Request support" with a screenshot),
 * each with a conversation, activity history and time entries.
 */
import type { Client, Site, SlaPolicy, TicketComment, TicketPriority, TicketSource, TicketStatus, TicketType, User } from '@/lib/api/types'
import { firstName } from '@/lib/tickets/labels'
import { rng, type MockDevice } from './devices'
import { addEvent, type MockAlert, type MockMonitoring } from './monitoring-model'
import {
  applyStatusClock,
  computeSla,
  defaultSlaPolicy,
  emptyTickets,
  record,
  SUPPORT_QUEUE_ID,
  type MockContact,
  type MockTicket,
  type MockTickets,
} from './tickets-state'

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000
const iso = (ms: number) => new Date(ms).toISOString()

interface SeedInput {
  clients: Client[]
  sites: Site[]
  devices: MockDevice[]
  users: User[]
  monitoring: MockMonitoring
  now: number
}

// ------------------------------------------------------------------ contacts

const CONTACT_SEED: { domain: string; people: [string, string, number, string?][] }[] = [
  {
    domain: 'northwind-dental.example',
    people: [
      ['Priya Sandoval', 'Practice manager', 0],
      ['Jamie Lopez', 'Front desk lead', 0, 'NWD\\jlopez'],
      ['Maya Khan', 'Receptionist', 0, 'NWD\\mkhan'],
      ['Dr. Helen Chen', 'Practice owner', 0, 'NWD\\dr.chen'],
      ['Rohan Patel', 'Front desk', 1, 'NWD\\rpatel'],
    ],
  },
  {
    domain: 'harborpine.example',
    people: [
      ['Dana Reyes', 'Office manager', 0],
      ['Marcus Whitfield', 'Managing partner', 0],
      ['Elena Brooks', 'Paralegal', 0],
      ['Tom Okafor', 'Records clerk', 1],
    ],
  },
  {
    domain: 'summitfreight.example',
    people: [
      ['Gary Holt', 'Operations manager', 0],
      ['Lucia Fernandez', 'Dispatch coordinator', 0],
      ['Ken Watanabe', 'Warehouse supervisor', 1],
      ['Bree Collins', 'Accounts payable', 0],
      ['Andre Silva', 'Depot lead', 2],
    ],
  },
  {
    domain: 'bluebirdbakery.example',
    people: [
      ['Nora Bell', 'Owner', 0],
      ['Felix Grant', 'Shift lead', 1],
    ],
  },
  {
    domain: 'cedarridgevet.example',
    people: [
      ['Dr. Sofia Marin', 'Medical director', 0],
      ['Ian Price', 'Practice manager', 0],
      ['Kayla Ng', 'Veterinary technician', 1],
    ],
  },
  {
    domain: 'atlas-arch.example',
    people: [
      ['Oliver Stein', 'Studio director', 0],
      ['Hana Sato', 'Project architect', 0],
      ['Raj Mehta', 'IT liaison', 1],
    ],
  },
  {
    domain: 'meridiancu.example',
    people: [
      ['Carla Diaz', 'VP operations', 0],
      ['Ben Foster', 'Branch manager', 1],
      ['Alicia Moore', 'Compliance officer', 0],
      ['Victor Lin', 'Teller supervisor', 2],
    ],
  },
  {
    domain: 'oakline.example',
    people: [
      ['Grace Kim', 'Executive director', 0],
      ['Peter Novak', 'Learning center coordinator', 1],
    ],
  },
]

// ------------------------------------------------------------------ ticket templates

interface Template {
  subject: string
  body: string
  type: TicketType
  priority: TicketPriority
  tags: string[]
  /** Index into the seeded clients, or -1 for "any". */
  client: number
  source: 'email' | 'console'
  /** The technician's fix, used for resolved tickets. */
  fix: string
  /** What a pending ticket waits for. */
  ask: string
  note?: string
  reply?: string
  queue?: 'network' | 'onboarding' | 'projects'
  device?: boolean
}

const T: Template[] = [
  {
    subject: 'Printer offline in reception',
    body: 'Hi,\n\nThe reception printer shows **offline** on both front desk PCs since this morning. Power cycling it did not help.\n\nThanks',
    type: 'incident', priority: 'high', tags: ['printers'], client: -1, source: 'email', device: true,
    fix: 'The printer had picked up a new DHCP address after the router reboot last night. I reserved its address and re-added the port on both PCs; test pages printed fine.',
    ask: 'Could you read me the IP address from the printer’s network status page (Menu → Network → Status)?',
    note: 'Router at this site rebooted at 02:10 (firmware auto-update). Printer is on DHCP, not reserved.',
    reply: 'Thanks, both PCs print again!',
  },
  {
    subject: 'Outlook keeps asking for my password',
    body: 'Outlook pops up a password prompt every few minutes. I type my password and it comes back again. Webmail works fine.',
    type: 'incident', priority: 'normal', tags: ['email', 'm365'], client: -1, source: 'email', device: true,
    fix: 'Cleared the stale credentials from Windows Credential Manager and re-created the Outlook profile. Modern authentication now signs in silently.',
    ask: 'Does the prompt mention “Microsoft 365” or the old server name? A screenshot of it would help.',
    reply: 'It says outlook.office365.com. Screenshot attached in my next email.',
  },
  {
    subject: 'New starter: laptop and accounts for Monday',
    body: 'We have a new team member starting **Monday 9am**.\n\n- Laptop (same as the others)\n- Email and Teams\n- Access to the shared drive and the practice system\n\nPlease let me know if you need anything else.',
    type: 'request', priority: 'normal', tags: ['onboarding'], client: -1, source: 'email', queue: 'onboarding',
    fix: 'Laptop imaged and enrolled, accounts created with MFA set up on first sign-in. Credentials handed to the manager in person.',
    ask: 'Which department and manager should the new account sit under, and do they need a desk phone?',
    note: 'Use the standard onboarding checklist. Licence pool has 2 spare Business Premium seats.',
  },
  {
    subject: 'VPN disconnects every 10 minutes',
    body: 'Working from home today and the VPN drops roughly every ten minutes. I have to reconnect each time and lose my session in the line-of-business app.',
    type: 'incident', priority: 'high', tags: ['vpn', 'remote-work'], client: -1, source: 'console', queue: 'network', device: true,
    fix: 'The client was on a captive-portal Wi-Fi that renegotiates DHCP every 10 minutes. Switched the VPN to TCP 443 with keepalives; stable for two hours of testing.',
    ask: 'Are you on home Wi-Fi or a hotspot? Please run the speed test linked below and send the result.',
    note: 'Firewall logs show IKE re-keys failing from a CGNAT address.',
  },
  {
    subject: 'Cannot open the shared drive (S:)',
    body: 'The S: drive shows a red X and says the network path was not found. Other people in the office can open it.',
    type: 'incident', priority: 'normal', tags: ['file-share'], client: -1, source: 'email', device: true,
    fix: 'The PC had lost its trust relationship with the domain. Re-joined it and remapped the drive through the logon policy.',
    ask: 'Can you try restarting the PC while connected to the office network and let me know if S: comes back?',
  },
  {
    subject: 'Please install Adobe Acrobat Pro',
    body: 'I need Acrobat Pro to edit and sign PDFs for clients. My manager approved it.',
    type: 'request', priority: 'low', tags: ['software'], client: -1, source: 'console', device: true,
    fix: 'Acrobat Pro deployed from the software library and the licence assigned.',
    ask: 'Could your manager reply to confirm the licence approval?',
  },
  {
    subject: 'Scanner no longer emails scans',
    body: 'Scan-to-email on the copier stopped working yesterday. It shows “SMTP authentication failed”.',
    type: 'incident', priority: 'normal', tags: ['printers', 'email'], client: -1, source: 'email',
    fix: 'The copier used basic SMTP auth, which Microsoft switched off. Moved it to the SMTP relay connector with an IP restriction.',
    ask: 'Is the copier the Ricoh in the hallway or the one in the back office?',
    note: 'Basic auth retirement for SMTP AUTH went live for this tenant on Monday.',
  },
  {
    subject: 'Wi-Fi is very slow in the back office',
    body: 'Since last week the Wi-Fi in the back office crawls. Video calls freeze and uploads take forever.',
    type: 'incident', priority: 'normal', tags: ['wifi', 'network'], client: -1, source: 'console', queue: 'network',
    fix: 'The back-office access point had fallen back to 2.4 GHz after a channel conflict. Pinned it to 5 GHz channel 44 and adjusted transmit power.',
    ask: 'Roughly what time of day is it worst? I would like to capture a survey during that window.',
  },
  {
    subject: 'Leaver: disable account for departing employee',
    body: 'A colleague leaves on Friday at 5pm. Please disable their access after that and forward their email to their manager for 30 days.',
    type: 'request', priority: 'normal', tags: ['offboarding'], client: -1, source: 'email', queue: 'onboarding',
    fix: 'Account blocked at 17:00 Friday, sessions revoked, mailbox converted to shared with the manager delegated, laptop collected.',
    ask: 'Should their OneDrive files go to the manager as well?',
  },
  {
    subject: 'Laptop screen flickers',
    body: 'My laptop screen flickers and sometimes goes black for a second, especially when I move the lid.',
    type: 'incident', priority: 'low', tags: ['hardware'], client: -1, source: 'console', device: true,
    fix: 'Display cable replaced under warranty by the vendor’s on-site engineer.',
    ask: 'Does it also flicker on an external monitor?',
    note: 'Warranty valid until next March. Vendor case logged.',
  },
  {
    subject: 'Teams does not detect my camera',
    body: 'Teams says no camera found. The camera light never turns on. It worked last week.',
    type: 'incident', priority: 'normal', tags: ['teams'], client: -1, source: 'email', device: true,
    fix: 'The camera was disabled by the privacy setting after the feature update. Re-enabled camera access for desktop apps.',
    ask: 'Does the Windows Camera app see it?',
  },
  {
    subject: 'Password reset and MFA re-registration',
    body: 'I got a new phone and the authenticator app no longer has my account, so I cannot sign in.',
    type: 'request', priority: 'high', tags: ['mfa', 'accounts'], client: -1, source: 'console',
    fix: 'Identity verified by callback to the number on file, MFA methods reset, user re-registered the authenticator.',
    ask: 'For verification, please call us from your desk phone so we can confirm it is you.',
  },
  {
    subject: 'Suspicious email: “Invoice overdue — action required”',
    body: 'I got an email asking me to log in to view an overdue invoice. The sender looks odd. I did **not** click the link.',
    type: 'incident', priority: 'high', tags: ['security', 'phishing'], client: -1, source: 'email',
    fix: 'Confirmed phishing. Purged the message from all mailboxes, blocked the sender domain and the URL, no clicks found in the logs.',
    ask: 'Please forward the original message as an attachment so we can see the headers.',
    note: 'Same campaign hit two other clients this week. Domain registered 3 days ago.',
  },
  {
    subject: 'Second monitor for the front desk',
    body: 'Could we get a second monitor for the front desk? The scheduling screen and the phone app do not fit on one.',
    type: 'request', priority: 'low', tags: ['hardware'], client: -1, source: 'email',
    fix: '24" monitor and cable delivered and set up.',
    ask: 'Is there a spare power outlet at the desk, or should we bring an extension?',
  },
  {
    subject: 'Change: firewall rule for new payroll vendor',
    body: 'Our new payroll provider needs outbound access to their SFTP endpoint. Details from the vendor are below.\n\n| Host | Port |\n|---|---|\n| sftp.payroll-vendor.example | 22 |',
    type: 'change', priority: 'normal', tags: ['firewall', 'change'], client: -1, source: 'console', queue: 'network',
    fix: 'Rule added for the vendor’s published range, scheduled in the Tuesday change window and tested with the vendor.',
    ask: 'Can the vendor confirm the source IP ranges they will connect from?',
    note: 'CAB approved. Roll back by disabling rule 4012.',
  },
  {
    subject: 'Backup job failed on the file server',
    body: 'Last night’s backup report shows **Failed** for the file server.',
    type: 'incident', priority: 'high', tags: ['backup'], client: -1, source: 'console', device: true,
    fix: 'The backup target was out of space after the retention change. Pruned old restore points and re-ran the job successfully.',
    ask: 'Did anyone change the NAS shares this week?',
  },
  {
    subject: 'Dental imaging software will not open',
    body: 'The imaging software on the X-ray workstation crashes on start with a database error. We have patients booked for X-rays this afternoon.',
    type: 'incident', priority: 'urgent', tags: ['imaging', 'line-of-business'], client: 0, source: 'email', device: true,
    fix: 'The imaging database service had stopped after Windows updates. Restarted it, set it to delayed start and confirmed images load.',
    ask: 'Can you tell me the exact error code from the dialog?',
    note: 'Vendor support line: option 2, reference our partner ID.',
    reply: 'It is working again, thank you so much!',
  },
  {
    subject: 'Practice management system very slow at check-in',
    body: 'Checking patients in takes ages. Every screen in the practice system takes 10–15 seconds to load.',
    type: 'problem', priority: 'high', tags: ['line-of-business', 'performance'], client: 0, source: 'email',
    fix: 'Database index maintenance had been failing silently. Rebuilt indexes and scheduled the vendor maintenance job weekly.',
    ask: 'Is it slow for everyone or mostly at the front desk?',
  },
  {
    subject: 'Court e-filing portal shows a certificate error',
    body: 'The e-filing portal says our client certificate is not trusted. We have a filing deadline at 4pm.',
    type: 'incident', priority: 'urgent', tags: ['certificates'], client: 1, source: 'email', device: true,
    fix: 'The firm’s client certificate had expired. Installed the renewed certificate on the paralegal workstations; filing submitted at 15:20.',
    ask: 'Do you have the renewal email from the certificate authority?',
  },
  {
    subject: 'Document management search returns nothing',
    body: 'Searching in the document management system returns no results, even for documents I opened today.',
    type: 'incident', priority: 'high', tags: ['line-of-business'], client: 1, source: 'console',
    fix: 'The search index service had crashed. Rebuilt the index overnight; search works again.',
    ask: 'Does searching by matter number work, or nothing at all?',
  },
  {
    subject: 'Handheld scanners at Dock 4 not syncing',
    body: 'None of the handheld scanners at Dock 4 are syncing to the warehouse system. Pickers are writing on paper.',
    type: 'incident', priority: 'urgent', tags: ['warehouse', 'wifi'], client: 2, source: 'email', queue: 'network',
    fix: 'The Dock 4 access point lost its PoE after a switch port error-disabled. Re-enabled the port and added it to monitoring.',
    ask: 'Are the scanners showing Wi-Fi bars at all?',
    note: 'Switch DOCK4-SW2 port Gi1/0/14 err-disabled (PoE overload).',
  },
  {
    subject: 'Label printer at Reno Depot prints blank labels',
    body: 'The Zebra label printer prints blank labels. Ribbon looks fine.',
    type: 'incident', priority: 'normal', tags: ['printers', 'warehouse'], client: 2, source: 'console',
    fix: 'Media type was switched to thermal transfer after a reset. Set it back to direct thermal and recalibrated.',
    ask: 'Can you print a configuration label (hold feed for two flashes) and send a photo?',
  },
  {
    subject: 'POS terminal offline at Pearl St',
    body: 'The till at the Pearl St shop says offline and cannot take card payments. We are on cash only.',
    type: 'incident', priority: 'urgent', tags: ['pos', 'network'], client: 3, source: 'email', queue: 'network',
    fix: 'The shop router had rebooted into failover mode. Restored the primary WAN and the POS reconnected.',
    ask: 'Are the lights on the router green or orange?',
    reply: 'Cards are working again, thanks for the quick help.',
  },
  {
    subject: 'X-ray workstation disk almost full',
    body: 'The X-ray PC warns that the disk is almost full.',
    type: 'incident', priority: 'high', tags: ['imaging', 'storage'], client: 4, source: 'console', device: true,
    fix: 'Moved images older than 12 months to the archive share and enabled automatic archiving.',
    ask: 'Can we archive images older than a year to the server?',
  },
  {
    subject: 'Plotter queue stuck',
    body: 'Plot jobs to the large-format plotter sit in the queue and never print.',
    type: 'incident', priority: 'normal', tags: ['printers'], client: 5, source: 'email',
    fix: 'A corrupt job was blocking the spooler. Cleared the queue and updated the plotter driver.',
    ask: 'Which drawing were you plotting when it got stuck?',
  },
  {
    subject: 'Revit cannot reach the licence server',
    body: 'Revit says it cannot reach the licence server for everyone working from home.',
    type: 'incident', priority: 'high', tags: ['licensing', 'vpn'], client: 5, source: 'console', queue: 'network',
    fix: 'The licence server’s firewall rule only allowed the office subnet. Added the VPN pool.',
    ask: 'Are people in the studio affected too, or only remote staff?',
  },
  {
    subject: 'Teller workstation locked out at Midtown branch',
    body: 'A teller workstation at Midtown is locked and the teller cannot sign in. Branch opens in 30 minutes.',
    type: 'incident', priority: 'urgent', tags: ['accounts', 'branch'], client: 6, source: 'email',
    fix: 'Account locked by repeated failed sign-ins from a stale mapped drive credential. Unlocked and removed the old credential.',
    ask: 'Did the teller change their password recently?',
    note: 'Compliance requires a note in the branch incident log. Done.',
  },
  {
    subject: 'Request: core banking client update in Thursday window',
    body: 'The core banking vendor released a client update. Please schedule it for Thursday evening after close.',
    type: 'change', priority: 'normal', tags: ['change', 'line-of-business'], client: 6, source: 'console', queue: 'projects',
    fix: 'Update deployed to all branches Thursday 19:00–19:40; smoke tests passed at each branch.',
    ask: 'Can the vendor provide the silent-install switches for this version?',
  },
  {
    subject: 'Chromebook cart not charging',
    body: 'Half of the Chromebooks in the learning center cart did not charge overnight.',
    type: 'incident', priority: 'low', tags: ['hardware'], client: 7, source: 'email',
    fix: 'One of the cart’s power strips had tripped. Reset it and labelled the circuit.',
    ask: 'Is the cart plugged into the wall outlet or an extension?',
  },
  {
    subject: 'Guest Wi-Fi for the donor event',
    body: 'We have a donor event next Thursday with about 60 guests. Can we have a guest Wi-Fi with a simple password for the evening?',
    type: 'request', priority: 'normal', tags: ['wifi', 'event'], client: 7, source: 'email', queue: 'network',
    fix: 'Guest SSID enabled with a one-day voucher and client isolation; disabled automatically after the event.',
    ask: 'What time does the event start and end?',
  },
  {
    subject: 'Problem: recurring blue screens on OptiPlex 7010s',
    body: 'Several OptiPlex 7010s have blue-screened this month with `DRIVER_POWER_STATE_FAILURE`. Opening a problem record to find the root cause.',
    type: 'problem', priority: 'high', tags: ['hardware', 'bsod'], client: -1, source: 'console', device: true,
    fix: 'Root cause: the Intel network driver 12.19. Pinned 12.18 via policy and the vendor fixed it in 12.20.',
    ask: 'Has anyone seen it on the newer models?',
    note: 'Dumps attached to the vendor case. Same driver version on every affected device.',
  },
  {
    subject: 'Mailbox almost full',
    body: 'Outlook says my mailbox is almost full and I cannot send attachments.',
    type: 'request', priority: 'low', tags: ['email', 'm365'], client: -1, source: 'email',
    fix: 'Enabled the online archive with a two-year retention policy; mailbox down to 41%.',
    ask: 'Are you happy for email older than two years to move to the archive automatically?',
  },
]

const AGENT_REQUESTS: { subject: string; body: string }[] = [
  { subject: 'My computer is really slow', body: 'Everything takes forever to open since this morning, even the start menu.' },
  { subject: 'Cannot print to the front desk printer', body: 'I get “Error – printing” every time I print a receipt.' },
  { subject: '', body: 'The scanning software says the scanner is not connected.\nIt was fine yesterday.' },
  { subject: 'Error when opening the shared calendar', body: 'Outlook shows an error when I open the team calendar.' },
  { subject: 'Screen keeps going black', body: 'My second monitor goes black every few minutes.' },
  { subject: 'Pop-up asking to restart for updates', body: 'A window keeps asking me to restart. Is it safe to do it now? I have a patient in 10 minutes.' },
  { subject: 'Keyboard typing wrong characters', body: 'When I type @ I get " instead. Started after the update.' },
  { subject: 'Cannot connect to the practice system', body: 'The practice system says “Server not found”.' },
]

// ------------------------------------------------------------------ helpers

interface Spec {
  template: Template | null
  subject: string
  description: string
  client: Client
  site: Site | null
  contact: MockContact | null
  status: TicketStatus
  priority: TicketPriority
  type: TicketType
  source: TicketSource
  queueId: string
  assignee: User | null
  tags: string[]
  devices: MockDevice[]
  alert: MockAlert | null
  createdAt: number
  createdBy: string
  agent?: { device: MockDevice; requester: string; email: string | null; user: string }
}

function fill(text: string, values: Record<string, string>) {
  return text.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match)
}

function signoff(tech: User) {
  return `\n\nBest,\n${tech.name}\nLumen IT Partners`
}

export function seedTickets(input: SeedInput): MockTickets {
  const { clients, sites, devices, users, monitoring, now } = input
  const r = rng(20261122)
  const id = () => {
    const hex = r.hex(32)
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-d${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  }
  const state = emptyTickets()
  const createdBase = iso(now - 200 * DAY)
  state.queues[0].created_at = createdBase
  state.queues[0].updated_at = createdBase
  state.sla = [defaultSlaPolicy(createdBase)]

  const byName = (name: string) => users.find((user) => user.name === name)!
  const avery = byName('Avery Chen')
  const sam = byName('Sam Rivera')
  const morgan = byName('Morgan Lee')
  const jordan = byName('Jordan Patel')
  const riley = byName('Riley Brooks')
  const drew = byName('Drew Alvarez')
  const techs = [avery, sam, morgan, sam, avery, jordan]

  // Queues.
  const queue = (name: string, description: string, priority: TicketPriority, assignee: User | null, email: string | null, age: number) => {
    const at = iso(now - age * DAY)
    const value = { id: id(), name, description, default_priority: priority, default_assignee_id: assignee?.id ?? null, email_address: email, builtin: false, created_at: at, updated_at: at }
    state.queues.push(value)
    return value
  }
  state.queues[0].email_address = 'support@lumen-it.example'
  const network = queue('Network & infrastructure', 'Connectivity, Wi-Fi, firewalls, VPN and servers.', 'high', sam, 'network@lumen-it.example', 180)
  const onboarding = queue('Onboarding & offboarding', 'Starters, leavers and access changes.', 'normal', morgan, 'people@lumen-it.example', 170)
  const projects = queue('Projects & changes', 'Planned changes, upgrades and scheduled work.', 'low', jordan, null, 160)
  const noc = queue('NOC alerts', 'Tickets opened from monitoring alerts.', 'high', null, null, 150)
  const queueFor = (key: Template['queue']) => (key === 'network' ? network.id : key === 'onboarding' ? onboarding.id : key === 'projects' ? projects.id : SUPPORT_QUEUE_ID)

  // SLA policies.
  const policy = (value: Omit<SlaPolicy, 'id' | 'builtin' | 'created_at' | 'updated_at'>, age: number) => {
    const at = iso(now - age * DAY)
    state.sla.push({ ...value, id: id(), builtin: false, created_at: at, updated_at: at })
  }
  policy(
    {
      name: 'Pacific business hours',
      client_ids: [clients[0].id, clients[4].id, clients[3].id],
      business_hours: {
        timezone: 'America/Los_Angeles',
        days: [1, 2, 3, 4, 5],
        start: '08:00',
        end: '18:00',
        holidays: ['2026-11-26', '2026-11-27', '2026-12-25', '2027-01-01'],
      },
      targets: {
        urgent: { first_response_minutes: 30, resolution_minutes: 240 },
        high: { first_response_minutes: 60, resolution_minutes: 600 },
        normal: { first_response_minutes: 240, resolution_minutes: 1200 },
        low: { first_response_minutes: 480, resolution_minutes: 3000 },
      },
      pause_on: ['pending', 'on_hold'],
    },
    140,
  )
  policy(
    {
      name: 'Premium 24x7 (financial services)',
      client_ids: [clients[6].id],
      business_hours: null,
      targets: {
        urgent: { first_response_minutes: 15, resolution_minutes: 120 },
        high: { first_response_minutes: 30, resolution_minutes: 240 },
        normal: { first_response_minutes: 120, resolution_minutes: 720 },
        low: { first_response_minutes: 240, resolution_minutes: 1440 },
      },
      pause_on: ['on_hold'],
    },
    120,
  )
  policy(
    {
      name: 'Central business hours',
      client_ids: [clients[2].id],
      business_hours: { timezone: 'America/Chicago', days: [1, 2, 3, 4, 5, 6], start: '06:00', end: '20:00', holidays: ['2026-12-25'] },
      targets: {
        urgent: { first_response_minutes: 20, resolution_minutes: 180 },
        high: { first_response_minutes: 60, resolution_minutes: 480 },
        normal: { first_response_minutes: 180, resolution_minutes: 1440 },
        low: { first_response_minutes: 480, resolution_minutes: 2880 },
      },
      pause_on: ['pending', 'on_hold'],
    },
    100,
  )

  // Contacts.
  CONTACT_SEED.forEach((entry, clientIndex) => {
    const client = clients[clientIndex]
    if (!client) return
    const clientSites = sites.filter((site) => site.client_id === client.id)
    entry.people.forEach(([name, title, siteIndex, user], index) => {
      const local = name.replace(/^Dr\.\s+/, '').toLowerCase().replace(/[^a-z ]/g, '').trim().split(/\s+/)
      const at = iso(now - (300 - index * 9) * DAY)
      state.contacts.push({
        id: id(),
        client_id: client.id,
        site_id: clientSites[siteIndex]?.id ?? null,
        name,
        email: `${local[0]}.${local.at(-1)}@${entry.domain}`,
        phone: `+1 555 01${String(clientIndex).padStart(1, '0')}${String(index).padStart(2, '0')}`,
        title,
        is_primary: index === 0,
        notify: !(clientIndex === 6 && index === 2),
        notes: user ? `Windows user ${user}` : index === 0 ? 'Main point of contact; approves purchases.' : '',
        created_at: at,
        updated_at: at,
      })
    })
  })
  const contactsOf = (client: Client) => state.contacts.filter((contact) => contact.client_id === client.id)

  // Canned responses.
  const canned = (name: string, body: string, shared: boolean, owner: User, visibility: 'public' | 'internal' = 'public') => {
    const at = iso(now - r.between(20, 160) * DAY)
    state.canned.push({ id: id(), name, body, visibility, shared, owner_id: owner.id, created_at: at, updated_at: at })
  }
  canned('Acknowledge — looking into it', 'Hi {{contact.first_name}},\n\nThanks for getting in touch about **{{ticket.subject}}** (ticket #{{ticket.number}}). I’m looking into it now and will update you within the hour.\n\nBest,\n{{technician.name}}', true, avery)
  canned('Need more information', 'Hi {{contact.first_name}},\n\nTo move this forward, could you send:\n\n1. A screenshot of the error\n2. The name of the computer (it’s on the sticker on the front)\n3. When it last worked\n\nThanks,\n{{technician.name}}', true, avery)
  canned('Schedule a remote session', 'Hi {{contact.first_name}},\n\nI’d like to connect to your computer to take a look. Would **today at 2pm** work? You’ll see a prompt asking you to allow the session.\n\n{{technician.name}}', true, sam)
  canned('Resolved — please confirm', 'Hi {{contact.first_name}},\n\nThis should now be fixed. I’ll mark ticket #{{ticket.number}} as resolved; just reply to this email if anything is still not right and it will reopen automatically.\n\nThanks for your patience,\n{{technician.name}}', true, avery)
  canned('Password reset complete', 'Hi {{contact.first_name}},\n\nYour password has been reset. You’ll be asked to choose a new one at your next sign-in. For your security we never send passwords by email.\n\n{{technician.name}}', true, morgan)
  canned('Escalated to vendor', 'Escalated to the vendor for {{client.name}}. Vendor case reference: …\n\nNext check-in: tomorrow 10:00.', true, jordan, 'internal')
  canned('My follow-up nudge', 'Hi {{contact.first_name}}, just checking in on #{{ticket.number}}: did the fix hold up today?', false, avery)
  canned('Sam’s printer checklist', 'Printer checklist: IP reservation, port, driver version, queue.', false, sam, 'internal')

  // Alert rules.
  const ruleAt = iso(now - 90 * DAY)
  state.rules.push(
    {
      id: id(),
      name: 'Critical alerts → NOC queue',
      enabled: true,
      filters: { client_ids: [], severities: ['critical'], check_types: [], sources: [] },
      after_minutes: 10,
      ticket: { queue_id: noc.id, priority: 'high', assignee_id: null },
      close_ticket_on_resolve: true,
      created_at: ruleAt,
      updated_at: ruleAt,
    },
    {
      id: id(),
      name: 'Servers offline for 15 minutes',
      enabled: true,
      filters: { client_ids: [], severities: [], check_types: ['offline'], sources: ['server'] },
      after_minutes: 15,
      ticket: { queue_id: noc.id, priority: 'urgent', assignee_id: sam.id },
      close_ticket_on_resolve: false,
      created_at: iso(now - 80 * DAY),
      updated_at: iso(now - 80 * DAY),
    },
    {
      id: id(),
      name: 'Disk warnings left for 4 hours (Meridian)',
      enabled: false,
      filters: { client_ids: [clients[6].id], severities: ['warning'], check_types: ['disk'], sources: ['check'] },
      after_minutes: 240,
      ticket: { queue_id: SUPPORT_QUEUE_ID, priority: 'normal', assignee_id: drew.id },
      close_ticket_on_resolve: false,
      created_at: iso(now - 40 * DAY),
      updated_at: iso(now - 40 * DAY),
    },
  )
  const criticalRule = state.rules[0]

  // E-mail settings.
  state.email = {
    outbound: {
      enabled: true,
      notify_contact_on_create: true,
      notify_on_public_comment: true,
      notify_on_resolve: true,
      notify_technician_on_assign: true,
      reply_address: 'support@lumen-it.example',
    },
    inbound: {
      enabled: true,
      host: 'imap.lumen-it.example',
      port: 993,
      security: 'tls',
      username: 'support@lumen-it.example',
      folder: 'INBOX',
      processed_folder: 'Processed',
      unknown_sender: 'holding_queue',
    },
    password: 'mock-imap-password',
    signature: '--\n**{{technician.name}}** · Lumen IT Partners\nService desk: +1 555 0100 · [status.lumen-it.example](https://status.lumen-it.example)\n\n_Ticket #{{ticket.number}} for {{client.name}}_',
    inbound_status: { last_poll_at: iso(now - 40_000), last_error: null, last_processed: 3 },
  }

  // ---------------------------------------------------------------- ticket specs

  const specs: Spec[] = []
  const managed = devices.filter((device) => device.status === 'active')
  const deviceFor = (contact: MockContact | null, client: Client): MockDevice | null => {
    const user = contact?.notes.match(/Windows user (.+)$/)?.[1]
    const own = user ? managed.find((device) => device.last_user === user) : undefined
    if (own) return own
    const pool = managed.filter((device) => device.client_id === client.id && (!contact?.site_id || device.site_id === contact.site_id))
    return pool.length ? r.pick(pool) : null
  }
  const techFor = (client: Client, index: number) => (client.id === clients[2].id && index % 3 !== 0 ? riley : client.id === clients[6].id && index % 2 === 0 ? drew : techs[index % techs.length])

  const generic = T.filter((template) => template.client === -1)
  const specific = T.filter((template) => template.client >= 0)
  const plan: { template: Template; client: Client }[] = []
  specific.forEach((template) => plan.push({ template, client: clients[template.client] }))
  generic.forEach((template, index) => {
    plan.push({ template, client: clients[(index * 3) % clients.length] })
    plan.push({ template, client: clients[(index * 5 + 2) % clients.length] })
    if (index < 12) plan.push({ template, client: clients[(index * 7 + 5) % clients.length] })
  })

  plan.forEach(({ template, client }, index) => {
    const people = contactsOf(client)
    const contact = people.length ? people[index % people.length] : null
    const site = contact?.site_id ? (sites.find((item) => item.id === contact.site_id) ?? null) : null
    const device = template.device ? deviceFor(contact, client) : null
    const assigneeRoll = r.next()
    specs.push({
      template,
      subject: template.subject,
      description: template.body,
      client,
      site,
      contact,
      status: 'open',
      priority: template.priority,
      type: template.type,
      source: template.source,
      queueId: queueFor(template.queue),
      assignee: assigneeRoll < 0.82 ? techFor(client, index) : null,
      tags: [...template.tags],
      devices: device ? [device] : [],
      alert: null,
      createdAt: now,
      createdBy: template.source === 'email' && contact ? contact.name : techFor(client, index + 1).name,
    })
  })

  // Agent "Request support" tickets with a screenshot.
  const agentDevices = managed.filter((device) => device.os_family === 'windows' && device.last_user && device.online)
  AGENT_REQUESTS.forEach((request, index) => {
    const device = agentDevices[(index * 7) % agentDevices.length]
    if (!device) return
    const client = clients.find((item) => item.id === device.client_id)!
    const contact = state.contacts.find((item) => item.notes === `Windows user ${device.last_user}`) ?? null
    const user = device.last_user ?? 'user'
    const requester = contact?.name ?? user.split('\\').pop()!.replace(/[._]/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())
    const email = contact?.email ?? null
    const subject = request.subject || request.body.split('\n')[0]
    specs.push({
      template: null,
      subject: subject || `Support request from ${requester}`,
      description: `${request.body}\n\nSubmitted from **${device.hostname}** by ${requester} (${user}) ${email ?? ''}`.trimEnd(),
      client,
      site: sites.find((item) => item.id === device.site_id) ?? null,
      contact,
      status: 'open',
      priority: 'normal',
      type: 'incident',
      source: 'agent',
      queueId: SUPPORT_QUEUE_ID,
      assignee: index % 3 === 2 ? null : techFor(client, index),
      tags: [],
      devices: [device],
      alert: null,
      createdAt: now,
      createdBy: requester,
      agent: { device, requester, email, user },
    })
  })

  // Alert-sourced tickets from seeded alerts (critical first), as the rule would have created them.
  const alertCandidates = [...monitoring.alerts]
    .filter((alert) => alert.device_id && !alert.in_maintenance)
    .sort((a, b) => (a.severity === b.severity ? b.opened_at.localeCompare(a.opened_at) : a.severity === 'critical' ? -1 : b.severity === 'critical' ? 1 : 0))
    .slice(0, 10)
  for (const alert of alertCandidates) {
    const device = devices.find((item) => item.id === alert.device_id)!
    const client = clients.find((item) => item.id === alert.client_id)!
    const hostname = alert.hostname ?? device.hostname
    specs.push({
      template: null,
      subject: `${alert.title} (${hostname})`,
      description: `${alert.message || alert.title}\n\n| | |\n|---|---|\n| Device | ${hostname} |\n| Client | ${client.name} |\n| Check | ${alert.check_type} |\n| Severity | ${alert.severity} |\n| Opened | ${alert.opened_at} |`,
      client,
      site: sites.find((item) => item.id === device.site_id) ?? null,
      contact: null,
      status: 'open',
      priority: alert.severity === 'critical' ? 'high' : alert.severity === 'warning' ? 'normal' : 'low',
      type: 'alert',
      source: 'alert',
      queueId: noc.id,
      assignee: alert.assigned_to ? (users.find((user) => user.id === alert.assigned_to?.id) ?? null) : null,
      tags: ['monitoring'],
      devices: [device],
      alert,
      createdAt: new Date(alert.opened_at).getTime() + (alert.severity === 'critical' ? 10 : 15) * MINUTE,
      createdBy: 'System',
    })
  }

  // ---------------------------------------------------------------- statuses and times

  // Active tickets cluster in the last few days (so SLA chips show every state); finished ones spread over a month.
  const STATUS_CYCLE: TicketStatus[] = ['open', 'resolved', 'new', 'open', 'closed', 'pending', 'open', 'resolved', 'on_hold', 'open', 'closed', 'new', 'pending', 'open', 'resolved', 'closed']
  specs.forEach((spec, index) => {
    if (spec.alert) {
      spec.status = spec.alert.status === 'resolved' ? (index % 2 ? 'resolved' : 'closed') : spec.alert.status === 'acknowledged' ? 'open' : 'new'
      if (spec.createdAt > now - 2 * MINUTE) spec.createdAt = now - 5 * MINUTE
      return
    }
    spec.status = spec.agent ? (['new', 'open', 'resolved', 'new', 'pending', 'closed', 'open', 'new'] as TicketStatus[])[index % 8] : STATUS_CYCLE[index % STATUS_CYCLE.length]
    const active = !['resolved', 'closed'].includes(spec.status)
    if (active) {
      // Most active tickets are recent enough to be inside their targets; every fifth is old and breaching.
      const minutesAgo =
        spec.status === 'new'
          ? index % 5 === 0
            ? r.between(5 * 60, 9 * 60)
            : r.between(4, 150)
          : index % 5 === 0
            ? r.between(2 * 24 * 60, 5 * 24 * 60)
            : spec.status === 'pending' || spec.status === 'on_hold'
              ? r.between(4 * 60, 3 * 24 * 60)
              : r.between(45, 7 * 60)
      spec.createdAt = now - minutesAgo * MINUTE
    } else {
      spec.createdAt = now - r.between(3, 32) * DAY - r.between(0, 600) * MINUTE
    }
    if (spec.status === 'new' && index % 4 === 0) spec.priority = 'urgent'
  })

  specs.sort((a, b) => a.createdAt - b.createdAt)

  // ---------------------------------------------------------------- build

  const comment = (ticket: MockTicket, value: Omit<TicketComment, 'id' | 'ticket_id' | 'edited_at'> & { edited_at?: string | null }) => {
    // Seeded history never lies in the future.
    const at = Math.min(new Date(value.created_at).getTime(), now - 60_000)
    const item: TicketComment = { id: id(), ticket_id: ticket.id, edited_at: null, ...value, created_at: iso(at) }
    state.comments.push(item)
    ticket.last_activity_at = item.created_at > ticket.last_activity_at ? item.created_at : ticket.last_activity_at
    return item
  }
  const time = (ticket: MockTicket, tech: User, when: number, minutes: number, note: string, billable = true) => {
    const at = Math.min(when, now - 2 * 60_000)
    state.time.push({ id: id(), ticket_id: ticket.id, user_id: tech.id, user_name: tech.name, started_at: iso(at - minutes * MINUTE), minutes, billable, note, created_at: iso(at) })
    record(state, ticket, 'time_logged', tech.name, null, `${minutes} min${billable ? '' : ' (non-billable)'}`, at)
  }
  const setStatus = (ticket: MockTicket, next: TicketStatus, actor: string, when: number) => {
    const at = Math.min(when, now - 60_000)
    if (ticket.status === next) return
    record(state, ticket, 'status', actor, ticket.status, next, at)
    applyStatusClock(state, ticket, next, at)
    ticket.updated_at = iso(at)
  }

  specs.forEach((spec, index) => {
    const created = spec.createdAt
    const ticket: MockTicket = {
      id: id(),
      number: state.sequence++,
      subject: spec.subject,
      description: spec.description,
      client_id: spec.client.id,
      site_id: spec.site?.id ?? null,
      contact_id: spec.contact?.id ?? null,
      status: 'new',
      priority: spec.priority,
      type: spec.type,
      queue_id: spec.queueId,
      assignee_id: null,
      tags: spec.tags,
      cc: index % 9 === 0 && spec.contact ? [`office@${spec.contact.email.split('@')[1]}`] : [],
      device_ids: spec.devices.map((device) => device.id),
      alert_ids: spec.alert ? [spec.alert.id] : [],
      ticket_ids: [],
      source: spec.source,
      created_by_name: spec.createdBy,
      created_at: iso(created),
      updated_at: iso(created),
      last_activity_at: iso(created),
      closed_at: null,
      merged_into_id: null,
      first_response_at: null,
      resolved_at: null,
      paused_minutes: 0,
      paused_since: null,
      breach_recorded: [],
    }
    state.tickets.push(ticket)
    record(state, ticket, 'created', spec.createdBy, null, spec.source, created)
    for (const device of spec.devices) record(state, ticket, 'linked', spec.createdBy, null, `device ${device.hostname}`, created)
    if (spec.alert) {
      record(state, ticket, 'linked', 'System', null, `alert ${spec.alert.title}`, created)
      spec.alert.ticket_id = ticket.id
      addEvent(spec.alert, 'ticket_created', created, `Ticket #${ticket.number} created by the rule “${criticalRule.name}”`, null, {
        ticket_id: ticket.id,
        number: ticket.number,
        rule_id: criticalRule.id,
      })
    }

    const tech = spec.assignee ?? techs[index % techs.length]
    const first = firstName(spec.contact?.name) || 'there'
    const values = { first, tech: tech.name, host: spec.devices[0]?.hostname ?? '' }
    const contactAuthor = spec.contact
      ? { type: 'contact' as const, id: spec.contact.id, name: spec.contact.name }
      : spec.agent
        ? { type: 'contact' as const, id: null, name: `${spec.agent.requester} <${spec.agent.email ?? 'unknown@example.invalid'}>` }
        : null
    const techAuthor = { type: 'user' as const, id: tech.id, name: tech.name }
    const finished = spec.status === 'resolved' || spec.status === 'closed'
    const span = finished ? r.between(2, 46) * HOUR : Math.max(10 * MINUTE, now - created)
    let cursor = created + r.between(2, 8) * MINUTE

    // The agent request's screenshot travels on a first public comment from the requester.
    if (spec.agent && contactAuthor) {
      const attachment = { id: id(), file_name: 'screenshot.jpg', size_bytes: 180_000 + r.between(0, 90_000), content_type: 'image/jpeg' }
      state.attachments.push({ ...attachment, ticket_id: ticket.id, generator: 'screenshot', device_id: spec.agent.device.id })
      comment(ticket, { author: contactAuthor, visibility: 'public', body: '', source: 'agent', attachments: [attachment], created_at: iso(created + 2_000) })
    }
    // E-mail attachments go on a first public system comment.
    if (spec.source === 'email' && index % 7 === 3) {
      const log = `${spec.devices[0]?.hostname ?? 'PC'} event export\n${iso(created - HOUR)} Error 1000 Application crashed\n${iso(created - 30 * MINUTE)} Warning 10016 DCOM\n`
      const attachment = { id: id(), file_name: index % 2 ? 'error-details.txt' : 'event-log.txt', size_bytes: log.length, content_type: 'text/plain' }
      state.attachments.push({ ...attachment, ticket_id: ticket.id, generator: 'text', text: log })
      comment(ticket, { author: { type: 'system', id: null, name: 'System' }, visibility: 'public', body: 'Attachments from the original message.', source: 'email', attachments: [attachment], created_at: iso(created + 1_000) })
    }

    if (spec.assignee) {
      record(state, ticket, 'assignee', spec.source === 'console' ? spec.createdBy : 'System', null, spec.assignee.name, cursor)
      ticket.assignee_id = spec.assignee.id
    }

    if (spec.status === 'new') {
      if (spec.template?.note && index % 2 === 0) {
        comment(ticket, { author: techAuthor, visibility: 'internal', body: spec.template.note, source: 'console', attachments: [], created_at: iso(Math.min(now - MINUTE, cursor + 5 * MINUTE)) })
      }
      if (index % 5 === 1 && spec.priority !== 'urgent') {
        const before = ticket.priority
        ticket.priority = 'high'
        record(state, ticket, 'priority', tech.name, before, 'high', Math.min(now - MINUTE, cursor + 3 * MINUTE))
      }
    } else {
      // First public response.
      // Most first replies land inside the target; every seventh is late.
      const firstReply = Math.min(now - 2 * MINUTE, created + (index % 7 === 3 ? r.between(90, 300) : r.between(5, spec.priority === 'urgent' ? 20 : 40)) * MINUTE)
      const ack = spec.template ? fill(`Hi {first},\n\nThanks for reporting this. I’m on it and will update you shortly.`, values) + signoff(tech) : spec.alert ? 'Investigating the alert; remote checks running.' : fill('Hi {first},\n\nThanks for the request from {host}. I’m connecting to your PC now to take a look.', values) + signoff(tech)
      comment(ticket, { author: techAuthor, visibility: spec.alert ? 'internal' : 'public', body: ack, source: 'console', attachments: [], created_at: iso(firstReply) })
      if (!spec.alert) ticket.first_response_at = iso(firstReply)
      else {
        // Alert tickets get their first public word when the contact is told.
        ticket.first_response_at = iso(firstReply + 20 * MINUTE)
      }
      setStatus(ticket, 'open', tech.name, firstReply)
      cursor = firstReply
      time(ticket, tech, cursor + 15 * MINUTE, r.pick([10, 15, 20, 25, 30]), 'Initial triage and remote checks')

      if (spec.template?.note) {
        comment(ticket, { author: techAuthor, visibility: 'internal', body: spec.template.note, source: 'console', attachments: [], created_at: iso(cursor + 25 * MINUTE) })
      }

      if (spec.status === 'pending' || spec.status === 'on_hold') {
        const askAt = Math.min(now - 3 * MINUTE, cursor + r.between(40, 240) * MINUTE)
        const ask = spec.status === 'pending' ? `Hi ${first},\n\n${spec.template?.ask ?? 'Could you send a screenshot of the error and let me know when it started?'}${signoff(tech)}` : `Hi ${first},\n\nWe’re waiting on the vendor for the next step. I’ll update you as soon as I hear back.${signoff(tech)}`
        comment(ticket, { author: techAuthor, visibility: 'public', body: ask, source: 'console', attachments: [], created_at: iso(askAt) })
        setStatus(ticket, spec.status, tech.name, askAt)
        if (spec.status === 'on_hold') {
          comment(ticket, { author: techAuthor, visibility: 'internal', body: 'Vendor case opened; SLA paused while on hold.', source: 'console', attachments: [], created_at: iso(askAt + MINUTE) })
        }
      } else if (spec.status === 'open') {
        if (spec.template?.reply && contactAuthor && index % 2 === 1) {
          comment(ticket, { author: contactAuthor, visibility: 'public', body: spec.template.ask ? `Here is what I found: it happens every time.\n\n> ${spec.template.ask}` : 'Still happening on my side.', source: 'email', attachments: [], created_at: iso(Math.min(now - MINUTE, cursor + 70 * MINUTE)) })
        }
        if (index % 6 === 0 && ticket.priority !== 'high') {
          const before = ticket.priority
          const after: TicketPriority = before === 'urgent' ? 'high' : before === 'low' ? 'normal' : 'high'
          ticket.priority = after
          record(state, ticket, 'priority', tech.name, before, after, Math.min(now - MINUTE, cursor + 30 * MINUTE))
        }
      } else {
        // Resolved or closed.
        const fixAt = created + span
        const fix = spec.template ? `Hi ${first},\n\n${spec.template.fix}\n\nI’ll mark this as resolved; just reply if anything is still not right.${signoff(tech)}` : spec.alert ? 'The alert cleared after remediation; closing the ticket.' : `Hi ${first},\n\nFixed remotely: the issue on ${spec.devices[0]?.hostname ?? 'your PC'} is sorted.${signoff(tech)}`
        time(ticket, tech, fixAt - 10 * MINUTE, r.pick([20, 30, 45, 60, 90]), spec.template ? 'Fix applied and tested' : 'Remote fix', index % 5 !== 0)
        comment(ticket, { author: techAuthor, visibility: spec.alert ? 'internal' : 'public', body: fix, source: 'console', attachments: [], created_at: iso(fixAt) })
        setStatus(ticket, 'resolved', tech.name, fixAt)
        if (spec.template?.reply && contactAuthor) {
          comment(ticket, { author: contactAuthor, visibility: 'public', body: spec.template.reply, source: 'email', attachments: [], created_at: iso(fixAt + r.between(20, 300) * MINUTE) })
          // A thank-you reply reopened it; the technician resolved it again.
          setStatus(ticket, 'open', spec.contact?.name ?? 'Contact', fixAt + 21 * MINUTE)
          setStatus(ticket, 'resolved', tech.name, fixAt + 40 * MINUTE)
        }
        if (spec.status === 'closed') setStatus(ticket, 'closed', 'System', fixAt + 3 * DAY)
      }
    }
    ticket.updated_at = ticket.last_activity_at > ticket.updated_at ? ticket.last_activity_at : ticket.updated_at
  })

  // Links: the blue-screen problem ticket links its incidents; one duplicate is merged; one follow-up.
  const problem = state.tickets.find((ticket) => ticket.type === 'problem' && ticket.subject.startsWith('Problem:'))
  if (problem) {
    const incidents = state.tickets.filter((ticket) => ticket.id !== problem.id && ticket.tags.includes('hardware') && ticket.type === 'incident').slice(0, 2)
    for (const incident of incidents) {
      problem.ticket_ids.push(incident.id)
      incident.ticket_ids.push(problem.id)
      record(state, problem, 'linked', avery.name, null, `ticket #${incident.number}`, new Date(problem.created_at).getTime() + HOUR)
      record(state, incident, 'linked', avery.name, null, `ticket #${problem.number}`, new Date(problem.created_at).getTime() + HOUR)
    }
  }
  const mergeable = state.tickets.filter((ticket) => (ticket.status === 'open' || ticket.status === 'new') && ticket.source === 'email' && !ticket.alert_ids.length)
  let target: MockTicket | undefined
  let duplicate: MockTicket | undefined
  for (const candidate of mergeable) {
    duplicate = mergeable.find((other) => other.id !== candidate.id && other.client_id === candidate.client_id && other.created_at > candidate.created_at)
    if (duplicate) {
      target = candidate
      break
    }
  }
  if (target && duplicate) {
    const at = Math.max(new Date(duplicate.created_at).getTime(), new Date(target.created_at).getTime()) + 30 * MINUTE
    duplicate.merged_into_id = target.id
    for (const item of state.comments) if (item.ticket_id === duplicate.id) item.ticket_id = target.id
    for (const entry of state.time) if (entry.ticket_id === duplicate.id) entry.ticket_id = target.id
    setStatus(duplicate, 'closed', avery.name, Math.min(now - MINUTE, at))
    target.ticket_ids.push(duplicate.id)
    duplicate.ticket_ids.push(target.id)
    record(state, duplicate, 'merged', avery.name, null, `#${target.number}`, Math.min(now - MINUTE, at))
    record(state, target, 'merged', avery.name, `#${duplicate.number}`, null, Math.min(now - MINUTE, at))
  }

  // SLA breaches already recorded by the 30 s checker.
  for (const ticket of state.tickets) {
    const sla = computeSla(state, ticket, now)
    if (!sla) continue
    const breached: ('first_response' | 'resolution')[] = []
    if (sla.first_response_breached) breached.push('first_response')
    if (sla.resolution_breached) breached.push('resolution')
    if (breached.length) {
      const at = Math.min(now, new Date(breached[0] === 'first_response' ? sla.first_response_due : sla.resolution_due).getTime() + 20_000)
      record(state, ticket, 'sla_breached', 'System', null, breached.length === 2 ? 'both' : breached[0], at)
      ticket.breach_recorded = breached
    }
  }

  state.activity.sort((a, b) => a.at.localeCompare(b.at))
  return state
}
