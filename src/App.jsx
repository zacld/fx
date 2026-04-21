import React, { useState, useEffect, useRef, useMemo, useCallback, useReducer } from 'react'

const PAIRS = [
  { sym: 'EUR/USD', base: 1.0842, vol: 0.0008 },
  { sym: 'GBP/USD', base: 1.2674, vol: 0.0011 },
  { sym: 'USD/JPY', base: 149.32, vol: 0.18 },
  { sym: 'AUD/USD', base: 0.6588, vol: 0.0009 },
  { sym: 'USD/CAD', base: 1.3621, vol: 0.0007 },
  { sym: 'USD/CHF', base: 0.8804, vol: 0.0006 },
]

const HANDLES = [
  { name: 'Lisa Abramowicz', user: 'lisaabramowicz1' },
  { name: 'Robin Brooks', user: 'robin_j_brooks' },
  { name: 'Jim Bianco', user: 'biancoresearch' },
  { name: 'Mohamed El-Erian', user: 'elerianm' },
  { name: 'Holger Zschaepitz', user: 'schuldensuehner' },
  { name: 'Macro Alf', user: 'macroalf' },
  { name: 'Zerohedge', user: 'zerohedge' },
  { name: 'FXMacro', user: 'fxmacroguy' },
]

const TWEET_TEMPLATES = [
  { text: 'ECB sources hint at faster cuts than markets price. Watch {pair}.', pairs: ['EUR/USD'], sentiment: -0.7 },
  { text: 'BoE inflation print hotter than expected. {pair} bid hard on the open.', pairs: ['GBP/USD'], sentiment: 0.8 },
  { text: 'BoJ intervention chatter intensifying as {pair} pushes 150 handle.', pairs: ['USD/JPY'], sentiment: -0.6 },
  { text: 'Powell pivot? Dot plot revisions could blow {pair} wider.', pairs: ['EUR/USD', 'GBP/USD'], sentiment: 0.5 },
  { text: 'RBA on hold but hawkish tone. {pair} catching a bid.', pairs: ['AUD/USD'], sentiment: 0.6 },
  { text: 'Oil rip + risk-off = {pair} downside. CAD safe haven flows.', pairs: ['USD/CAD'], sentiment: -0.5 },
  { text: 'SNB sight deposits falling — quietly defending {pair}.', pairs: ['USD/CHF'], sentiment: -0.4 },
  { text: 'CFTC positioning shows record euro shorts. Squeeze risk on {pair}.', pairs: ['EUR/USD'], sentiment: 0.7 },
  { text: 'UK retail sales miss massively. {pair} offered into the print.', pairs: ['GBP/USD'], sentiment: -0.7 },
  { text: 'Yen carry unwind accelerating. {pair} could see 145 fast.', pairs: ['USD/JPY'], sentiment: -0.8 },
  { text: 'Iron ore breakout + China stimulus = {pair} bulls in control.', pairs: ['AUD/USD'], sentiment: 0.7 },
  { text: 'Fed minutes lean dovish. Dollar smile fading — {pair} tactical.', pairs: ['EUR/USD', 'GBP/USD', 'AUD/USD'], sentiment: 0.6 },
  { text: 'ECB hawks pushing back. {pair} 1.10 in play this week.', pairs: ['EUR/USD'], sentiment: 0.7 },
  { text: 'BoC done hiking per swap markets. {pair} grinds higher.', pairs: ['USD/CAD'], sentiment: 0.5 },
  { text: 'Geopolitical risk premium flooding back. CHF + JPY safe havens bid.', pairs: ['USD/CHF', 'USD/JPY'], sentiment: -0.5 },
  { text: 'NFP whisper: 280k vs 200k consensus. {pair} setting up for fireworks.', pairs: ['EUR/USD'], sentiment: -0.6 },
]

const NEWS_TEMPLATES = [
  { source: 'Reuters', title: "ECB's Lagarde signals patience on rate cuts amid sticky services inflation", pairs: ['EUR/USD'], sentiment: 0.6 },
  { source: 'Bloomberg', title: "BoJ's Ueda hints intervention 'in scope' if disorderly moves continue", pairs: ['USD/JPY'], sentiment: -0.7 },
  { source: 'FT', title: 'UK wage growth slows sharply, opening door to August BoE cut', pairs: ['GBP/USD'], sentiment: -0.65 },
  { source: 'WSJ', title: 'Fed officials split on timing of first cut, minutes show', pairs: ['EUR/USD', 'GBP/USD'], sentiment: 0.4 },
  { source: 'Reuters', title: 'China announces 1 trillion yuan stimulus package targeting property sector', pairs: ['AUD/USD'], sentiment: 0.7 },
  { source: 'Bloomberg', title: 'Oil surges 4% on OPEC+ extension; CAD outperforms G10', pairs: ['USD/CAD'], sentiment: -0.6 },
  { source: 'Reuters', title: 'SNB intervention data confirms aggressive franc selling in Q1', pairs: ['USD/CHF'], sentiment: 0.5 },
  { source: 'Bloomberg', title: 'US ISM services prints 54.2 vs 51.8 expected; dollar broadly bid', pairs: ['EUR/USD', 'GBP/USD', 'AUD/USD'], sentiment: -0.6 },
  { source: 'FT', title: 'Eurozone PMI surprises to upside as Germany manufacturing turns corner', pairs: ['EUR/USD'], sentiment: 0.7 },
  { source: 'Reuters', title: 'Japan FinMin: "Excessive moves observed, will respond appropriately"', pairs: ['USD/JPY'], sentiment: -0.8 },
  { source: 'Bloomberg', title: 'Aussie jobs data smashes estimates, RBA cut bets pushed to Q4', pairs: ['AUD/USD'], sentiment: 0.75 },
  { source: 'WSJ', title: 'Treasury yields tumble as core PCE undershoots; dollar on back foot', pairs: ['EUR/USD', 'GBP/USD'], sentiment: 0.6 },
]

