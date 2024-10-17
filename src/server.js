import fs from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { parse } from 'node:url'
import next from 'next'
import { WebSocketServer } from 'ws'
import dotenv from 'dotenv'
import path from 'node:path'
import fetch from 'node-fetch'
import https from 'node:https'

dotenv.config({ path: path.resolve(process.cwd(), '.env') })
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })

const hostname = 'localhost'
const port = process.env.PORT || 3000
const dev = process.env.NODE_ENV !== 'production'

let httpServer
let isHttps = false

if (dev) {
  const keyPath = 'certificates/localhost-key.pem'
  const certPath = 'certificates/localhost.pem'

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    const httpsOptions = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    }
    httpServer = createHttpsServer(httpsOptions)
    isHttps = true
  } else {
    console.warn('HTTPS certificates not found. Falling back to HTTP.')
    httpServer = createHttpServer()
  }
} else {
  httpServer = createHttpServer()
}

const webSocketServer = new WebSocketServer({ noServer: true })

const app = next({ dev, hostname, port, customServer: true })
const handle = app.getRequestHandler()

const OPENAI_API_KEY = process.env.OPENAI_API_KEY_VOICE

if (!OPENAI_API_KEY) {
  console.error(`Environment variable "OPENAI_API_KEY_VOICE" is missing.`)
}

let connectedClients = 0

const log = (...args) => console.log('[WebSocket]', ...args)

const handleWebSocketConnection = async (ws) => {
  connectedClients++
  log(`New WebSocket connection established. Total clients: ${connectedClients}`)

  let RealtimeClient
  try {
    const realtimeModule = await import('@openai/realtime-api-beta')
    RealtimeClient = realtimeModule.RealtimeClient
  } catch (error) {
    log('Failed to import RealtimeClient:', error)
    ws.close()
    return
  }

  log(`Connecting with key "${OPENAI_API_KEY.slice(0, 3)}..."`)
  const client = new RealtimeClient({ apiKey: OPENAI_API_KEY })

  // Relay: OpenAI Realtime API Event -> Browser Event
  client.realtime.on('server.*', (event) => {
    log(`Relaying "${event.type}" to Client: ${Object.keys(event).pop()}`)
    ws.send(JSON.stringify(event))
  })

  client.realtime.on('close', () => ws.close())

  // Relay: Browser Event -> OpenAI Realtime API Event
  const messageQueue = []
  const messageHandler = async (data) => {
    try {
      const event = JSON.parse(data)
      log(`Relaying "${event.type}" to OpenAI`)
      await client.realtime.send(event.type, event)
    } catch (e) {
      console.error(e.message)
      log(`Error parsing event from client: ${data}`)
    }
  }

  ws.on('message', (data) => {
    if (!client.isConnected()) {
      messageQueue.push(data)
    } else {
      messageHandler(data)
    }
  })

  ws.on('close', () => {
    log('WebSocket connection closed')
    client.disconnect()
    connectedClients--
  })

  // Connect to OpenAI Realtime API
  try {
    log('Connecting to OpenAI...')
    await client.connect()
    log('Connected to OpenAI successfully!')
    // Process any queued messages
    while (messageQueue.length) {
      await messageHandler(messageQueue.shift())
    }
  } catch (e) {
    log(`Error connecting to OpenAI: ${e.message}`)
    ws.close()
    return
  }
}

webSocketServer.on('connection', handleWebSocketConnection)

const startServer = (port) => {
  httpServer
    .on('request', async (req, res) => {
      const { pathname, query } = parse(req.url, true)
      const { fingerprints } = query

      // Prepare truncated fingerprints for logging only
      const truncatedFingerprints =
        fingerprints && fingerprints.length > 60
          ? `${fingerprints.substring(0, 60)}...`
          : fingerprints || ''

      // Log the truncated URL, but keep the original URL intact
      const logUrl = fingerprints ? `${pathname}?fingerprints=${truncatedFingerprints}` : req.url
      console.log(`[Express] ${req.method} ${logUrl}`)

      if (pathname === '/_next/webpack-hmr') {
        console.log('[Express] Webpack HMR request received')
        console.log(req)
      } else if (pathname === '/api/ws') {
        // Handle the /api/ws request directly
        res.writeHead(200, { 'Content-Type': 'application/json' })
        const responseData = JSON.stringify({
          status: 'available',
          count: connectedClients,
          port,
        })
        console.log('[Express] Sending response for /api/ws:', responseData)
        res.end(responseData)
      } else {
        // Handle fingerprint for other routes
        if (fingerprints) {
          // Keep the original fingerprint in the request header
          req.headers['x-fingerprint'] = fingerprints
        }

        // For all other routes, let Next.js handle the request
        await handle(req, res, { pathname, query })
      }
    })
    .on('upgrade', (req, socket, head) => {
      const { pathname } = parse(req.url)

      if (pathname === '/api/ws') {
        webSocketServer.handleUpgrade(req, socket, head, (ws) => {
          webSocketServer.emit('connection', ws, req)
        })
      } else {
        socket.destroy()
      }
    })
    .listen(port, () => {
      const protocol = isHttps ? 'https' : 'http'
      console.log(`[Express] ▲ Ready on ${protocol}://${hostname}:${port}`)
    })
    .on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`[Express] Port ${port} is in use, trying ${port + 1}...`)
        startServer(port + 1)
      } else {
        console.error('[Express] Failed to start server:', err)
        process.exit(1)
      }
    })

  // Preload the root path after the server starts
  if (dev) {
    const protocol = isHttps ? 'https' : 'http'
    const agent = new https.Agent({
      rejectUnauthorized: false,
    })

    fetch(`${protocol}://${hostname}:${port}/`, {
      agent: protocol === 'https' ? agent : undefined,
    })
      .then((response) => {
        if (!response.ok) {
          console.warn(
            '[Express] Failed to preload root path:',
            response.status,
            response.statusText,
          )
        }
      })
      .catch((error) => {
        console.error('[Express] Error preloading root path:', error)
      })
  }
}

;(async () => {
  await app.prepare()
  startServer(port)
})().catch((err) => {
  console.error('Failed to start server:', err)
  process.exit(1)
})
