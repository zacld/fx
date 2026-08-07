// Mock LLM paraphraser — client-side templates for different tones
export function paraphraseAlert(trend, entities=[], tone='brief'){
  const context = `${trend.title}. ${trend.snippet}`
  const ents = entities.length ? ` Mentioned: ${entities.join(', ')}.` : ''

  if(tone === 'formal'){
    return `Alert: ${context}${ents} Impact assessment: high. Recommend monitoring FX pairs and liquidity.`
  }

  if(tone === 'investor'){
    return `Heads-up — ${trend.title}: ${trend.snippet} ${ents} Likely near-term FX moves; consider hedging exposure.`
  }

  // brief
  return `${trend.title} — ${trend.snippet}${ents} (simulated)`
}