const GEO_EVENTS = [
  { id: 'g1', title: 'Trump announces 25% tariffs on EU automobile imports', detail: 'White House confirms new trade measures effective in 30 days. Retaliatory EU tariffs on US goods widely expected, escalating bilateral trade tensions.', pairs: ['EUR/USD', 'GBP/USD'], risk: 'Critical', category: 'Trade Policy', icon: '🏛️' },
  { id: 'g2', title: 'Federal Reserve holds rates; Powell signals "higher for longer"', detail: 'FOMC unanimous decision to hold at 5.25–5.50%. Median dot plot revised to one cut in 2024, down from three. Dollar broadly bid on the release.', pairs: ['EUR/USD', 'GBP/USD', 'AUD/USD'], risk: 'High', category: 'Central Bank', icon: '🏦' },
  { id: 'g3', title: 'Bank of England emergency MPC briefing scheduled', detail: 'Unscheduled communications session flagged by HM Treasury. Markets pricing in hawkish surprise ahead of formal release. GBP vol elevated.', pairs: ['GBP/USD'], risk: 'Critical', category: 'Central Bank', icon: '🏦' },
  { id: 'g4', title: "ECB sources: rate cut path 'under review' after German CPI beat", detail: 'Hawkish faction within Governing Council pushing back against June cut consensus. EUR supportive near-term; watch Lagarde press conference for guidance.', pairs: ['EUR/USD'], risk: 'High', category: 'Central Bank', icon: '🏦' },
  { id: 'g5', title: 'UK general election: snap poll shows government lead narrowing sharply', detail: 'Opposition advantage falls to 4pts in YouGov survey — tightest reading this cycle. Political uncertainty elevated; GBP implied volatility premium building.', pairs: ['GBP/USD'], risk: 'Medium', category: 'Election Risk', icon: '🗳️' },
  { id: 'g6', title: 'Trump threatens Iran with "overwhelming force" via Truth Social', detail: 'President posts: "If Iran does not stand down IMMEDIATELY we will have no choice but to respond with OVERWHELMING force. The world is watching." Oil spikes 5%, safe-haven flows surge into JPY and CHF.', pairs: ['USD/JPY', 'USD/CHF', 'USD/CAD'], risk: 'Critical', category: 'Geopolitical', icon: '⚠️' },
  { id: 'g7', title: 'China retaliates with tariffs on $60bn of US agricultural exports', detail: 'Beijing announces targeted measures on soybeans, pork, and dairy. AUD exposed via commodity linkage and China growth sensitivity.', pairs: ['AUD/USD'], risk: 'High', category: 'Trade Policy', icon: '🏛️' },
  { id: 'g8', title: 'BoJ rate decision: holds at 0.1% but language shifts materially', detail: 'Statement drops "accommodative" guidance for first time since 2016. Traders interpreting as preparation for Q3 hike; JPY strengthening on the back of it.', pairs: ['USD/JPY'], risk: 'Medium', category: 'Central Bank', icon: '🏦' },
  { id: 'g9', title: 'NATO summit communiqué flags elevated Russia-Ukraine tension', detail: 'Allies pledge expanded defence support packages. Safe-haven flows into CHF intensifying; EUR briefly under pressure on energy supply concerns.', pairs: ['EUR/USD', 'USD/CHF'], risk: 'Medium', category: 'Geopolitical', icon: '⚠️' },
  { id: 'g10', title: 'US CPI surprise: core inflation 3.8% vs 3.4% expected', detail: 'Hottest print in six months eliminates September cut expectations entirely. Dollar aggressively bid across the board; rate-sensitive crosses moving sharply.', pairs: ['EUR/USD', 'GBP/USD', 'AUD/USD', 'USD/JPY'], risk: 'Critical', category: 'Data Release', icon: '📊' },
]

const TICKER_EVENTS = [
  '🔴  Trump posts Middle East threat — "OVERWHELMING force" — oil +5%, JPY/CHF surge',
  '🔴  Trump announces new 25% tariffs on EU goods — EUR/USD under pressure',
  '🟡  BoE holds rates at 5.25% — GBP steady, markets await vote split details',
  '🔴  US CPI surprise: 3.8% vs 3.4% expected — dollar broadly bid',
  "🟢  ECB's Lagarde: 'disinflation on track' — EUR/USD recovers off lows",
  '🔴  BoJ intervention warning — USD/JPY rejected sharply from 152.00 handle',
  '🟢  China PMI beats consensus — AUD/USD bid, risk-on tone emerging',
  '🟢  UK CPI 2.3% — below BoE forecast, August cut odds jump to 68%',
  '🟡  FOMC minutes: officials divided on timing of first rate cut',
  '🔴  NATO summit escalation warning issued — EUR/CHF volatility spike',
  '🟢  RBA on hold, maintains hawkish tone — AUD/USD bids emerge at 0.6620',
  '🟡  SNB quarterly review: watching CHF "carefully" — floor speculation mounts',
  '🔴  US-China trade war escalation — AUD/USD breaks below 0.6550 support',
  '🟢  Eurozone PMI 52.4 beats — EUR/USD clears 1.0900 resistance',
  '🟡  BoC signals pause extension — USD/CAD range-bound near 1.3600',
]

// ── MOCK CLIENTS ──────────────────────────────────────────────────────────────
const MOCK_CLIENTS = [
  { id: 'c1', name: 'Henderson Manufacturing', initials: 'HM', contact: 'Sarah Chen', role: 'CFO', pair: 'GBP/USD', exposure: '£2.4m', type: 'USD payables', due: 'Q3 2026', hedgedPct: 65, sensitiveDirection: 'down', accentColor: '#3b82f6' },
  { id: 'c2', name: 'Apex Logistics', initials: 'AL', contact: 'James Okafor', role: 'Treasurer', pair: 'EUR/USD', exposure: '€1.1m', type: 'EUR payables', due: 'Rolling', hedgedPct: 20, sensitiveDirection: 'up', accentColor: '#8b5cf6' },
  { id: 'c3', name: 'Meridian Capital', initials: 'MC', contact: 'David Park', role: 'Head of FX', pair: 'USD/JPY', exposure: '$800k', type: 'JPY payables', due: 'Aug 2026', hedgedPct: 0, sensitiveDirection: 'down', accentColor: '#ef4444' },
  { id: 'c4', name: 'Vantage Energy', initials: 'VE', contact: 'Emma Richards', role: 'Finance Director', pair: 'USD/CAD', exposure: '$3.2m', type: 'CAD receivables', due: 'Q4 2026', hedgedPct: 80, sensitiveDirection: 'up', accentColor: '#22c55e' },
  { id: 'c5', name: 'Sterling Imports', initials: 'SI', contact: 'Mark Thompson', role: 'MD', pair: 'EUR/USD', exposure: '€2.8m', type: 'EUR payables', due: 'Dec 2026', hedgedPct: 45, sensitiveDirection: 'up', accentColor: '#f59e0b' },
]

