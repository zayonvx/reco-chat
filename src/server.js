import express from 'express'
import crypto from 'crypto'

const app = express()
app.disable('x-powered-by')
app.use(express.json())

const meetings = new Map()
const tokens = new Map()

const HOST = process.env.HOST || ''
const TOKEN_WINDOW_MS = 5 * 60 * 1000
const MEETING_TTL_MS = 2 * 60 * 60 * 1000
const MAX_PARTICIPANTS = Number(process.env.MAX_PARTICIPANTS || 3)
const ADMIN_SECRET = process.env.ADMIN_SECRET || ''

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
<form id="createMeeting">
  <button type="submit">Создать встречу (2 часа)</button>
</form>
<pre id="meetingOut"></pre>
<hr>
<form id="inviteForm">
  Meeting ID: <input name="meetingId" id="meetingId"> <button type="submit">Выдать ссылку</button>
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
    const jitsiUrl = `https://meet.jit.si/${m.room}#config.prejoinPageEnabled=true&config.startWithAudioMuted=false&config.startWithVideoMuted=true&interfaceConfig.DISABLE_VIDEO_BACKGROUND=true`
    res.type('html').send(`<!DOCTYPE html><html><body><h1>Redirecting...</h1><a href="${jitsiUrl}">Join meeting</a><script>location='${jitsiUrl}'</script></body></html>`)
})



app.get('/healthz', (req, res) => res.send('ok'))
const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log('listening on', PORT))

