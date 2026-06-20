"use client";

import { Reveal } from "./Reveal";

const steps = [
  {
    title: "Connect your free keys",
    body: "Sign up for the free AI services you want (like Groq or Gemini) and paste your keys in once. They're stored safely on your own device.",
  },
  {
    title: "Ask your question",
    body: "Type a message like you would in any chat app. No need to choose which AI to use — Zintus handles that for you.",
  },
  {
    title: "Get an answer, every time",
    body: "It picks a fast, available AI and replies. If that one is busy or out of free usage, it automatically switches to another — so you're never stuck.",
  },
];

export function HowItWorks() {
  return (
    <section className="m-section" id="how-it-works">
      <div className="m-shell">
        <Reveal>
          <p className="m-eyebrow">Simple as 1, 2, 3</p>
          <h2 className="m-title">How it works</h2>
        </Reveal>
        <div className="m-how-grid">
          {steps.map((step, index) => (
            <Reveal key={step.title} delay={index * 0.08}>
              <article className="m-panel">
                <span className="m-step-index">0{index + 1}</span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
