# GetLeash design brief: logo and UI

For Claude Design. Written on 5 Nov 2026 from the code on branch `feature/getleash-core` of
https://bitbucket.org/crackedstudios/getleash (public). Claude Code will build what you design into the
existing Next.js app, so the handoff (§11) matters as much as the pictures.

## 1. What to make

1. **A logo**: symbol, wordmark and lockups, plus the icons and Telegram images in §5.
2. **A small design system**: colours for light and dark, type, spacing, radii, icons and the components
   in §7, mapped to the CSS classes the app already has.
3. **The screens** in §8, phone first (390 × 844, inside Telegram) and desktop (1280 wide), in every
   state listed there.
4. **A handoff bundle for Claude Code** (§11).

Show me each stage before starting the next: logo directions → chosen logo and system → payment screen →
setup → the rest → handoff.

## 2. GetLeash in one minute

GetLeash is an AI agent that pays a small business's suppliers, under rules on the NEAR blockchain that it
cannot break.

- The owner sends an invoice (a PDF, a photo or pasted text) to the Telegram bot @GetLeash_bot.
- The agent reads it and proposes the payment to the business's own contract on NEAR, which holds the
  business's money (USDC). The contract pays at once when the payment is small, fits the day's budget and
  goes to a supplier the owner has already added. Otherwise it waits for the owner's OK, which the owner
  signs in their own wallet.
- GetLeash holds no key that can withdraw or redirect the money. The owner's wallet holds every key that
  matters: approvals, suppliers, limits, pause, withdrawals.
- Suppliers are paid in USDC on NEAR, or in USDT on Tron (sent cross-chain through NEAR Intents).

**The leash.** The agent may act alone, but only inside the owner's limits: a per-payment threshold, a daily
budget for the agent, a daily cap on everything, only suppliers on the owner's list, and a waiting period
after a supplier's address changes. The owner holds the leash. The contract is the leash, and it can't snap.

Built for the NEAR Hackathon (submissions close 14 Nov 2026). Judges will see the logo, the dashboard and a
demo video.

Live: https://www.getleash.xyz (dashboard) · https://t.me/GetLeash_bot (bot).

## 3. Who uses it, and where

**Owners of small businesses**, such as an importer paying suppliers abroad. They are not crypto people, and
they use Telegram all day. Design for a mid-range Android phone on a slow connection.

They meet GetLeash in three places:

1. **The bot's chat in Telegram**, most of the time: messages and buttons.
2. **GetLeash pages that the bot's buttons open inside Telegram** (a Mini App: a web page in Telegram's
   in-app browser): approve a payment, set GetLeash up, add a supplier, check the wallet, pause. This is the
   main UI: a phone, one hand, 360–430 px wide.
3. **The same pages in a desktop browser** at getleash.xyz: the payments overview and the private view.

Suppliers only meet the bot (an invite they answer). Hackathon judges look on desktop, briefly, and judge
clarity and trust.

What everyone should feel: *my money is safe, and I can see exactly what is happening.* Calm, never rushed.

## 4. Brand

- **Name**: GetLeash, one word, capital G and L. Never "Getleash", "Get Leash" or "GETLEASH" in text.
  Domain getleash.xyz, bot @GetLeash_bot, NEAR accounts ending in getleash.near.
