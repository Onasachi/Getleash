/**
 * The landing page (getleash.xyz), Claude Design's landing direction 1b, "The product, working": a GetLeash
 * chat playing in a phone, three facts, the starting limits as a table, who it is for, questions, and two
 * ways in: the bot, where setting up starts, and "Dashboard", which opens the visitor's own dashboard, found
 * from their wallet (app/(app)/app/page.tsx). It names no account. Costs and limits are read from the same
 * shared code the setup uses, so they always match what a new GetLeash gets. The design's demo video slot
 * waits for the recording; its menu's FAQ link gets the questions from direction 1a.
 */
import type { Metadata } from "next";

import { DEFAULT_POLICY, durationText, money, nearRoundedUp, setupCost } from "@getleash/shared";

import { BOT_QR_URL, BotQr } from "@/components/bot-qr";
import { ChatDemo } from "@/components/chat-demo";
import { ArrowIcon, CheckIcon, PauseIcon, WalletIcon } from "@/components/icons";
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
const LIMITS = {
  alone: money(p.approval_threshold),
  daily: money(p.autonomous_daily_budget),
  cap: money(p.daily_cap),
  wait: durationText(p.cooldown_ns),
};

function OpenBot() {
  return (
    <a className="lp-btn" href={BOT_URL} target="_blank" rel="noreferrer">
      Open @{BOT}
      <ArrowIcon size={18} />
    </a>
  );
}

