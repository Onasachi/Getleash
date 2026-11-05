/**
 * The landing page (getleash.xyz): what GetLeash does, how a business sets it up in Telegram, who it is for,
 * how the money stays safe, and two ways in: the bot, where setting up starts, and "Try app". It names no
 * account: "Try app" opens the visitor's own dashboard, found from their wallet. Costs and limits are read from the
 * same shared code the setup uses, so they always match what a new GetLeash gets.
 */
import type { Metadata } from "next";

import { DEFAULT_POLICY, durationText, money, nearRoundedUp, setupCost, setupNeeds } from "@getleash/shared";

import { ArrowIcon, CheckIcon, PauseIcon, WalletIcon, WarningIcon } from "@/components/icons";
import { LeashMark, Wordmark } from "@/components/logo";

const BOT = process.env.NEXT_PUBLIC_TELEGRAM_BOT || "GetLeash_bot";
const BOT_URL = `https://t.me/${BOT}`;
const SOURCE_URL = "https://bitbucket.org/crackedstudios/getleash";

export const metadata: Metadata = {
  title: "GetLeash: pay your suppliers from Telegram",
  description: "An AI agent that pays your suppliers in USDC, under limits on NEAR that only your wallet can change. Set up in minutes in Telegram.",
};

const p = DEFAULT_POLICY;
const COST = nearRoundedUp(setupCost());
const NEEDS = nearRoundedUp(setupNeeds(), 2);
const LIMITS = {
  alone: money(p.approval_threshold),
  daily: money(p.autonomous_daily_budget),
  cap: money(p.daily_cap),
  wait: durationText(p.cooldown_ns),
};

/** "Try app": the visitor's own dashboard, found from their wallet (app/(app)/app/page.tsx). */
function TryApp({ big, light }: { big?: boolean; light?: boolean }) {
  return (
    <a className={`btn${big ? " big" : ""}${light ? " light" : ""}`} href="/app">
      Try app
      <ArrowIcon size={18} />
    </a>
  );
}

/** Setting up starts in the bot. */
function OpenBot() {
  return (
    <a className="btn big" href={BOT_URL} target="_blank" rel="noreferrer">
      Open @{BOT} in Telegram
      <ArrowIcon size={18} />
    </a>
  );
}

