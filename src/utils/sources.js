// Simulated trending sources (client-side)
export function fetchSimulatedTrends(selectedSources = ['twitter','google']){
  const now = Date.now()
  const samples = []

  if(selectedSources.includes('twitter')){
    samples.push({
      id: `tw-${now}`,
      source: 'Twitter',
      title: 'Break: Major protest in capital city over new tariffs',
      snippet: 'Mass demonstrations in central districts after announcement of new tariffs affecting exporters.',
      score: 0.85
    })
    samples.push({
      id: `tw2-${now}`,
      source: 'Twitter',
      title: 'Rumours of central bank intervention in FX markets',
      snippet: 'Unconfirmed reports claim central bank ready to step in amid rapid currency moves.',
      score: 0.7
    })
  }

  if(selectedSources.includes('google')){
    samples.push({
      id: `gt-${now}`,
      source: 'Google Trends',
      title: 'Search interest spikes for "currency crisis" in region',
      snippet: 'Searches for currency-related queries up 320% in the last hour.',
      score: 0.9
    })
  }

  if(selectedSources.includes('gnews')){
    samples.push({
      id: `gn-${now}`,
      source: 'GNews',
      title: "PM announces surprise elections",
      snippet: 'Prime Minister calls for early elections; markets to react to political uncertainty.',
      score: 0.95
    })
  }

  return samples
}
