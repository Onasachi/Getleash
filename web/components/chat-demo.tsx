"use client";

/**
 * The landing page's phone (Claude Design, landing direction 1b): a GetLeash chat in Telegram, played on a
 * loop. One invoice is within the agent's limits and paid on its own; the next is above them, so it waits,
 * the approval sheet comes up, the owner taps, and it is paid. Every 1.5 s is one step: 0–3 the messages
 * arrive, 4 the sheet comes up, 5 the tap, 6 the sheet goes and the payment is done, 7–8 a pause. With
 * reduced motion it shows the finished chat and stays still. An illustration only: it calls nothing.
 */
import { useEffect, useState } from "react";

import { LeashMark } from "@/components/logo";

type Message = { me?: boolean; file?: string; meta?: string; text?: string; button?: string; at?: number };

const STEPS = 9;
const FINISHED = 7;

export function ChatDemo({ alone }: { alone: string }) {
  const messages: Message[] = [
    { me: true, file: "LF-114.pdf", meta: "Lagos Fabrics · 1.20 USDC" },
    { text: "✅ Paid 1.20 USDC to Lagos Fabrics. It was within your limits, so the agent paid it on its own (payment #11)." },
    { me: true, file: "LF-115.pdf", meta: "Lagos Fabrics · 3.20 USDC" },
    {
      text: `👋 Lagos Fabrics asks for 3.20 USDC. It needs your OK because it is above the ${alone} USDC the agent may pay on its own (payment #14).`,
      button: "Review and approve",
    },
    { text: "✅ Paid 3.20 USDC to Lagos Fabrics (payment #14).", at: 6 },
  ];
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setStep(FINISHED);
      return;
    }
    const timer = setInterval(() => setStep((s) => (s + 1) % STEPS), 1500);
    return () => clearInterval(timer);
  }, []);

  const sheetUp = step === 4 || step === 5;
  const pressed = step === 5;
  return (
    <div
      className="lp-phone"
      role="img"
      aria-label={`A GetLeash chat in Telegram: a 1.20 USDC invoice is paid by the agent on its own; a 3.20 USDC one is above the ${alone} USDC limit, so it waits until the owner approves it in their wallet.`}
    >
      <div className="lp-screen">
        <div className="lp-chat-top">
          <span className="lp-avatar">
            <LeashMark size={28} />
          </span>
          <span className="lp-chat-name">
            <span>GetLeash</span>
            <span>bot</span>
          </span>
        </div>
        <div className="lp-chat">
          {messages.map((m, i) =>
            step >= (m.at ?? i) ? (
              <div key={i} className={m.me ? "lp-msg me" : "lp-msg"}>
                <div className="lp-bubble">
                  {m.file ? (
                    <div className="lp-file">
                      <span className="lp-pdf">PDF</span>
                      <span className="lp-file-name">
                        <span>{m.file}</span>
                        <span>{m.meta}</span>
                      </span>
                    </div>
                  ) : (
                    <span>{m.text}</span>
                  )}
                </div>
                {m.button && <div className="lp-msg-btn">{m.button}</div>}
              </div>
            ) : null,
          )}
        </div>
        <div className={sheetUp ? "lp-sheet up" : "lp-sheet"}>
          <div className="lp-handle" />
          <span className="lp-chip">Needs your OK</span>
          <div className="lp-sheet-title">Pay Lagos Fabrics?</div>
          <div className="lp-sheet-amount">
            3.20 <span>USDC</span>
          </div>
          <div className="lp-sheet-to">
            To · NEAR · Payment #14
            <div>lagosfabrics.near</div>
          </div>
          <div className={pressed ? "lp-sheet-btn pressed" : "lp-sheet-btn"}>{pressed ? "Waiting for your wallet…" : "Approve and pay 3.20 USDC"}</div>
        </div>
      </div>
    </div>
  );
}