// ── TRIGGER EVENTS ────────────────────────────────────────────────────────────
const TRIGGER_EVENTS = [
  {
    id: 'trump_mideast',
    label: 'Trump — Middle East',
    icon: '📱',
    colorClass: 'trigger-red',
    bannerColor: '#7f1d1d',
    description: 'Trump posts Middle East threat on Truth Social — oil spikes 5%, safe-haven surge into JPY and CHF',
    affectedPairs: ['USD/JPY', 'USD/CHF', 'USD/CAD'],
    sentimentPush: -0.90,
    geoId: 'g6',
    tweets: [
      { text: 'Trump Truth Social: "If Iran does not stand down IMMEDIATELY we will have no choice but to respond with OVERWHELMING force. The world is watching." Full risk-off.', pairs: ['USD/JPY', 'USD/CHF'], sentiment: -0.96 },
      { text: 'Oil +5.2% on Trump Middle East post. Classic safe-haven playbook — JPY and CHF both surging. USD/JPY down 1.1% in minutes.', pairs: ['USD/JPY'], sentiment: -0.93 },
      { text: 'Trump escalation = risk-off. USD/CHF hitting session lows. Gold through $2,400. Every safe haven bid simultaneously.', pairs: ['USD/CHF'], sentiment: -0.91 },
      { text: 'Pentagon says no military orders issued yet but the Trump Truth Social post is all markets need. VIX +18%. Sell everything except JPY and CHF.', pairs: ['USD/JPY', 'USD/CHF'], sentiment: -0.89 },
    ],
    news: [
      { source: 'Reuters', title: 'Trump threatens Iran with "overwhelming force" in Truth Social post; oil surges 5.2%, safe havens rally hard', pairs: ['USD/JPY', 'USD/CHF', 'USD/CAD'], sentiment: -0.95 },
      { source: 'Bloomberg', title: 'Middle East risk premium surges on Trump post — JPY at 6-week high, CHF bid, gold through $2,400', pairs: ['USD/JPY', 'USD/CHF'], sentiment: -0.92 },
    ],
  },
  {
    id: 'trump_tariff',
    label: 'Trump EU Tariffs',
    icon: '🏛️',
    colorClass: 'trigger-orange',
    bannerColor: '#78350f',
    description: 'White House confirms 25% tariffs on all EU goods — EUR/USD in freefall',
    affectedPairs: ['EUR/USD', 'GBP/USD'],
    sentimentPush: -0.90,
    geoId: 'g1',
    tweets: [
      { text: 'BREAKING: White House confirms 25% tariffs on all EU goods effective immediately. EUR/USD in freefall.', pairs: ['EUR/USD'], sentiment: -0.95 },
      { text: 'EUR/USD through 1.08. Full dollar smile in play on tariff shock. Stops being triggered everywhere.', pairs: ['EUR/USD'], sentiment: -0.90 },
      { text: 'GBP/USD dragged lower on EUR contagion. Watch 1.24 support — key level.', pairs: ['GBP/USD'], sentiment: -0.85 },
    ],
    news: [
      { source: 'Reuters', title: 'BREAKING: Trump signs executive order imposing 25% tariffs on all EU imports', pairs: ['EUR/USD', 'GBP/USD'], sentiment: -0.95 },
      { source: 'Bloomberg', title: "EUR/USD drops 1.2% on tariff shock; EU Commission pledges 'strong' retaliation", pairs: ['EUR/USD'], sentiment: -0.92 },
    ],
  },
  {
    id: 'fed_cut',
    label: 'Fed Surprise Cut',
    icon: '🇺🇸',
    colorClass: 'trigger-green',
    bannerColor: '#14532d',
    description: 'Federal Reserve cuts 25bps in surprise inter-meeting move — dollar selling across the board',
    affectedPairs: ['EUR/USD', 'GBP/USD', 'AUD/USD'],
    sentimentPush: 0.90,
    geoId: 'g2',
    tweets: [
      { text: 'BREAKING: Fed cuts 25bps in surprise inter-meeting move. Dollar crashing across the board.', pairs: ['EUR/USD', 'GBP/USD'], sentiment: 0.92 },
      { text: 'EUR/USD through 1.10 on Fed pivot surprise. Massive short squeeze underway.', pairs: ['EUR/USD'], sentiment: 0.90 },
      { text: 'Risk-on erupting everywhere. AUD/USD back above 0.67. Powell capitulates — this changes everything.', pairs: ['AUD/USD'], sentiment: 0.88 },
    ],
    news: [
      { source: 'Bloomberg', title: 'Federal Reserve cuts 25bps in surprise inter-meeting move; dollar slides 1.5%', pairs: ['EUR/USD', 'GBP/USD', 'AUD/USD'], sentiment: 0.93 },
      { source: 'Reuters', title: 'Dollar index falls to 3-month low on Fed surprise; risk assets rally globally', pairs: ['EUR/USD', 'GBP/USD'], sentiment: 0.89 },
    ],
  },
  {
    id: 'boe_emergency',
    label: 'BoE Emergency Cut',
    icon: '🏦',
    colorClass: 'trigger-yellow',
    bannerColor: '#713f12',
    description: 'Bank of England cuts rates 50bps in unscheduled emergency MPC decision — GBP collapses',
    affectedPairs: ['GBP/USD'],
    sentimentPush: -0.88,
    geoId: 'g3',
    tweets: [
      { text: 'BREAKING: BoE cuts 50bps in unscheduled emergency meeting. GBP/USD collapsing — panic selling on the wire.', pairs: ['GBP/USD'], sentiment: -0.93 },
      { text: 'GBP/USD through 1.25 on BoE emergency cut. Stop-loss cascade underway. This is ugly.', pairs: ['GBP/USD'], sentiment: -0.88 },
    ],
    news: [
      { source: 'Bloomberg', title: 'BoE cuts rates 50bps in emergency decision; GBP/USD plunges to 18-month low', pairs: ['GBP/USD'], sentiment: -0.91 },
      { source: 'FT', title: "Bank of England emergency move signals deep concern about UK economic outlook, analysts say", pairs: ['GBP/USD'], sentiment: -0.87 },
    ],
  },
]

// ── INSIDER TRADE SIMULATOR DATA ─────────────────────────────────────────────
const SUSPICIOUS_TRADES = [
  {
    timeLabel: 'T − 14:23',
    instrument: 'USD/JPY Put Options',
    detail: '12,500 contracts · $149.00 strike · DEC expiry',
    notional: '$187m notional',
    volumeNote: '8.4× average daily volume',
    flag: 'UNUSUAL',
    entity: 'Cayman Islands SPV · via Deutsche Bank prime',
    pl: '+$5.1m',
  },
  {
    timeLabel: 'T − 07:51',
    instrument: 'CHF/USD Call Options',
    detail: 'Block trade · 4,200 contracts · 3-month maturity',
    notional: '$340m notional',
    volumeNote: 'Largest single CHF block order since Oct 2019',
    flag: 'UNUSUAL',
    entity: 'Anonymous fund · Zurich correspondent bank',
    pl: '+$3.9m',
  },
  {
    timeLabel: 'T − 02:38',
    instrument: 'Gold (XAU) Futures',
    detail: '45,000 contracts · front month · $2,340 strike',
    notional: '$8.4bn notional',
    volumeNote: 'Open interest +180% in a 3-minute window',
    flag: 'CRITICAL',
    entity: 'Multiple accounts — 9 entities — 4 jurisdictions',
    pl: '+$5.4m',
  },
  {
    timeLabel: 'T − 00:47',
    instrument: 'WTI Crude Calls',
    detail: '$85 strike · 38,000 contracts · near-dated',
    notional: '$920m notional',
    volumeNote: '12.1× average daily volume · 6 separate accounts',
    flag: 'CRITICAL',
    entity: 'British Virgin Islands LLC · UBS Zurich execution',
    pl: '+$2.4m',
  },
]

const MARKET_REACTIONS = [
  { label: 'USD/JPY', before: 149.32, after: 145.09, move: '-2.84%', dir: 'down', decimals: 2 },
  { label: 'USD/CHF', before: 0.8804, after: 0.8661, move: '-1.62%', dir: 'down', decimals: 4 },
  { label: 'Gold (XAU)', before: 2342, after: 2417, move: '+3.21%', dir: 'up', decimals: 0, prefix: '$' },
  { label: 'WTI Crude', before: 82.40, after: 86.63, move: '+5.14%', dir: 'up', decimals: 2, prefix: '$' },
  { label: 'VIX', before: 14.2, after: 22.8, move: '+60.6%', dir: 'up', decimals: 1 },
]

