// Minimal stand-in for Spotify's token + search endpoints, used to prove the
// resolution path end to end without the person's credentials.
const http = require('node:http')

const port = Number(process.env.MOCK_PORT || 8899)

const TABLE = {
  'heat waves': [
    ['Heat Waves (Sped Up)', 'Glass Animals'],
    ['Heat Waves', 'Glass Animals']
  ],
  bones: [['Bones', 'Imagine Dragons']],
  levitating: [['Levitating', 'Dua Lipa']],
  'sweater weather': [['Sweater Weather', 'The Neighbourhood']],
  sunflower: [
    ['Sunflower - Spider-Man: Into the Spider-Verse', 'Post Malone, Swae Lee'],
    ['Sunflower', 'Post Malone']
  ],
  'no such song': []
}

function id(seed) {
  const clean = String(seed).toLowerCase().replace(/[^a-z0-9]/g, '')
  return (clean + '0123456789abcdefghijkl').slice(0, 22)
}

function items(query) {
  const key = Object.keys(TABLE).find((name) => query.toLowerCase().includes(name))
  const rows = key ? TABLE[key] : [[query, 'Unknown Artist']]
  return rows.map(([name, artist], index) => ({
    uri: `spotify:track:${id(`${index}${key || query}`)}`,
    name,
    artists: artist.split(', ').map((value) => ({ name: value })),
    album: { name: 'Mock Album' },
    duration_ms: 200_000 + index * 1_000
  }))
}

http
  .createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    if (url.pathname === '/token') {
      console.log('TOKEN')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ access_token: 'mock-token', token_type: 'Bearer', expires_in: 3600 }))
      return
    }
    if (url.pathname === '/v1/search') {
      const query = url.searchParams.get('q') || ''
      console.log('SEARCH', JSON.stringify(query))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ tracks: { items: items(query) } }))
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end('{}')
  })
  .listen(port, '127.0.0.1', () => console.log('listening', port))