export default function Landing() {
  return (
    <div className="site">
      <header className="lp-top">
        <a href="#top" className="lp-brand" aria-label="GetLeash">
          <LeashMark size={26} className="mark" />
          <Wordmark height={20} />
        </a>
        <span className="spacer" />
        <nav aria-label="Sections">
          <a href="#how">How it works</a>
          <a href="#security">Security</a>
          <a href="#faq">FAQ</a>
          <a href="/app" className="strong">
            Dashboard
          </a>
        </nav>
      </header>

      <main className="lp-main" id="top">
        <div className="lp-hero-wrap">
          <section className="lp-hero">
            <div className="lp-hero-text">
              <h1>Pay your suppliers from Telegram, under limits only you can change.</h1>
              <p className="lp-sub">Forward an invoice to the bot. Small payments to suppliers you trust go out at once. Bigger ones wait for one tap in your wallet.</p>
              <div className="lp-ctas">
                <OpenBot />
                {BOT_URL === BOT_QR_URL && (
                  <div className="lp-scan">
                    <span className="lp-qr">
                      <BotQr pixels={50} />
                    </span>
                    <span className="lp-scan-text">
                      On a computer?
                      <br />
                      Scan to open on your phone.
                    </span>
                  </div>
                )}
              </div>
              <p className="lp-alt">
                or <a href="/app">open your dashboard</a> with your wallet
              </p>
            </div>
            <div className="lp-how" id="how">
              <ChatDemo alone={LIMITS.alone} />
            </div>
          </section>
        </div>

        <section className="lp-facts" aria-label="What keeps your money safe">
          <div className="lp-fact">
            <span className="lp-fact-icon">
              <WalletIcon size={18} />
            </span>
            <span className="lp-fact-text">
              <strong>Your own contract</strong>
              <span>Your USDC stays in a contract on NEAR with no keys.</span>
            </span>
          </div>
          <div className="lp-fact">
            <span className="lp-fact-icon">
              <CheckIcon size={18} />
            </span>
            <span className="lp-fact-text">
              <strong>Known suppliers only</strong>
              <span>Money goes only to addresses on your list.</span>
            </span>
          </div>
          <div className="lp-fact">
            <span className="lp-fact-icon">
              <PauseIcon size={18} />
            </span>
            <span className="lp-fact-text">
              <strong>Pause in one tap</strong>
              <span>One signature stops every payment at once.</span>
            </span>
          </div>
        </section>

        <section className="lp-split" id="security">
          <div>
            <p className="lp-eyebrow">Security</p>
            <h2>The agent proposes. Your contract decides.</h2>
            <p className="lp-lead">
              GetLeash is self-custodial: your USDC sits in a contract on NEAR with no keys, and it holds no key that can withdraw or redirect your money.
            </p>
          </div>
          <div>
            <dl className="lp-rules">
              <div>
                <dt>The agent pays on its own, per payment</dt>
                <dd>up to {LIMITS.alone} USDC</dd>
              </div>
              <div>
                <dt>The agent pays on its own, per day</dt>
                <dd>up to {LIMITS.daily} USDC</dd>
              </div>
              <div>
                <dt>Leaves your contract per day, in all</dt>
                <dd>at most {LIMITS.cap} USDC</dd>
              </div>
              <div>
                <dt>After a supplier&apos;s address changes</dt>
                <dd>waits {LIMITS.wait}</dd>
              </div>
              <div>
                <dt>Adding suppliers, changing limits, withdrawing</dt>
                <dd>your wallet only</dd>
              </div>
            </dl>
            <p className="lp-note">The limits a new GetLeash starts with. Only your wallet can change them.</p>
          </div>
        </section>

        <section className="lp-who" id="business">
          <p className="lp-eyebrow">Built for businesses that pay suppliers every week</p>
          <div className="lp-cards">
            <div className="lp-card">
              <strong>Importers and traders</strong>
              <span>Pay overseas suppliers in USDT on Tron straight from your USDC. The fee is shown before you confirm.</span>
            </div>
            <div className="lp-card">
              <strong>Shops and distributors</strong>
              <span>Routine invoices from your wholesalers are paid on their own, within the limits you set.</span>
            </div>
            <div className="lp-card">
              <strong>Teams with contractors</strong>
              <span>Pay freelancers and service providers on time, without sharing a card or a wallet&apos;s keys.</span>
            </div>
          </div>
        </section>

        <section className="lp-split" id="faq">
          <div>
            <p className="lp-eyebrow">FAQ</p>
            <h2>Questions businesses ask</h2>
          </div>
          <div className="lp-qs">
            <details name="faq" open>
              <summary>Do I need to understand crypto?</summary>
              <p>No. You need a NEAR wallet and some USDC. HOT Wallet works inside Telegram, and the setup page explains each step.</p>
            </details>
            <details name="faq">
              <summary>What does it cost?</summary>
              <p>
                About {COST} NEAR once, from your wallet, to create your contract. Approving a payment costs a tiny network fee. Payments to Tron include a NEAR Intents fee,
                shown before you confirm.
              </p>
            </details>
            <details name="faq">
              <summary>Can GetLeash take my money?</summary>
              <p>
                No. Its two helper accounts can only propose and send payments within your contract&apos;s rules. Adding suppliers, changing limits and withdrawing all need your
                wallet.
              </p>
            </details>
            <details name="faq">
              <summary>Which currencies does it pay in?</summary>
              <p>Your treasury holds USDC on NEAR. Suppliers can be paid in USDC on NEAR, or in USDT on Tron.</p>
            </details>
          </div>
        </section>

        <section className="lp-end">
          <LeashMark size={56} className="mark" />
          <h2>Set up in a few minutes.</h2>
          <p>Open the bot, tap START, then Set up GetLeash. About {COST} NEAR, once, from your own wallet.</p>
          <div className="lp-ctas">
            <OpenBot />
            <a className="lp-btn ghost" href="/app">
              Dashboard
            </a>
          </div>
        </section>
      </main>

      <footer className="lp-foot">
        <div className="lp-foot-in">
          <a href="#top" className="lp-brand" aria-label="GetLeash">
            <LeashMark size={22} className="mark" />
            <Wordmark height={18} />
          </a>
          <span className="lp-muted">An AI agent that pays your suppliers under on-chain rules it cannot break.</span>
          <span className="spacer" />
          <a href={BOT_URL} target="_blank" rel="noreferrer">
            Telegram bot
          </a>
          <a href={SOURCE_URL} target="_blank" rel="noreferrer">
            Source code
          </a>
          <span className="lp-muted">© 2026 GetLeash · Built on NEAR</span>
        </div>
      </footer>
    </div>
  );
}
