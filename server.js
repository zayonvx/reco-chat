import express from 'express'
import crypto from 'crypto'
import http from 'http'
import { WebSocketServer } from 'ws'

const app = express()
app.disable('x-powered-by')
app.use(express.json())
app.use(express.static('public'))

const meetings = new Map()
const tokens = new Map()
const roomPeers = new Map()
const sockets = new WeakMap()

const HOST = process.env.HOST || ''
const TOKEN_WINDOW_MS = 5 * 60 * 1000
const MEETING_TTL_MS = 2 * 60 * 60 * 1000
const MAX_PARTICIPANTS = Number(process.env.MAX_PARTICIPANTS || 3)
const ADMIN_SECRET = process.env.ADMIN_SECRET || ''
const PORT = process.env.PORT || 3000

const rid = (n = 16) => crypto.randomBytes(n).toString('base64url')
const newRoom = () => 'r-' + crypto.randomBytes(8).toString('hex')

function ensureAdmin(req, res) {
    if (!ADMIN_SECRET) return res.status(501).send('ADMIN_SECRET not configured')
    const hdr = req.headers['authorization'] || ''
    const s = Array.isArray(hdr) ? hdr[0] : hdr
    const ok = typeof s === 'string' && s.startsWith('Bearer ') && s.slice(7) === ADMIN_SECRET
    if (!ok) return res.status(401).send('Unauthorized')
    return true
}

app.get('/', (req, res) => {
    res.type('html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Meeting Admin</title></head>
<body>
<h1>Admin panel (простая)</h1>
<form id="createMeeting"><button type="submit">Создать встречу (2 часа)</button></form>
<pre id="meetingOut"></pre>
<hr>
<form id="inviteForm">
  Meeting ID: <input name="meetingId" id="meetingId">
  <button type="submit">Выдать ссылку</button>
</form>
<pre id="inviteOut"></pre>
<script>
const secret = localStorage.getItem('ADMIN_SECRET') || prompt('Введите ADMIN_SECRET')
localStorage.setItem('ADMIN_SECRET', secret)
const headers = { 'Authorization': 'Bearer ' + secret, 'Content-Type': 'application/json' }
createMeeting.onsubmit = async e => {
  e.preventDefault()
  const r = await fetch('/admin/meetings', { method:'POST', headers })
  meetingOut.textContent = await r.text()
}
inviteForm.onsubmit = async e => {
  e.preventDefault()
  const id = document.getElementById('meetingId').value
  const r = await fetch('/admin/meetings/' + id + '/invite', { method:'POST', headers })
  inviteOut.textContent = await r.text()
}
</script>
</body></html>`)
})

app.post('/admin/meetings', (req, res) => {
    if (ensureAdmin(req, res) !== true) return
    const meetingId = rid(12)
    const createdAt = Date.now()
    const m = { room: newRoom(), createdAt, expiresAt: createdAt + MEETING_TTL_MS, maxParticipants: MAX_PARTICIPANTS, joins: 0 }
    meetings.set(meetingId, m)
    res.json({ meetingId, room: m.room, createdAt, expiresAt: m.expiresAt, maxParticipants: m.maxParticipants })
})

app.post('/admin/meetings/:id/invite', (req, res) => {
    if (ensureAdmin(req, res) !== true) return
    const id = req.params.id
    const m = meetings.get(id)
    if (!m) return res.status(404).send('meeting not found')
    const now = Date.now()
    if (now > m.expiresAt) return res.status(410).send('meeting expired')
    const token = rid(18)
    tokens.set(token, { meetingId: id, firstSeenAt: null, expiresAt: null })
    const url = `${HOST}/r/${token}`
    res.json({ token, url, meetingId: id, meetingExpiresAt: m.expiresAt })
})

app.get('/r/:token', (req, res) => {
    const t = req.params.token
    const tk = tokens.get(t)
    if (!tk) return res.status(410).send('Link expired or invalid')

    const m = meetings.get(tk.meetingId)
    if (!m) { tokens.delete(t); return res.status(410).send('Meeting expired') }

    const now = Date.now()
    if (now > m.expiresAt) { tokens.delete(t); meetings.delete(tk.meetingId); return res.status(410).send('Meeting expired') }

    if (tk.firstSeenAt === null) { tk.firstSeenAt = now; tk.expiresAt = now + TOKEN_WINDOW_MS }
    if (now > tk.expiresAt) { tokens.delete(t); return res.status(410).send('Personal link expired') }
    if (m.joins >= m.maxParticipants) return res.status(403).send('Room is full')

    m.joins += 1
    res.redirect(302, `/call.html?t=${encodeURIComponent(t)}`)
})

app.get('/healthz', (req, res) => res.send('ok'))

const wss = new WebSocketServer({ noServer: true })

function broadcast(meetingId, payload, exceptId = null) {
    const peers = roomPeers.get(meetingId)
    if (!peers) return
    const data = JSON.stringify(payload)
    for (const [id, ws] of peers) if (id !== exceptId && ws.readyState === 1) ws.send(data)
}

const server = http.createServer(app)

server.on('upgrade', (req, socket, head) => {
    if (!req.url || !req.url.startsWith('/ws')) return socket.destroy()
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})

wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://x')
    const token = url.searchParams.get('token')
    const tk = token && tokens.get(token)
    if (!tk) return ws.close(4401, 'token invalid')

    const m = meetings.get(tk.meetingId)
    const now = Date.now()
    if (!m || now > m.expiresAt) return ws.close(4402, 'meeting expired')
    if (tk.firstSeenAt === null) { tk.firstSeenAt = now; tk.expiresAt = now + TOKEN_WINDOW_MS }
    if (now > tk.expiresAt) return ws.close(4403, 'token window expired')

    const meetingId = tk.meetingId
    const peerId = rid(8)

    if (!roomPeers.has(meetingId)) roomPeers.set(meetingId, new Map())
    const peers = roomPeers.get(meetingId)
    peers.set(peerId, ws)
    sockets.set(ws, { peerId, meetingId, token })

    const others = [...peers.keys()].filter(id => id !== peerId)
    ws.send(JSON.stringify({ type: 'hello', peerId, peers: others }))
    broadcast(meetingId, { type: 'peer-join', peerId }, peerId)

    ws.on('message', (buf) => {
        let msg; try { msg = JSON.parse(buf.toString()) } catch { return }
        if (msg.type === 'signal' && msg.target && peers.has(msg.target)) {
            peers.get(msg.target)?.send(JSON.stringify({ type: 'signal', from: peerId, data: msg.data }))
        }
    })

    ws.on('close', () => {
        peers.delete(peerId)
        broadcast(meetingId, { type: 'peer-leave', peerId })
        sockets.delete(ws)
    })
})

server.listen(PORT, () => console.log('listening on', PORT))
