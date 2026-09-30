// User-facing legal disclosures for the strategy-studio model. Substance-over-form:
// state plainly that KaiBot is software, that the user decides and executes, and that
// KaiBot is not a broker or adviser. Wire into ToS, onboarding, the bot/strategy UI,
// and any published signal/strategy feed. Confirm final wording with counsel before launch.

export const POSITIONING = {
  oneLiner:
    "KaiBot is a strategy studio: software for building, backtesting and running your own trading strategies. You choose where they execute.",
  notABroker:
    "KaiBot is not a broker, exchange, or portfolio manager. It never holds your funds or API keys, and never places an order for you. Your own executor does that, or a third-party execution service you connect.",
} as const;

// The three disclaimer pillars (how unregulated software/charting tools disclaim).
export const DISCLAIMER = {
  notAdvice:
    "Everything in KaiBot (strategies, indicators, signals, backtests, analytics) is general information for research and education. None of it is investment advice or a recommendation to buy or sell any asset.",
  noLiability:
    "KaiBot accepts no liability for any loss or damage from your use of, or reliance on, the platform or any strategy, indicator, or signal. Trading is risky and you can lose money.",
  userResponsible:
    "You are solely responsible for any strategy you build, configure, rent, or run, and for every order it places on your own account. KaiBot does not decide your trades.",
} as const;

// Bump when the ToS/risk-disclosure text materially changes; the acceptance
// gate re-prompts users whose recorded termsVersion no longer matches.
// Bumped when a disclosure changes materially (re-prompts acceptance). Raised
// for the AI-strategy disclosure (Deel C).
export const TERMS_VERSION = "2026-07-03" as const;

// Machine-readable TRPCError message for a FORBIDDEN thrown by the server-side
// consent guard (missing or stale ToS/risk acceptance). Clients map it to the
// terms re-acceptance flow. Shared so server and clients compare one constant.
export const CONSENT_REQUIRED_MESSAGE = "CONSENT_REQUIRED" as const;

// Publisher Agreement (docs/legal/marketplace-publisher-agreement.md, rendered
// at /publisher-agreement). Separate from TERMS_VERSION: it binds only users who
// publish, so a bump re-prompts publishers without forcing every user through
// the ToS gate again. Bump when the agreement text materially changes.
export const PUBLISHER_TERMS_VERSION = "2026-07-03" as const;

// FORBIDDEN message thrown when a publish is attempted without a current
// publisher-agreement acceptance on record. Clients map it to the publish
// dialog's acceptance checkbox.
export const PUBLISHER_CONSENT_REQUIRED_MESSAGE = "PUBLISHER_CONSENT_REQUIRED" as const;

// MAR / Delegated Reg (EU) 2016/958 disclosure for any strategy or signal published to others.
export const RECOMMENDATION_DISCLOSURE = {
  producer:
    "Published strategies and signals are user-generated. They are the author's own opinion, not KaiBot's, and are not tailored to your situation.",
  objectivity:
    "Past and backtested performance does not predict future results.",
  conflicts:
    "An author may hold positions in the assets their strategy trades. KaiBot charges a flat platform fee and takes no share of your trades or profits.",
  methodology:
    "Most strategy logic is deterministic and runs on your own configuration. Strategies marked AI additionally consult a language model at runtime; those responses are non-deterministic and billed per token to whoever runs the strategy. The methodology and inputs are shown where the strategy is offered.",
} as const;

// Shown wherever an AI strategy is run or bought (Deel C). The AI cost accrues
// to the RUNNING user (a marketplace copy runs under the buyer's plan).
export const AI_STRATEGY_DISCLOSURE = {
  cost:
    "This strategy calls a language model while it runs. Each call is billed per token to your account from your prepaid AI credits, on top of your plan.",
  nondeterministic:
    "Language-model responses are non-deterministic: the same market can produce different decisions. Backtests do not simulate them, so backtest results reflect only the strategy's non-AI logic.",
  buyer:
    "If you copy this strategy from the marketplace it runs under your own plan and AI usage is billed to you, not the author.",
} as const;
