// Tiny sentiment estimator using a small lexicon
const POS = ['up','gain','gainful','positive','surge','spike','good','increase','rise','support']
const NEG = ['down','drop','loss','negative','fall','decline','risk','volatility','uncertain','surprise']

export function estimateSentiment(text){
  if(!text) return 0
  const t = text.toLowerCase()
  let score = 0
  POS.forEach(w=>{ if(t.includes(w)) score += 1 })
  NEG.forEach(w=>{ if(t.includes(w)) score -= 1 })
  // normalize
  return Math.max(-1, Math.min(1, score/3))
}
