# GetLeash brand files

The logo is direction 1a, "The lead", from Claude Design (5 Nov 2026), with the join fixed in its stage 2. It
is a G drawn as one line: the loop at the top is the owner's hand, and the dot at the centre is the agent.

| File | Use |
|---|---|
| `telegram-avatar.png` | The bot's profile photo, 640 × 640. Telegram shows it as a circle. In @BotFather: /mybots → @GetLeash_bot → Edit Bot → Edit Botpic |
| `telegram-intro.png` | The picture above the bot's description in an empty chat, before START, 640 × 360. In @BotFather: Edit Bot → Edit Description Picture |
| `../web/public/logo.svg`, `logo-dark.svg` | Horizontal lockup, for light and dark backgrounds |
| `../web/public/logo-mark.svg` | The symbol alone, in `currentColor` |
| `../web/app/icon.svg`, `favicon.ico`, `apple-icon.png` | Browser icons; Next.js serves them |
| `../web/public/og.png` | The link preview (Telegram, X), 1200 × 630, named in `web/app/layout.tsx` |

- **Colours**: brand plum `#4A2545`, and `#D9A7CB` on dark backgrounds; white on the brand colour. Plum is
  also the action colour (buttons, links); green means only "done, safe". The full palette is in
  `web/app/globals.css`.
- **Type**: Instrument Sans (SIL Open Font License 1.1). The wordmark is its SemiBold at −0.015em, outlined
  (no live text in the files).
- **Lockup**: symbol 40 with the wordmark 32 tall, gap 0.25 × the symbol; clear space 0.6 × the symbol on
  every side. Smallest: the symbol at 16 px, the horizontal lockup 88 px wide.