export default function Landing() {
  return (
    <div className="site">
      <header className="site-top">
        <div className="site-top-in">
          <a href="#top" className="brand" aria-label="GetLeash">
            <LeashMark size={24} className="mark" />
            <Wordmark height={19} className="word" />
          </a>
          <nav aria-label="Sections">
            <a href="#how">How it works</a>
            <a href="#setup">Set up</a>
            <a href="#business">For business</a>
            <a href="#security">Security</a>
            <a href="#faq">FAQ</a>
          </nav>
          <span className="spacer" />
          <TryApp />
        </div>
      </header>

      <main className="site-main" id="top">
        <section className="site-hero">
          <div>
            <p className="eyebrow">Supplier payments for small businesses</p>
            <h1>Pay your suppliers from Telegram, under limits only you can change.</h1>
            <p className="sub">
              Send GetLeash an invoice. It pays suppliers you trust in USDC right away when the amount is small, and asks you first for everything else. Your money stays
              in your own contract on NEAR.
            </p>
            <div className="ctas">
              <TryApp big />
              <a className="btn big ghost" href="#how">
                See how it works
              </a>
            </div>
            <ul className="facts">
              <li>
                <CheckIcon size={16} />
                Your own contract, with no keys
              </li>
              <li>
                <CheckIcon size={16} />
                Limits enforced on NEAR
              </li>
              <li>
                <CheckIcon size={16} />
                Set up in minutes
              </li>
            </ul>
          </div>

          {/* An illustration of the product: the bot's message, and the page its button opens. */}
          <div className="shot" aria-hidden="true">
            <div className="tg">
              <div className="tg-who">
                <span className="tg-avatar">
                  <LeashMark size={18} />
                </span>
                GetLeash
              </div>
              <p>
                👋 Lagos Fabrics asks for 3.20 USDC. It needs your OK because it is above the {LIMITS.alone} USDC the agent may pay on its own (payment #14).
              </p>
              <span className="tg-btn">Review and approve</span>
            </div>
            <div className="shot-card">
              <span className="chip warn">Needs your OK</span>
              <p className="shot-title">Pay Lagos Fabrics?</p>
              <div className="amt-row">
                <span className="num">3.20</span>
                <span className="unit">USDC</span>
              </div>
              <div className="ident">
                <div className="meta">
                  <span>To</span>
                  <span>NEAR · Payment #14</span>
                </div>
                <div className="row">
                  <div className="addr">
                    <span>lagosfabrics.near</span>
                  </div>
                </div>
              </div>
              <span className="btn big wide">Approve and pay 3.20 USDC</span>
            </div>
          </div>
        </section>

        <section className="band" id="how">
          <div className="band-in">
            <p className="eyebrow">How it works</p>
            <h2>From invoice to paid in three steps</h2>
            <ol className="cards three steps-list">
              <li className="tile">
                <span className="n">1</span>
                <h3>Send the invoice</h3>
                <p>Forward a PDF, a photo or the text to @{BOT} in Telegram.</p>
              </li>
              <li className="tile">
                <span className="n">2</span>
                <h3>GetLeash checks it</h3>
                <p>The agent reads it and matches the supplier against your list. It never pays an address taken from an invoice.</p>
              </li>
              <li className="tile">
                <span className="n">3</span>
                <h3>Paid, or your OK first</h3>
                <p>Small payments to known suppliers go out at once. Anything bigger waits for one tap in your wallet.</p>
              </li>
            </ol>
          </div>
        </section>

        <section className="band alt" id="setup">
          <div className="band-in split">
            <div>
              <p className="eyebrow">Get started</p>
              <h2>Set up in Telegram in a few minutes</h2>
              <p className="intro">
                Everything happens in the chat with @{BOT}. You need a NEAR wallet (HOT Wallet works inside Telegram) with about {NEEDS} NEAR for the one-time setup.
              </p>
              <ol className="how-steps">
                <li>
                  <span>
                    Open <strong>@{BOT}</strong> and tap <strong>START</strong>.
                  </span>
                </li>
                <li>
                  <span>
                    Tap <strong>Set up GetLeash</strong> and connect your NEAR wallet.
                  </span>
                </li>
                <li>
                  <span>
                    Tap <strong>Create my GetLeash</strong> and confirm in your wallet. It costs about {COST} NEAR, once.
                  </span>
                </li>
                <li>
                  <span>
                    Tap <strong>Open the GetLeash chat</strong>. The bot tells you when your GetLeash is ready.
                  </span>
                </li>
                <li>
                  <span>
                    Send USDC to your contract and add the people you pay with <strong>/addsupplier</strong>.
                  </span>
                </li>
              </ol>
            </div>
            <aside className="tile have">
              <h3>What you get</h3>
              <ul className="ticks">
                <li>
                  <CheckIcon size={18} />A contract on NEAR that holds your USDC and answers only to your wallet
                </li>
                <li>
                  <CheckIcon size={18} />
                  An agent that reads your invoices and proposes payments
                </li>
                <li>
                  <CheckIcon size={18} />
                  Limits that only your wallet can change
                </li>
                <li>
                  <CheckIcon size={18} />
                  Approvals, status and pause, all from Telegram
                </li>
              </ul>
              <OpenBot />
            </aside>
          </div>
        </section>

        <section className="band" id="business">
          <div className="band-in">
            <p className="eyebrow">For business</p>
            <h2>Built for businesses that pay suppliers every week</h2>
            <div className="cards three">
              <div className="tile">
                <h3>Importers and traders</h3>
                <p>Pay overseas suppliers in USDT on Tron straight from your USDC. The fee is shown before you confirm.</p>
              </div>
              <div className="tile">
                <h3>Shops and distributors</h3>
                <p>Routine invoices from your wholesalers are paid on their own, within the limits you set.</p>
              </div>
              <div className="tile">
                <h3>Teams with contractors</h3>
                <p>Pay freelancers and service providers on time, without sharing a card or a wallet&apos;s keys.</p>
              </div>
            </div>
            <div className="cards three gains">
              <div>
                <strong>Save time</strong>
                <span>No more copying amounts and addresses by hand.</span>
              </div>
              <div>
                <strong>Stop invoice fraud</strong>
                <span>Money goes only to addresses on your list.</span>
              </div>
              <div>
                <strong>Stay in control</strong>
                <span>Approve, reject or pause from your phone.</span>
              </div>
            </div>
          </div>
        </section>

        <section className="band alt" id="security">
          <div className="band-in">
            <p className="eyebrow">Security</p>
            <h2>Your money stays under your rules</h2>
            <p className="intro">GetLeash is self-custodial: it holds no key that can withdraw or redirect your money.</p>
            <div className="cards three">
              <div className="tile">
                <span className="ic">
                  <WalletIcon size={20} />
                </span>
                <h3>Your own contract</h3>
                <p>Your USDC sits in a contract on NEAR with no keys. Only its rules move money, and only your wallet can change them.</p>
              </div>
              <div className="tile">
                <span className="ic">
                  <CheckIcon size={20} />
                </span>
                <h3>Limits on-chain</h3>
                <p>
                  New setups start small: the agent pays alone up to {LIMITS.alone} USDC a payment and {LIMITS.daily} USDC a day, and at most {LIMITS.cap} USDC leaves a
                  day.
                </p>
              </div>
              <div className="tile">
                <span className="ic">
                  <WarningIcon size={20} />
                </span>
                <h3>Known suppliers only</h3>
                <p>Payments go only to suppliers you added, at the address on file. After an address changes, payments wait for you for {LIMITS.wait}.</p>
              </div>
              <div className="tile">
                <span className="ic">
                  <ArrowIcon size={20} />
                </span>
                <h3>You approve the rest</h3>
                <p>Bigger or unusual payments wait for your OK, signed in your own wallet with the exact amount and recipient.</p>
              </div>
              <div className="tile">
                <span className="ic">
                  <PauseIcon size={20} />
                </span>
                <h3>One-tap pause</h3>
                <p>One signature in your wallet stops every payment at once; another starts them again.</p>
              </div>
              <div className="tile">
                <span className="ic">
                  <CheckIcon size={20} />
                </span>
                <h3>AI that can&apos;t break the rules</h3>
                <p>The agent only proposes; the contract decides. A fake or tampered invoice can&apos;t move money outside your rules.</p>
              </div>
            </div>
          </div>
        </section>

        <section className="band" id="faq">
          <div className="band-in narrow">
            <p className="eyebrow">FAQ</p>
            <h2>Questions businesses ask</h2>
            <div className="faq">
              <details>
                <summary>Do I need to understand crypto?</summary>
                <p>No. You need a NEAR wallet and some USDC. HOT Wallet works inside Telegram, and the setup page explains each step.</p>
              </details>
              <details>
                <summary>What does it cost?</summary>
                <p>
                  About {COST} NEAR once, from your wallet, to create your contract. Approving a payment costs a tiny network fee. Payments to Tron include a NEAR Intents
                  fee, shown before you confirm.
                </p>
              </details>
              <details>
                <summary>Can GetLeash take my money?</summary>
                <p>
                  No. Its two helper accounts can only propose and send payments within your contract&apos;s rules. Adding suppliers, changing limits and withdrawing all need
                  your wallet.
                </p>
              </details>
              <details>
                <summary>What happens with a fake invoice?</summary>
                <p>GetLeash pays only suppliers on your list, and only at the address on file. It never pays an invoice from someone else, or to an address an invoice asks for.</p>
              </details>
              <details>
                <summary>Which currencies does it pay in?</summary>
                <p>Your treasury holds USDC on NEAR. Suppliers can be paid in USDC on NEAR, or in USDT on Tron.</p>
              </details>
            </div>
          </div>
        </section>

        <section className="band last">
          <div className="band-in">
            <div className="cta-band">
              <h2>Start paying suppliers from Telegram</h2>
              <p>Set up in a few minutes. You stay in control.</p>
              <TryApp big light />
            </div>
          </div>
        </section>
      </main>

      <footer className="site-foot">
        <div className="site-foot-in">
          <a href="#top" className="brand" aria-label="GetLeash">
            <LeashMark size={22} className="mark" />
            <Wordmark height={18} className="word" />
          </a>
          <span className="muted">An AI agent that pays your suppliers under on-chain rules it cannot break.</span>
          <span className="spacer" />
          <a href={BOT_URL} target="_blank" rel="noreferrer">
            Telegram bot
          </a>
          <a href={SOURCE_URL} target="_blank" rel="noreferrer">
            Source code
          </a>
          <span className="muted">© 2026 GetLeash · Built on NEAR</span>
        </div>
      </footer>
    </div>
  );
}
