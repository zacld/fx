// Very small, client-side NER-ish utility using heuristics
const politicalKeywords = ['Prime Minister','President','Chancellor','Minister','PM','President','ECB','central bank','Treasury']

export function detectEntities(text){
  if(!text) return []
  const results = new Set()

  // keyword match
  politicalKeywords.forEach(k=>{
    const re = new RegExp(`\\b${escapeRegExp(k)}\\b`, 'i')
    if(re.test(text)) results.add(k)
  })

  // capitalized word sequences (simple proper noun extractor)
  const capMatches = text.match(/([A-Z][a-z]+(?:\\s+[A-Z][a-z]+)*)/g)
  if(capMatches){
    capMatches.forEach(m=>{
      if(m.length>2 && m.split(' ').length<=4) results.add(m)
    })
  }

  return Array.from(results)
}

function escapeRegExp(s){
  return s.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')
}