- **Personality**: calm, exact, plain-spoken, warm. A careful bookkeeper, not a crypto app.
- **Voice** (the app's copy already follows it):
  - Plain words and short sentences, speaking to "you": "Needs your OK", "Didn't go through", "Nothing
    needs you right now."
  - Exact facts: the amount and its unit ("0.50 USDC"), who gets paid, what it costs, what happens next.
  - Each button says what it does: "Approve and pay 3.20 USDC", "Pause all payments".
  - Errors say what happened and what to do next: "The setup didn't go through: … Nothing was created,
    and the NEAR went back to your wallet."
  - No hype, no exclamation marks, no "revolutionary" or "web3".
- **Keep out of the visuals**: literal dogs, paws, bones or collars; robots; coins, rockets, moons; chain
  links and cubes (blockchain clichés); shield-with-tick clichés; neon gradients and the usual crypto look.
  Don't borrow from NEAR's, Telegram's or HOT Wallet's logos. Don't make Telegram blue or NEAR's mint green
  the main colour, so GetLeash looks like neither.

## 5. Logo

### Three directions to explore

1. **The lead**: one continuous line with a loop at one end (the owner's hand) and a small clip at the
   other (the agent). It may form a G.
2. **The clip**: the snap hook that fastens a leash, simple and geometric, perhaps shaped like a G. It
   stands for holding on, safely.
3. **Free inside a boundary**: a dot that moves inside a rounded shape, tied to a fixed point. Room to
   move, and a limit it can't cross.

Better ideas are welcome if they say "free within limits; the owner holds the leash" more clearly.

### Requirements

- The symbol reads at **16 × 16 px** and inside a **circle**. Telegram crops bot avatars to a circle, so
  keep the symbol within the middle 70 %.
- One-colour versions (dark on light, light on dark), plus one on the brand colour.
- The wordmark "GetLeash" reads well at the header's size (about 20 px tall) and in the 1200 × 630 link
  preview. Provide a horizontal lockup (symbol + wordmark) and a stacked one, with minimum size and clear
  space.
- Clean vectors: SVG with outlined paths (no live text, embedded images or filters), a square `viewBox` for
  the symbol, and as few paths as possible.

### Show each direction in place

- A browser tab at 16 and 32 px.
- Telegram's chat list: the round avatar next to "GetLeash".
- The app header on a phone, light and dark.
- The bot's intro picture (below).

### Files (named where Claude Code will put them)

| File | What it is |
|---|---|
| `web/app/icon.svg` | The symbol for browsers. Square; may switch colours with `prefers-color-scheme` inside the SVG |
| `web/app/favicon.ico` | 16, 32 and 48 px, for older browsers |
| `web/app/apple-icon.png` | 180 × 180, with a full-bleed background (iOS rounds the corners) |
| `web/public/logo.svg`, `web/public/logo-dark.svg` | Horizontal lockup for light and dark backgrounds |
| `web/public/logo-mark.svg` | The symbol alone, one colour, drawn in `currentColor` |
| `web/app/opengraph-image.png` + `opengraph-image.alt.txt` | 1200 × 630 link preview (Telegram, X): the logo and "An AI agent that pays your suppliers under on-chain rules it cannot break." |
| `brand/telegram-avatar.png` | 640 × 640 bot profile photo, shown as a circle |
| `brand/telegram-intro.png` | 640 × 360 picture that Telegram shows above the bot's description in an empty chat, before START (BotFather's recommended size) |

Also write the bot's **description** (at most 512 characters, shown in the empty chat before START) and its
**short description** (at most 120 characters, shown on its profile and when someone shares the bot).

## 6. Visual system

### What exists today (`web/app/globals.css`)

```css
/* light */
--bg: #f7f7f5; --panel: #ffffff; --ink: #1d1d1b; --muted: #6b6b66; --line: #e3e3de;
--accent: #1f5f4a; --good: #1f7a4d; --good-bg: #e6f4ec; --warn: #8a5a00; --warn-bg: #fdf3dc;
--bad: #a3261b; --bad-bg: #fbe7e5;
/* dark (follows prefers-color-scheme) */
--bg: #141413; --panel: #1c1c1a; --ink: #ecece8; --muted: #9b9b94; --line: #2e2e2b;
--accent: #6cc4a1; --good: #6cc4a1; --good-bg: #16302a; --warn: #e8b85a; --warn-bg: #352a12;
--bad: #f08a80; --bad-bg: #3a1a17;
```

The font is `system-ui` at 15 px / 1.5. Accounts, addresses and hashes are in monospace, and amounts use
tabular figures. Cards have 10–14 px radii, 1 px borders and no shadows. There is no logo, favicon or icon
yet: the header shows "GetLeash" in bold green text.

You may change any of it. Keep:

- **The token names, or a one-to-one map from old to new**, so the code change stays small.
- **Four tones with fixed meanings**: good (done, safe), warn (waiting, needs you, under way), bad (failed,
  refunded, danger), plain (neutral, such as "Rejected").
- **WCAG 2.2 AA contrast** in both themes: 4.5:1 for text, 3:1 for controls and focus rings.

### Problems to solve

- **Brand green and success green are nearly the same**, so the main "Approve" button reads like a
  status. Separate them.
- **Dark mode follows the phone, not Telegram.** Inside Telegram it should follow Telegram's theme, since
  someone can run Telegram dark on a light phone. Design both themes, and give the Telegram header and
  background colours for each (a Mini App can set both).
- **Emoji stand in for icons** in the pages (⚠️ ⏸ ✓ ✗ ✕ ↗ → ←) and look different on every phone. Replace
  them with a small icon set in the pages. The bot's messages keep their emoji, because Telegram messages
  can't show icons.
- **Long identifiers break anywhere.** These are account names such as `ada-near.getleash.near`,
  64-character hex deposit addresses and 34-character Tron addresses. Give them one treatment: monospace,
  clean wrapping, a copy button, and a link to the explorer where there is one.
- **The header is too wide for a phone.** Inside Telegram, most pages are opened by one button, so
  navigation matters less there than on desktop.

### Type, shape, motion

- **Type**: system fonts, or one variable family self-hosted through `next/font` (no font CDN at runtime),
  plus a monospace. Define a scale: amount (36 px desktop and 30 px phone today), title, lead, body, small,
  label.
- **Shape**: keep it flat and quiet, with at most one soft elevation for the main card.
- **Motion**: little of it (a button press, a step completing, a status changing), respecting
  `prefers-reduced-motion`. Pages refresh every 4 seconds while they wait, so updates must not make the
  layout jump.

## 7. Components

| Component | Class today | What it needs |
|---|---|---|
| Header | `.top`, `.brand`, `nav`, `.net` | Logo; nav (Payments · Suppliers & invoices · Pause · Wallet; "Suppliers & invoices" only on GetLeash's own instance); a "testnet" badge off mainnet; "Connect wallet", or the connected account with ✕ to disconnect |
| Footer | `footer` | One sentence: everything is read from NEAR in your browser, money moves only within the contract's rules (link), and you approve in your own wallet |
| Hero card | `.hero` | The page's one decision: status chip, title, big amount, "to …", lead, notice, actions, hint |
| Status chip | `.chip.good` / `.warn` / `.bad` | Always words, never colour alone |
| Code pill | `.pill` | Raw codes (PENDING, SUCCESS…) in technical sections |
| Buttons | `button.primary`, `.ghost`, `.danger`, `.quiet` | Primary at 17 px. "Quiet" is red text, used for Reject. While the wallet is open the button says "Waiting for your wallet…". A disabled button shows the reason in words below it. Touch targets at least 44 px |
| Notice | `.notice`, `.notice.bad` | A warning band. The bad one ("this isn't a GetLeash") must be impossible to miss |
| Check row | `.check.ok` / `.fail` | ✓ or ✗, a label, and optionally a monospace detail |
| Progress steps | `.steps li.done` / `.current` / `.bad` | 3 to 6 steps with long labels ("Within the executor's allowance"); must fit at 360 px |
| Task row | `.task` | A "Needs you" item: who · amount, one line saying why, and an action ("Review →") |
| Payment row | `ul.payments` | Chip, who, amount and when; on phones the time is hidden |
| Fold | `details.fold` | Show/Hide sections: safety checks, technical details, the terminal option |
| Key–value table | `table` | Technical details; must not overflow on a phone |
| Terminal command | `pre.cmd` + "Copy command" | A near-cli command for owners who sign in a terminal |
| Result line | `.success` / `.error` | "✓ Done. View the transaction ↗", or what failed |
| Text field | `input` | The app's only form: an address and a "Check" button |
| Loading and errors | — | "Loading from the chain…" today; a skeleton is welcome. Errors in words |
| Meter (new, optional) | `.bar` (exists, unused) | Spent today against the cap, and the agent's daily budget used |

**Icons** (inline SVG in `currentColor`, at 16 and 20 px): check, cross, warning, info, pause, play,
external link, arrow right, back, copy, wallet, clock, refresh, chevron.

## 8. Screens

### 8.1 A payment (`/intent/[id]`): the most important screen

The bot's "Review and approve" button opens it inside Telegram. It holds one decision.

**Hero**, top to bottom:

- **Status chip**: Needs your OK · Approved · Getting a quote · Confirm transfer · Sending · On its way ·
  Paid · Delivered · Refunded · Didn't go through · Rejected.
- **Title**, by state: "Pay Lagos Fabrics?" · "Confirm the transfer to Shenzhen Parts" · "Getting a quote to
  pay …" · "Sending to …" · "Paid …" · "Delivered to …" · "Not delivered: refunded" · "Didn't go through" ·
  "Rejected".
- **The exact amount**, large: "3.20 USDC" or "12.00 USDT on Tron".
- **The recipient**, in full, never shortened here: "to lagosfabrics.near · payment #14", or for Tron "to
  TVr7rWq3KcU5mF1zBnQk9yJdH2pX6sLaE4 on Tron · payment #13".
- **Lead**: why it waits ("It needs your OK because it is above the 2.50 USDC the agent may pay on its
  own."), and for a cross-chain payment, the most it can cost.
- **The agent's flag**, when set: "The agent asks you to check this one: the amount is much higher than
  usual for this supplier."
- **Actions**: a primary button and, next to it, a quiet "Reject". The primary is one of:
  - "Approve and pay 3.20 USDC" (NEAR);
  - "Approve 12.00 USDT on Tron" (cross-chain);
  - "Confirm and send 12.13 USDC" (once there is a quote);
  - "Try again", with "It counts against today's limits again."
- **When blocked**: the button is disabled, with the reasons below it: "Not possible yet: payments are
  paused; …".
- **Who signs**: "You'll sign in your wallet, as ada.near." With the wrong account connected: "You're
  connected as bob.near; only the owner, ada.near, can approve."
- **Fold** "Or sign in a terminal (near-cli)", then the result line. A rare stuck transfer adds a notice
  with "Mark paid" and "Mark failed".

**Below the hero**:

- **Progress steps**: Invoice received → Your OK (or "Within the agent's limits") → Paid. Cross-chain:
  Invoice received → Your OK → Quote → Your confirmation (or "Within the executor's allowance") → Sent →
  Delivered (or Refunded).
- **"Safety checks"**: a fold showing "✓ All 4 checks passed", which opens by itself when one fails.
  Cross-chain payments add "✓ NEAR Intents' quote matches what the contract will pay (13 checks)", a
  field-by-field comparison.
- **"Technical details"**: a fold with a table.

**Design at least these states**:

1. Needs your OK (NEAR, approvable).
2. Needs your OK with a failed check (blocked: the supplier's address changed yesterday).
3. Cross-chain, waiting for the owner's confirmation: amount in, fees, and "valid until today 19:40 (in
   12 min)".
4. Sending / On its way (refreshing by itself).
5. Delivered.
6. Refunded, with "Try again".
7. Didn't go through.
8. Rejected.

### 8.2 Overview (`/`)

- **Treasury card**: "18.40 USDC" (rounded, with the exact amount on hover or long press), and "Sent
  today: 3.70 of 20.00 USDC · paid by the agent on its own: 1.20 of 5.00 USDC · anything above 2.50 USDC
  waits for you". The two counters could become meters.
- **Paused**: "Payments are paused. Unpause".
- **"Needs you (2)"**: task rows. When there are none: "✓ Nothing needs you right now."
- **"Recent payments"**: payment rows; the agent's own payments say "paid by the agent". When there are
  none: "None yet. Send an invoice to the bot to start."
- **Private names**: "Supplier names are private: sign in to see them instead of addresses." Until then,
  rows show shortened addresses.
- **Fold "How your money is protected"**: five rules with the live numbers, then a line of contract facts.
  The rules: the contract has no keys; the agent's limits; the daily cap; listed suppliers only, with the
  waiting period after a change; who confirms cross-chain transfers.

### 8.3 Setup (`/setup`): a new business's first impression

Opened from the bot's "Set up GetLeash" button, inside Telegram. It is one page moving through states.
Show it as three steps (Connect wallet → Create → Finish) and make clear where the user is.

| State | Chip | Title | Main action |
|---|---|---|---|
| Opened outside the bot | Set up GetLeash | Open this from the GetLeash bot | none |
| Link expired | Expired (warn) | This setup link has expired | none: send /start again |
| Link not from GetLeash | Can't set up (bad) | This setup link isn't from GetLeash | none |
| Old Telegram | Update Telegram (warn) | Update Telegram to set up GetLeash | none |
| Connect | Set up GetLeash | Set up GetLeash for your business | "Connect your wallet" (hint: "HOT Wallet opens here in Telegram. Connecting signs nothing.") |
| Account name too long | Can't set up (bad) | This account can't hold GetLeash | "Use another account" |
| **Create** | Set up GetLeash | Create your GetLeash | "Create my GetLeash" |
| Being created | Almost there (warn) | Your GetLeash is being created | none (checks again by itself) |
| Code not installed | Almost there (warn) | Your contract is waiting for its code | "Try again" |
| Not on USDC yet | Almost there (warn) | Register your contract on USDC | "Register it" (0.00125 NEAR) |
| **Ready** | Ready (good) | Your GetLeash is ready | "Finish", then "Open the GetLeash chat" |
| Already has one | Already set up | Connect your GetLeash to this Telegram account | "Connect it", then "Open the GetLeash chat" |
| Accounts taken | Can't set up (bad) | Those accounts are in use | "Use another account" |

**Create** starts with who it is for: "As bola.near, for the Telegram account @bolastores (continue only if
that's you)."

- It lists what the wallet's 1.404 NEAR to `getleash.near` creates: the contract `bola-near.getleash.near`
  (no keys; only your wallet can change it), the agent's and the executor's accounts, and the USDC
  registration.
- A check line follows: "About 1.43 NEAR from your wallet, network fees included. It needs 1.491 NEAR while
  it signs (the rest comes back); you have 2.150 NEAR available."
- When the wallet is short: "Add NEAR to bola.near first: about 0.300 more."

**Ready** shows three ✓ checks:

- The contract runs the GetLeash release, has no keys and answers to your wallet.
- The agent and the executor hold only the keys GetLeash generated.
- It can receive USDC.

The hint under the button explains the last tap: Telegram opens the GetLeash chat and sends START (or
shows a START button to tap), and the bot replies once it has checked everything.

HOT Wallet draws its own window over the page to connect and sign; that isn't ours to design. When it
closes, the next step must be obvious.

### 8.4 Add a supplier (`/suppliers/new`)

The bot's "Add …" button opens it with the address filled in.

- **Hero**: "Add a supplier", "Paid in USDC at lagosfabrics.near."
- **Checks**: "A NEAR account" (or "A Tron address, with a valid checksum"), "The account exists", "Not on
  your list yet", and "Can already receive USDC" or "Gets registered on USDC first, so it can receive it
  (0.00125 NEAR, paid by you)".
- **Actions**: "Add supplier", and a fold "A different address?" holding the address field.
- **Done**: "Supplier #3 is on your list", with "Back to the chat".

### 8.5 Wallet check (`/wallet`)

Four states:

- **Not connected**: "Check your wallet" with "Connect HOT Wallet", plus a hint on importing the owner's
  account into HOT Wallet.
- **Wrong account** (bad): "This isn't the owner's account", with "Connect again".
- **Ready**: "Your wallet is ready", with ✓ "Signs as ada.near, the owner of your GetLeash contract" and
  ✓ "0.84 NEAR for network fees".
- **Almost ready**: "Add a little NEAR for fees".

### 8.6 Pause (`/pause`)

- **Running**: a red primary "Pause all payments", with "One signature in your wallet stops every new
  payment at once."
- **Paused**: "Unpause payments".
- **Fold** "What keeps working while paused".

### 8.7 Private view (`/private`): desktop, low priority

The owner signs a message in their wallet, then sees supplier names and invoices: a suppliers table, and
one card per invoice with the agent's checks. It exists only on GetLeash's own instance.

### 8.8 The bot (images and words only)

Telegram controls the layout. We control the avatar, the intro picture, the descriptions, the message text
(emoji allowed) and the button labels. Today's labels:

- "Set up GetLeash"
- "Review and approve"
- "Confirm the transfer"
- "Open the payment"
- "Check the payment"
- "Open the pause page"
- "Open in GetLeash"
- "Share the invite"
- "Open HOT Wallet"
- "Check my wallet"

A typical message:

> 👋 Lagos Fabrics asks for 3.20 USDC. It needs your OK because it is above the 2.50 USDC the agent may pay
> on its own (payment #14).
> [Review and approve]

Suggest edits if they help, listed as in §9, rule 11.

### 8.9 Optional, last: a front door for visitors

Today getleash.xyz opens straight on a payments overview. A visitor who isn't an owner, such as a judge,
gets no explanation and no way in. Propose a short first screen: what GetLeash is in one line, how the money
is protected in three points, and "Open @GetLeash_bot" with a QR code for desktop. This is a new page, so
design it only after everything else.

## 9. Rules the design must keep (they are security features)

1. Payment screens show the **exact** amount with its unit. Rounded amounts are only for totals and
   balances, with the exact amount one tap away.
2. The payment screen shows the recipient **in full**, the network (NEAR or Tron) and the payment number.
   Shortened addresses appear only in lists.
3. The main button **repeats what will be signed**: "Approve and pay 3.20 USDC", "Confirm and send 12.13
   USDC". The wallet then shows the same terms.
4. A failed check **disables** the button and says why, in words, beside it. Failed checks are never
   hidden; passed ones may fold away.
5. Approve and Reject never look alike. Reject stays one tap away, but secondary. Pause is the only red
   primary button.
6. Actions stay **buttons inside the page**. Don't move them to Telegram's own bottom button, popups or
   browser dialogs. On Android, Telegram opens a link from a Mini App only within 10 seconds of a tap, once
   per tap (Telegram's Android source, checked 4 Nov 2026). The wallet's own window takes a tap of its own,
   so the setup's last step needs another, on a button the user can see next to the words that explain it.
7. No extra "Are you sure?" dialogs: the wallet's confirmation is the confirmation.
8. No pressure. The only timers are real ones: a quote's validity, the end of a waiting period, a setup
   link's expiry.
9. The warning that a contract "isn't a GetLeash" stays at the top of every page and can't be dismissed.
10. No invented claims ("insured", "audited", "bank-grade") and no fiat signs. Amounts are in USDC or USDT,
    setup costs in NEAR.
11. You may tighten the copy, but every fact must stay: the amount, the recipient, the cost, what happens
    next, and what doesn't come back ("Today's limits are not given back"). List each change as old → new,
    with the reason, so it can be checked.

## 10. Sample data for mockups (all fictional)

- **Business**: Ada's Imports. Owner wallet `ada.near`, Telegram @ada_imports.
  - Contract `ada-near.getleash.near`.
  - Agent `ada-near-agent.getleash.near`.
  - Executor `ada-near-executor.getleash.near`.
- **Limits**:
  - The agent pays on its own up to 2.50 USDC a payment and 5.00 USDC a day.
  - At most 20.00 USDC leaves per day in all.
  - After a supplier's address changes, payments to them wait 2 days, and the owner can approve at most
    0.50 USDC until then.
- **Today**: treasury 18.40 USDC; 3.70 USDC sent today, 1.20 USDC of it by the agent alone.
- **Suppliers**:
  - #1 Lagos Fabrics, `lagosfabrics.near`, paid in USDC.
  - #2 Shenzhen Parts, `TVr7rWq3KcU5mF1zBnQk9yJdH2pX6sLaE4`, paid in USDT on Tron.
  - #3 Kumasi Packaging, `kumasipack.near`, paid in USDC; its address changed yesterday.
- **Payments**:
  - #14 Lagos Fabrics, 3.20 USDC: Needs your OK (above 2.50).
  - #13 Shenzhen Parts, 12.00 USDT on Tron: Confirm transfer. It costs 12.13 USDC, 0.13 of it fees. The
    quote is valid until today 19:40. The deposit address is
    `759f745f0804fd54584a2d96d97e11d70cd20a165c830459767f8a314e664696`.
  - #12 Kumasi Packaging, 4.00 USDC: Needs your OK, blocked ("until 7 Nov 10:00 you can approve at most
    0.50 USDC").
  - #11 Lagos Fabrics, 1.20 USDC: Paid by the agent, today 09:12.
  - #10 Shenzhen Parts, 8.00 USDT on Tron: Delivered, 2 Nov.
  - #9 Shenzhen Parts, 5.00 USDT on Tron: Refunded.
  - #8 Lagos Fabrics, 2.10 USDC: Rejected.
- **Wallet**: 0.84 NEAR free for fees.
- **Setup example**: a new business, Bola Stores.
  - Owner `bola.near`, Telegram @bolastores.
  - Contract to be `bola-near.getleash.near`.
  - 2.150 NEAR available.

## 11. Handoff to Claude Code

**The stack**:

- Next.js 16 (App Router), React 19 and TypeScript, deployed on Vercel.
- The pages are client components that read the NEAR chain from the browser.
- There is one global stylesheet, `web/app/globals.css` (about 145 lines), and the shared components live in
  `web/components/ui.tsx`.
- There is no Tailwind, no CSS-in-JS and no component library, and that should stay so: the app must stay
  light inside Telegram on slow phones.

**Put in the bundle**:

1. **Tokens**: a replacement for the light and dark blocks of `globals.css`, plus the Telegram header and
   background colours.
2. **Plain CSS** for each component in §7, on the existing class names. Name any new class and say where it
   goes.
3. **Icons** as SVG, or as React components for `web/components/icons.tsx`, in `currentColor`, with no icon
   font.
4. **The logo files** under the names in §5.
5. **Annotated screens**, phone and desktop, every state in §8, with spacing.
6. **The copy changes**: old → new, with the reason.
7. **Anything new** (a meter, an identifier with a copy button, the front door), with its states.

Not ours to change: the wallet's windows (HOT Wallet, near-connect's wallet chooser) and Telegram's own
interface.

## 12. If you can read files, attach these

Attach `web/app/globals.css`, `web/components/ui.tsx`, `web/app/page.tsx`, `web/app/intent/[id]/page.tsx`
and `web/app/setup/page.tsx`, plus screenshots of the live pages on a phone.