// ── INSIDER SIMULATOR COMPONENT ───────────────────────────────────────────────
function InsiderTradeSimulator({ onClose }) {
  const [phase, setPhase] = useState(0)
  const [visibleTrades, setVisibleTrades] = useState(0)
  const [marketValues, setMarketValues] = useState(MARKET_REACTIONS.map(m => m.before))
  const [scanPct, setScanPct] = useState(0)
  const [showPost, setShowPost] = useState(false)
  const [showAnomalyBanner, setShowAnomalyBanner] = useState(false)
  const [showPnl, setShowPnl] = useState(false)
  const phaseRef = useRef(phase)
  phaseRef.current = phase

  // Phase timeline
  useEffect(() => {
    // Phase 0: scanning
    let scanInterval = setInterval(() => {
      setScanPct(p => {
        if (p >= 100) { clearInterval(scanInterval); return 100 }
        return p + 2.2
      })
    }, 40)
    const timers = []
    // Trades appear one by one
    timers.push(setTimeout(() => { setPhase(1); setVisibleTrades(1) }, 2200))
    timers.push(setTimeout(() => setVisibleTrades(2), 3800))
    timers.push(setTimeout(() => setVisibleTrades(3), 5400))
    timers.push(setTimeout(() => setVisibleTrades(4), 7000))
    // Truth Social post
    timers.push(setTimeout(() => { setPhase(2); setShowPost(true) }, 9000))
    // Market crash
    timers.push(setTimeout(() => setPhase(3), 11200))
    // Anomaly detected banner
    timers.push(setTimeout(() => setShowAnomalyBanner(true), 13500))
    // P&L + summary
    timers.push(setTimeout(() => setShowPnl(true), 15000))
    return () => { clearInterval(scanInterval); timers.forEach(clearTimeout) }
  }, [])

  // Animate market values toward final values when phase >= 3
  useEffect(() => {
    if (phase < 3) return
    const targets = MARKET_REACTIONS.map(m => m.after)
    let frame = 0
    const totalFrames = 80
    const interval = setInterval(() => {
      frame++
      const t = Math.min(frame / totalFrames, 1)
      const ease = 1 - Math.pow(1 - t, 3)
      setMarketValues(MARKET_REACTIONS.map((m, i) => {
        return m.before + (targets[i] - m.before) * ease
      }))
      if (frame >= totalFrames) clearInterval(interval)
    }, 30)
    return () => clearInterval(interval)
  }, [phase])

  return (
    <div className="sim-overlay" onClick={e => e.stopPropagation()}>
      <div className="sim-container">
        {/* Header bar */}
        <div className="sim-header">
          <div className="sim-header-left">
            <div className="sim-cftc-logo">CFTC</div>
            <div>
              <div className="sim-header-title">MARKET SURVEILLANCE TERMINAL</div>
              <div className="sim-header-sub">Division of Market Oversight · Automated Pattern Detection System</div>
            </div>
          </div>
          <div className="sim-header-right">
            <div className="sim-header-date">2026-04-21 · 14:32:07 UTC</div>
            <div className="sim-session-id">SESSION: MST-{Math.random().toString(36).slice(2,8).toUpperCase()}</div>
            <button className="sim-close-btn" onClick={onClose}>✕ CLOSE</button>
          </div>
        </div>

        {/* Scan progress bar */}
        <div className="sim-scan-bar-wrap">
          <div className="sim-scan-label">SCANNING PRE-EVENT ORDER FLOW</div>
          <div className="sim-scan-track">
            <div className="sim-scan-fill" style={{ width: `${scanPct}%` }} />
          </div>
          <div className="sim-scan-pct">{Math.round(scanPct)}%</div>
        </div>

        <div className="sim-body">
          {/* Left: suspicious trades */}
          <div className="sim-left">
            <div className="sim-section-title">
              <span className="sim-section-icon">⚠</span> PRE-EVENT POSITIONS DETECTED
            </div>
            <div className="sim-trades-list">
              {SUSPICIOUS_TRADES.map((tr, i) => (
                <div
                  key={i}
                  className={`sim-trade ${i < visibleTrades ? 'sim-trade-visible' : ''} sim-trade-flag-${tr.flag.toLowerCase()}`}
                >
                  <div className="sim-trade-top">
                    <div className="sim-trade-time">{tr.timeLabel}</div>
                    <div className={`sim-flag sim-flag-${tr.flag.toLowerCase()}`}>{tr.flag}</div>
                  </div>
                  <div className="sim-trade-instrument">{tr.instrument}</div>
                  <div className="sim-trade-detail">{tr.detail}</div>
                  <div className="sim-trade-row">
                    <span className="sim-notional">{tr.notional}</span>
                    <span className="sim-volume-note">{tr.volumeNote}</span>
                  </div>
                  <div className="sim-trade-entity">📍 {tr.entity}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Center: Truth Social post + market reaction */}
          <div className="sim-center">
            <div className="sim-section-title">
              <span className="sim-section-icon">📡</span> CATALYST EVENT
            </div>
            <div className={`sim-post-wrap ${showPost ? 'sim-post-visible' : ''}`}>
              <div className="sim-post-platform">
                <div className="sim-ts-logo">Truth Social</div>
                <div className="sim-ts-time">Posted 14:17:44 UTC</div>
              </div>
              <div className="sim-ts-card">
                <div className="sim-ts-header">
                  <div className="sim-ts-avatar">DJT</div>
                  <div>
                    <div className="sim-ts-name">Donald J. Trump</div>
                    <div className="sim-ts-handle">@realDonaldTrump · ✔ Verified</div>
                  </div>
                </div>
                <div className="sim-ts-body">
                  If Iran does not stand down IMMEDIATELY we will have no choice but to respond with <strong>OVERWHELMING force.</strong> The world is watching. Nobody plays games with the United States of America. GOD BLESS AMERICA! 🇺🇸
                </div>
                <div className="sim-ts-meta">
                  <span>❤ 412,803</span>
                  <span>🔁 188,291</span>
                  <span>💬 97,442</span>
                </div>
              </div>
              <div className={`sim-price-crash ${phase >= 3 ? 'sim-price-crash-active' : ''}`}>
                <div className="sim-crash-title">MARKET REACTION — LIVE</div>
                <div className="sim-markets-grid">
                  {MARKET_REACTIONS.map((m, i) => {
                    const val = marketValues[i]
                    const moved = phase >= 3
                    return (
                      <div key={m.label} className={`sim-market-row ${moved ? (m.dir === 'up' ? 'sim-market-up' : 'sim-market-down') : ''}`}>
                        <span className="sim-market-label">{m.label}</span>
                        <span className="sim-market-price">
                          {m.prefix || ''}{val.toFixed(m.decimals)}
                        </span>
                        <span className={`sim-market-move ${m.dir === 'up' ? 'sim-move-up' : 'sim-move-down'}`}>
                          {moved ? m.move : '—'}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* Right: anomaly + P&L */}
          <div className="sim-right">
            <div className="sim-section-title">
              <span className="sim-section-icon">🔍</span> PATTERN ANALYSIS
            </div>
            <div className={`sim-anomaly-banner ${showAnomalyBanner ? 'sim-anomaly-visible' : ''}`}>
              <div className="sim-anomaly-icon">⚠</div>
              <div className="sim-anomaly-text">ANOMALY DETECTED</div>
              <div className="sim-anomaly-sub">POTENTIAL INSIDER ACTIVITY</div>
              <div className="sim-anomaly-case">CASE REF: MSO-2026-0421-{Math.floor(Math.random()*9000+1000)}</div>
            </div>
            <div className={`sim-pnl-section ${showPnl ? 'sim-pnl-visible' : ''}`}>
              <div className="sim-pnl-title">ESTIMATED P&amp;L ON PRE-POSITIONED TRADES</div>
              {SUSPICIOUS_TRADES.map((tr, i) => (
                <div key={i} className="sim-pnl-row">
                  <span className="sim-pnl-instrument">{tr.instrument.split(' ').slice(0,2).join(' ')}</span>
                  <span className="sim-pnl-val">{tr.pl}</span>
                </div>
              ))}
              <div className="sim-pnl-total-row">
                <span>TOTAL ESTIMATED GAIN</span>
                <span className="sim-pnl-total">+$16.8m</span>
              </div>
              <div className="sim-pnl-window">Window: T−14:23 → T+00:00 · 14 min 23 sec</div>
            </div>
            <div className={`sim-analysis ${showPnl ? 'sim-analysis-visible' : ''}`}>
              <div className="sim-analysis-title">ANALYST SUMMARY</div>
              <div className="sim-analysis-body">
                Four separate instrument positions opened across multiple entities and jurisdictions within a 15-minute window prior to the catalyst event. Combined notional exceeds $9.8bn. Volume anomalies in USD/JPY puts and WTI calls are statistically consistent with foreknowledge of a market-moving event (p &lt; 0.0001). Referred to DOJ Financial Crimes Unit and FCA.
              </div>
              <div className="sim-analysis-flags">
                <span className="sim-a-flag">Multi-jurisdiction</span>
                <span className="sim-a-flag">Coordinated timing</span>
                <span className="sim-a-flag">Volume anomaly</span>
                <span className="sim-a-flag">SPV structures</span>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="sim-footer">
          <span className="sim-footer-warn">⚠ THIS IS A DEMONSTRATION — ALL DATA IS SYNTHETIC AND FOR ILLUSTRATIVE PURPOSES ONLY</span>
          <button className="sim-dismiss-btn" onClick={onClose}>CLOSE SIMULATION</button>
        </div>
      </div>
    </div>
  )
}

// ── WHATSAPP ──────────────────────────────────────────────────────────────────
function buildClientMsg(client, prices, activeEvent) {
  const px = prices[client.pair]
  const base = PAIRS.find(p => p.sym === client.pair)?.base || 1
  const pct = px ? ((px.price - base) / base * 100) : 0
  const absPct = Math.abs(pct).toFixed(2)
  const isBadMove = client.sensitiveDirection === 'down' ? pct < 0 : pct > 0
  const eventCtx = activeEvent && activeEvent.affectedPairs.includes(client.pair)
    ? `following ${activeEvent.description}`
    : 'given current market volatility'
  const unhedgedPct = 100 - client.hedgedPct
  return `Hi ${client.contact},

I wanted to reach out urgently regarding ${client.name}'s ${client.type} position.

${client.pair} ${isBadMove ? 'has moved adversely' : 'is showing elevated volatility'} ${eventCtx}${parseFloat(absPct) > 0.1 ? ` — ${absPct}% move in the last session` : ''}.

With your ${client.exposure} ${client.type} due ${client.due} and a current hedge ratio of ${client.hedgedPct}%, approximately ${unhedgedPct}% of your exposure remains unprotected. ${client.hedgedPct < 40 ? "I'd strongly recommend we discuss increasing your hedge cover today." : "I'd like to discuss whether your current hedge level remains appropriate."}

We can look at extending your forward cover, adding a vanilla option, or a structured solution to match your risk appetite. Available for a call any time today.

Best regards,
Universal Partners FX · Canary Wharf, London`
}

const GENERIC_WA = {
  bull: (pair) => `Hi [Client Name],

Timely update on ${pair} — our platform is flagging a constructive outlook. If you have upcoming payables or cross-currency exposure, this may be an opportune window to act before further moves develop.

We can look at a spot transaction, a forward contract, or a structured option.

Available for a call today.

Best regards,
Universal Partners FX · Canary Wharf, London`,
  bear: (pair) => `Hi [Client Name],

Quick heads-up on ${pair} — our platform is flagging downside risk. If you have receivables or hedges due for review, now may be the right moment for a conversation.

We can look at forward contracts or a vanilla option to protect your position.

Available at short notice.

Best regards,
Universal Partners FX · Canary Wharf, London`,
  warn: (pair) => `Hi [Client Name],

A brief note on ${pair}: conditions are mixed. A good moment to review your current hedging programme before conditions shift.

Available for a call today.

Best regards,
Universal Partners FX · Canary Wharf, London`,
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function rand(arr) { return arr[Math.floor(Math.random() * arr.length)] }
function timeAgo(ms) {
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h`
}
function makeTweet(template) {
  const t = template || rand(TWEET_TEMPLATES)
  const pair = rand(t.pairs)
  const handle = rand(HANDLES)
  return {
    id: Math.random().toString(36).slice(2), ts: Date.now(),
    handle: template ? '⚡ Breaking FX' : handle.name,
    user: template ? 'breakingfx' : handle.user,
    text: t.text.includes('{pair}') ? t.text.replace('{pair}', pair) : t.text,
    pairs: t.pairs, sentiment: t.sentiment + (Math.random() - 0.5) * 0.05,
    breaking: !!template,
  }
}
function makeNews(template) {
  const n = template || rand(NEWS_TEMPLATES)
  return {
    id: Math.random().toString(36).slice(2), ts: Date.now(),
    source: n.source, title: n.title, pairs: n.pairs,
    sentiment: n.sentiment + (Math.random() - 0.5) * 0.05,
    breaking: !!template,
  }
}
function sentimentTag(s) {
  if (s > 0.3) return { cls: 'bull', label: `▲ Bullish ${(s * 100).toFixed(0)}` }
  if (s < -0.3) return { cls: 'bear', label: `▼ Bearish ${(Math.abs(s) * 100).toFixed(0)}` }
  return { cls: 'neutral', label: '◆ Neutral' }
}
function generateInsight(pair, sentiment, sourceCount) {
  const abs = Math.abs(sentiment)
  const conf = Math.min(99, Math.round(40 + abs * 50 + sourceCount * 2))
  if (abs < 0.25) return { kind: 'warn', pair, conf, body: `Mixed signals across ${sourceCount} sources on ${pair}. An opportune moment to review whether your hedging programme is appropriately positioned.`, action: "Uncertain conditions — review your hedging strategy with your UP FX advisor" }
  if (sentiment > 0) {
    const bodies = { 'GBP/USD': `${sourceCount} sources signalling GBP strength. Businesses with USD payables should consider acting ahead of further moves.`, 'EUR/USD': `${sourceCount} sources constructive on EUR/USD. EUR demand building on ECB hawkish repricing. EUR payables clients should review urgently.`, 'AUD/USD': `${sourceCount} sources flagging AUD strength on China and commodity tailwinds. Consider locking in ahead of continuation.` }
    const actions = { 'GBP/USD': "Consider locking in today's rate via a forward contract to protect USD payables", 'EUR/USD': "Review EUR hedging strategy — current rates may be attractive for 3–6 month forwards", 'AUD/USD': "Favourable window for AUD forward contracts — contact your UP FX advisor today" }
    return { kind: 'bull', pair, conf, body: bodies[pair] || `${sourceCount} sources constructive on ${pair}. Review open FX exposure ahead of next session.`, action: actions[pair] || "Speak to your UP FX advisor about forward cover at current levels" }
  }
  const bodies = { 'GBP/USD': `${sourceCount} sources flagging downside pressure on GBP/USD. Businesses with GBP receipts should consider protecting current levels.`, 'EUR/USD': `${sourceCount} sources pointing to EUR/USD weakness. Elevated volatility expected ahead of next ECB decision — review your hedging strategy.`, 'USD/JPY': `${sourceCount} sources signalling JPY strength risk. BoJ intervention threat live above 150. Reduce unhedged JPY payables now.`, 'USD/CHF': `${sourceCount} sources flagging CHF safe-haven demand. Middle East risk premium lifting CHF — review CHF exposure urgently.` }
  const actions = { 'GBP/USD': "GBP/USD facing downside — businesses with USD payables should consider locking in today's rate", 'EUR/USD': "EUR/USD volatility elevated — review your hedging strategy before the next ECB decision", 'USD/JPY': "USD/JPY intervention risk elevated — consider reducing unhedged JPY payables", 'USD/CHF': "CHF safe-haven demand elevated — review CHF exposure ahead of further geopolitical developments" }
  return { kind: 'bear', pair, conf, body: bodies[pair] || `${sourceCount} sources flagging downside catalysts on ${pair}. Unhedged exposure should be reviewed.`, action: actions[pair] || "Consider a forward contract to protect against further downside — speak to your advisor" }
}
function getClientStatus(client, prices) {
  const px = prices[client.pair]; if (!px) return 'ok'
  const base = PAIRS.find(p => p.sym === client.pair)?.base || 1
  const pct = ((px.price - base) / base) * 100
  const sentiment = px.sentiment || 0
  const isBadMove = client.sensitiveDirection === 'down' ? pct < -0.25 : pct > 0.25
  const isBadSentiment = client.sensitiveDirection === 'down' ? sentiment < -0.55 : sentiment > 0.55
  if ((isBadMove && client.hedgedPct < 60) || (isBadSentiment && client.hedgedPct < 30)) return 'urgent'
  if (isBadMove || isBadSentiment) return 'call'
  return 'ok'
}

// ── COMPONENTS ────────────────────────────────────────────────────────────────
function RiskBadge({ level }) {
  const cls = { Critical: 'risk-critical', High: 'risk-high', Medium: 'risk-medium', Low: 'risk-low' }
  return <span className={`risk-badge ${cls[level] || ''}`}>{level}</span>
}

function Sparkline({ data, width = 64, height = 22 }) {
  if (!data || data.length < 2) return null
  const min = Math.min(...data), max = Math.max(...data)
  const range = max - min || 0.0001
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * width},${height - ((v - min) / range) * (height - 2) - 1}`).join(' ')
  return (
    <svg width={width} height={height} style={{ display: 'block', overflow: 'visible' }}>
      <polyline points={pts} fill="none" stroke={data[data.length - 1] >= data[0] ? 'var(--bull)' : 'var(--bear)'} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

function WAModal({ message, title, subtitle, onClose }) {
  const [sent, setSent] = useState(false)
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="whatsapp-icon">
            <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 0C5.373 0 0 5.373 0 12c0 2.123.554 4.116 1.526 5.847L.057 23.882l6.185-1.622A11.94 11.94 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.818a9.818 9.818 0 01-5.003-1.371l-.358-.213-3.713.974.99-3.614-.234-.371A9.818 9.818 0 1112 21.818z"/></svg>
          </div>
          <div style={{ flex: 1 }}><div className="modal-title">{title}</div><div className="modal-sub">{subtitle}</div></div>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="whatsapp-preview">
          <div className="wa-chat-header">
            <div className="wa-avatar">C</div>
            <div><div className="wa-name">Client</div><div className="wa-status">● online</div></div>
          </div>
          <div className="wa-messages">
            {sent ? <div className="wa-sent-confirm"><span>✓</span> Alert sent successfully</div> : (
              <div className="wa-bubble">
                {message.split('\n').map((line, i, arr) => <React.Fragment key={i}>{line}{i < arr.length - 1 && <br />}</React.Fragment>)}
                <div className="wa-time">{new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} ✓✓</div>
              </div>
            )}
          </div>
        </div>
        {!sent && (
          <div className="modal-actions">
            <button className="btn-wa-send" onClick={() => { setSent(true); setTimeout(onClose, 1800) }}>
              <svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
              Send Alert
            </button>
            <button className="btn-wa-cancel" onClick={onClose}>Cancel</button>
          </div>
        )}
      </div>
    </div>
  )
}

function GeoPanel({ activeGeoIds, onToggle, flashId }) {
  const [visibleCount, setVisibleCount] = useState(5)
  return (
    <section className="panel panel-geo">
      <div className="panel-head">
        <div><span className="panel-icon">🌍</span><span className="panel-title">Geopolitical Alerts</span></div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><span className="dot" style={{ width: 6, height: 6 }} /><span className="panel-count">Live monitoring</span></div>
      </div>
      <div className="feed">
        {GEO_EVENTS.slice(0, visibleCount).map(ev => (
          <div key={ev.id} className={`geo-event risk-border-${ev.risk.toLowerCase()} ${flashId === ev.id ? 'geo-flash' : ''} ${activeGeoIds.has(ev.id) ? 'geo-expanded' : ''}`} onClick={() => onToggle(ev.id)} style={{ cursor: 'pointer' }}>
            <div className="geo-head">
              <span className="geo-icon">{ev.icon}</span>
              <div className="geo-meta"><div className="geo-category">{ev.category}</div><div className="geo-title">{ev.title}</div></div>
              <RiskBadge level={ev.risk} />
            </div>
            {activeGeoIds.has(ev.id) && (
              <div className="geo-detail">
                <div className="geo-detail-text">{ev.detail}</div>
                <div className="geo-pairs"><span className="geo-pairs-label">Affected pairs:</span>{ev.pairs.map(p => <span key={p} className="tag" style={{ marginLeft: 4 }}>{p}</span>)}</div>
              </div>
            )}
          </div>
        ))}
        {visibleCount < GEO_EVENTS.length && <button className="btn btn-load-more" onClick={e => { e.stopPropagation(); setVisibleCount(v => Math.min(v + 3, GEO_EVENTS.length)) }}>Show more alerts</button>}
      </div>
    </section>
  )
}

function Ticker() {
  const items = [...TICKER_EVENTS, ...TICKER_EVENTS]
  return (
    <div className="ticker-wrap">
      <div className="ticker-label">LIVE</div>
      <div className="ticker-track-wrap"><div className="ticker-track">{items.map((ev, i) => <span key={i} className="ticker-item">{ev}<span className="ticker-sep">  ◆  </span></span>)}</div></div>
    </div>
  )
}

function ClientBookPanel({ prices, activeEvent, onSendAlert }) {
  const statuses = useMemo(() => Object.fromEntries(MOCK_CLIENTS.map(c => [c.id, getClientStatus(c, prices)])), [prices])
  const urgentCount = Object.values(statuses).filter(s => s === 'urgent').length
  const callCount = Object.values(statuses).filter(s => s === 'call').length
  return (
    <section className="panel client-book-panel">
      <div className="panel-head">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="panel-icon">👥</span><span className="panel-title">Client Book</span>
          {urgentCount > 0 && <span className="cb-badge cb-urgent">{urgentCount} urgent</span>}
          {callCount > 0 && <span className="cb-badge cb-call">{callCount} to call</span>}
        </div>
        <span className="panel-count">Live exposure monitoring</span>
      </div>
      <div className="client-cards">
        {MOCK_CLIENTS.map(client => {
          const status = statuses[client.id]
          const px = prices[client.pair]
          const base = PAIRS.find(p => p.sym === client.pair)?.base || 1
          const pct = px ? ((px.price - base) / base * 100) : 0
          const isBadMove = client.sensitiveDirection === 'down' ? pct < 0 : pct > 0
          return (
            <div key={client.id} className={`client-card status-${status}`}>
              <div className="client-card-top">
                <div className="client-avatar" style={{ background: client.accentColor }}>{client.initials}</div>
                <div className="client-info">
                  <div className="client-name">{client.name}</div>
                  <div className="client-contact">{client.contact} · {client.role}</div>
                </div>
                <div className={`status-pill pill-${status}`}>
                  {status === 'urgent' ? '🔴 URGENT' : status === 'call' ? '🟡 CALL' : '🟢 STABLE'}
                </div>
              </div>
              <div className="client-exposure-row">
                <span className="client-pair-tag">{client.pair}</span>
                <span className="client-exp">{client.exposure} {client.type}</span>
                <span className="client-due">Due {client.due}</span>
              </div>
              <div className="hedge-bar-wrap">
                <div className="hedge-bar-fill" style={{ width: `${client.hedgedPct}%`, background: client.accentColor }} />
                <span className="hedge-label">{client.hedgedPct}% hedged</span>
              </div>
              {status !== 'ok' && (
                <div className="client-alert-msg">
                  {isBadMove ? `${client.pair} moving adversely — ${client.exposure} ${client.type} at risk` : `Sentiment deteriorating on ${client.pair} — review recommended`}
                </div>
              )}
              <button className="btn-whatsapp" style={{ marginTop: 8 }} onClick={() => onSendAlert(client)}>
                <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 0C5.373 0 0 5.373 0 12c0 2.123.554 4.116 1.526 5.847L.057 23.882l6.185-1.622A11.94 11.94 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.818a9.818 9.818 0 01-5.003-1.371l-.358-.213-3.713.974.99-3.614-.234-.371A9.818 9.818 0 1112 21.818z"/></svg>
                Send Alert
              </button>
            </div>
          )
        })}
      </div>
    </section>
  )
}

// ── MAIN APP ──────────────────────────────────────────────────────────────────
export default function App() {
  const [tweets, setTweets] = useState([])
  const [news, setNews] = useState([])
  const [prices, setPrices] = useState(() =>
    Object.fromEntries(PAIRS.map(p => [p.sym, { price: p.base, prev: p.base, sentiment: 0, history: [p.base] }]))
  )
  const [filter, setFilter] = useState('ALL')
  const [activeGeoIds, setActiveGeoIds] = useState(new Set())
  const [geoFlashId, setGeoFlashId] = useState(null)
  const [activeEvent, setActiveEvent] = useState(null)
  const [waModal, setWaModal] = useState(null)
  const [showSimulator, setShowSimulator] = useState(false)

  useEffect(() => {
    const st = Array.from({ length: 6 }, () => { const t = makeTweet(); t.ts = Date.now() - Math.random() * 180000; return t })
    setTweets(st)
    const sn = Array.from({ length: 4 }, () => { const n = makeNews(); n.ts = Date.now() - Math.random() * 300000; return n })
    setNews(sn)
    const ti = setInterval(() => setTweets(prev => [makeTweet(), ...prev].slice(0, 40)), 2200)
    const ni = setInterval(() => setNews(prev => [makeNews(), ...prev].slice(0, 25)), 5500)
    return () => { clearInterval(ti); clearInterval(ni) }
  }, [])

  useEffect(() => {
    const int = setInterval(() => {
      setPrices(prev => {
        const next = { ...prev }
        for (const p of PAIRS) {
          const drift = (Math.random() - 0.5) * p.vol * 0.6
          const sentDrift = (next[p.sym].sentiment || 0) * p.vol * 0.4
          const newPrice = next[p.sym].price + drift + sentDrift
          next[p.sym] = { ...next[p.sym], prev: next[p.sym].price, price: newPrice, history: [...(next[p.sym].history || [p.base]), newPrice].slice(-40) }
        }
        return next
      })
    }, 900)
    return () => clearInterval(int)
  }, [])

  useEffect(() => {
    setPrices(prev => {
      const next = { ...prev }
      for (const p of PAIRS) {
        const recent = [
          ...tweets.filter(t => t.pairs.includes(p.sym)).slice(0, 8),
          ...news.filter(n => n.pairs.includes(p.sym)).slice(0, 5).map(n => ({ ...n, sentiment: n.sentiment * 1.4 })),
        ]
        if (!recent.length) continue
        next[p.sym] = { ...next[p.sym], sentiment: recent.reduce((a, x) => a + x.sentiment, 0) / recent.length, sources: recent.length }
      }
      return next
    })
  }, [tweets, news])

  useEffect(() => {
    const int = setInterval(() => {
      const ev = GEO_EVENTS[Math.floor(Math.random() * GEO_EVENTS.length)]
      setGeoFlashId(ev.id); setTimeout(() => setGeoFlashId(null), 1800)
    }, 9000)
    return () => clearInterval(int)
  }, [])

  const insights = useMemo(() =>
    PAIRS.map(p => {
      const s = prices[p.sym].sentiment || 0, c = prices[p.sym].sources || 0
      return c < 2 ? null : generateInsight(p.sym, s, c)
    }).filter(Boolean).sort((a, b) => b.conf - a.conf).slice(0, 5),
    [prices]
  )

  const toggleGeo = useCallback((id) => {
    setActiveGeoIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }, [])

  function fireEvent(ev) {
    setTweets(prev => [...ev.tweets.map(t => makeTweet(t)), ...prev].slice(0, 40))
    setNews(prev => [...ev.news.map(n => makeNews(n)), ...prev].slice(0, 25))
    setPrices(prev => {
      const next = { ...prev }
      ev.affectedPairs.forEach(pair => {
        if (next[pair]) next[pair] = { ...next[pair], sentiment: ev.sentimentPush, sources: (next[pair].sources || 0) + 6 }
      })
      return next
    })
    setGeoFlashId(ev.geoId)
    setActiveGeoIds(prev => new Set([...prev, ev.geoId]))
    setTimeout(() => setGeoFlashId(null), 2000)
    setActiveEvent(ev)
    setTimeout(() => setActiveEvent(null), 35000)
  }

  const filteredTweets = filter === 'ALL' ? tweets : tweets.filter(t => t.pairs.includes(filter))
  const filteredNews = filter === 'ALL' ? news : news.filter(n => n.pairs.includes(filter))

  return (
    <div className="app">
      <Ticker />

      <header className="header">
        <div className="brand">
          <div className="logo"><span className="logo-text">UP</span></div>
          <div>
            <div className="brand-title">UP FX INTELLIGENCE</div>
            <div className="brand-sub">Universal Partners FX · Real-time market intelligence platform</div>
          </div>
        </div>
        <div className="header-right">
          <div className="live"><span className="dot" />LIVE · {tweets.length + news.length} signals monitored</div>
          <div className="header-badge">Canary Wharf, London</div>
        </div>
      </header>

      <div className="pairs">
        {PAIRS.map(p => {
          const px = prices[p.sym]
          const pct = ((px.price - p.base) / p.base) * 100
          const sent = px.sentiment || 0
          return (
            <div key={p.sym} className={`pair ${filter === p.sym ? 'pair-active' : ''}`} onClick={() => setFilter(filter === p.sym ? 'ALL' : p.sym)} style={{ cursor: 'pointer' }}>
              <div className="pair-row">
                <span className="pair-name">{p.sym}</span>
                <span className="pair-price">{px.price.toFixed(p.sym.includes('JPY') ? 2 : 4)}</span>
              </div>
              <div className="pair-meta">
                <span className={`delta ${pct >= 0 ? 'up' : 'down'}`}>{pct >= 0 ? '+' : ''}{pct.toFixed(2)}%</span>
                <Sparkline data={px.history} />
              </div>
              <div className="bar-wrap">
                <div className="bar-mid" />
                <div className={`bar ${sent >= 0 ? 'up' : 'down'}`} style={{ width: `${Math.min(50, Math.abs(sent) * 50)}%` }} />
              </div>
            </div>
          )
        })}
      </div>

      <div className="controls">
        <button className={`btn ${filter === 'ALL' ? 'active' : ''}`} onClick={() => setFilter('ALL')}>All Pairs</button>
        {PAIRS.map(p => <button key={p.sym} className={`btn ${filter === p.sym ? 'active' : ''}`} onClick={() => setFilter(p.sym)}>{p.sym}</button>)}
      </div>

      <div className="trigger-row">
        <span className="trigger-label">SIMULATE</span>
        {TRIGGER_EVENTS.map(ev => (
          <button
            key={ev.id}
            className={`trigger-btn ${ev.colorClass} ${ev.id === 'trump_mideast' ? 'trigger-btn-simulator' : ''}`}
            onClick={() => {
              fireEvent(ev)
              if (ev.id === 'trump_mideast') setShowSimulator(true)
            }}
          >
            {ev.icon} {ev.label}
            {ev.id === 'trump_mideast' && <span className="trigger-sim-badge">INSIDER SIM</span>}
          </button>
        ))}
      </div>

      {activeEvent && (
        <div className="event-banner" style={{ background: activeEvent.bannerColor }}>
          <span className="event-banner-dot" />
          <strong>LIVE EVENT</strong>&nbsp;·&nbsp;{activeEvent.description}
          <button className="event-banner-close" onClick={() => setActiveEvent(null)}>✕</button>
        </div>
      )}

      <div className="grid">
        <section className="panel">
          <div className="panel-head">
            <div><span className="panel-icon">𝕏</span><span className="panel-title">Social Stream</span></div>
            <span className="panel-count">{filteredTweets.length} signals</span>
          </div>
          <div className="feed">
            {filteredTweets.map(t => {
              const tag = sentimentTag(t.sentiment)
              return (
                <div className={`tweet ${t.breaking ? 'tweet-breaking' : ''}`} key={t.id}>
                  <div className="tweet-head">
                    <div className="avatar" style={t.breaking ? { background: 'var(--bear)' } : {}}>{t.breaking ? '⚡' : t.handle.split(' ').map(s => s[0]).join('').slice(0, 2)}</div>
                    <span className="handle">{t.handle}</span>
                    <span className="username">@{t.user}</span>
                    <span className="time">{timeAgo(t.ts)}</span>
                  </div>
                  <div className="tweet-text">{t.text}</div>
                  <div className="tweet-tags">
                    {t.pairs.map(p => <span key={p} className="tag">{p}</span>)}
                    <span className={`tag ${tag.cls}`}>{tag.label}</span>
                  </div>
                </div>
              )
            })}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <div><span className="panel-icon">📰</span><span className="panel-title">News Wire</span></div>
            <span className="panel-count">{filteredNews.length} stories</span>
          </div>
          <div className="feed">
            {filteredNews.map(n => {
              const tag = sentimentTag(n.sentiment)
              return (
                <div className={`news ${n.breaking ? 'news-breaking' : ''}`} key={n.id}>
                  <div className="news-source">{n.source} · {timeAgo(n.ts)} ago{n.breaking && <span className="breaking-tag"> BREAKING</span>}</div>
                  <div className="news-title">{n.title}</div>
                  <div className="news-meta">
                    {n.pairs.map(p => <span key={p} className="tag">{p}</span>)}
                    <span className={`tag ${tag.cls}`}>{tag.label}</span>
                  </div>
                </div>
              )
            })}
          </div>
        </section>

        <section className="panel col-insights">
          <div className="panel-head">
            <div><span className="panel-icon">💼</span><span className="panel-title">Client Insights</span></div>
            <span className="panel-count">UP FX Advisory</span>
          </div>
          <div className="feed">
            {insights.length === 0 && <div style={{ color: 'var(--muted)', fontSize: 13 }}>Aggregating signals…</div>}
            {insights.map((i, idx) => (
              <div className={`insight ${i.kind}`} key={`${i.pair}-${idx}`}>
                <div className="insight-head">
                  <span className="insight-pair">{i.pair}</span>
                  <span className="insight-conf">Signal strength {i.conf}%</span>
                </div>
                <div className="insight-body">{i.body}</div>
                <div className={`insight-action ${i.kind}`}>{i.action}</div>
                <button className="btn-whatsapp" onClick={() => setWaModal({ message: GENERIC_WA[i.kind]?.(i.pair) || GENERIC_WA.warn(i.pair), title: 'Send Client Alert', subtitle: `${i.pair} advisory · via WhatsApp` })}>
                  <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 0C5.373 0 0 5.373 0 12c0 2.123.554 4.116 1.526 5.847L.057 23.882l6.185-1.622A11.94 11.94 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.818a9.818 9.818 0 01-5.003-1.371l-.358-.213-3.713.974.99-3.614-.234-.371A9.818 9.818 0 1112 21.818z"/></svg>
                  Send Client Alert
                </button>
              </div>
            ))}
          </div>
        </section>

        <GeoPanel activeGeoIds={activeGeoIds} onToggle={toggleGeo} flashId={geoFlashId} />
      </div>

      <ClientBookPanel
        prices={prices}
        activeEvent={activeEvent}
        onSendAlert={client => setWaModal({
          message: buildClientMsg(client, prices, activeEvent),
          title: `Alert: ${client.name}`,
          subtitle: `${client.contact} · ${client.pair} · via WhatsApp`,
        })}
      />

      <div className="footer">Simulated demo · All data synthetic · Universal Partners FX · Canary Wharf, London</div>

      {waModal && <WAModal message={waModal.message} title={waModal.title} subtitle={waModal.subtitle} onClose={() => setWaModal(null)} />}
      {showSimulator && <InsiderTradeSimulator onClose={() => setShowSimulator(false)} />}
    </div>
  )
}
