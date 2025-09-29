/* globals Response Headers */

const corsHeaders = {
  'Access-Control-Allow-Methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Max-Age': '86400'
}

function getAllowedOrigins (env) {
  if (!env.ALLOWED_ORIGINS) return null

  return env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim()).filter(Boolean)
}

function isOriginAllowed (origin, env) {
  if (!origin) return false

  const allowedOrigins = getAllowedOrigins(env)

  if (!allowedOrigins) return true

  return allowedOrigins.includes(origin)
}

function buildCorsHeaders (request, env, overrides = {}) {
  const headers = {
    ...corsHeaders,
    ...overrides
  }

  const origin = request.headers.get('Origin')

  if (origin && isOriginAllowed(origin, env)) {
    headers['Access-Control-Allow-Origin'] = origin
    headers['Access-Control-Allow-Credentials'] = 'true'
  } else {
    headers['Access-Control-Allow-Origin'] = '*'
  }

  return headers
}

async function drainResponse (response) {
  if (!response || response.bodyUsed) return

  try {
    await response.arrayBuffer()
  } catch (error) {
    if (response.body && typeof response.body.cancel === 'function') {
      try {
        await response.body.cancel()
      } catch (_) {}
    }
  }
}

const IPV4_REGEX = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/

const IPV6_REGEX = /(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))/

const RATE_LIMITING_SAMPLING_RATE = 100.0

function validatePayload (headers, payload) {
  if (
    !payload.r ||
    payload.r.length < 4 ||
    payload.r.length > 64 ||
    !payload.r.match(/^[A-Za-z0-9_-]+$/)
  ) {
    return new Response('Bad room id' + payload.r, { status: 400, headers })
  }

  if (payload.d) {
    if (
      !payload.x ||
      typeof payload.x !== 'number' ||
      payload.x > 24 * 60 * 60 * 1000
    ) {
      return new Response('Bad expiration', { status: 400, headers })
    }

    // Validate timestamp - note date is of last I/O in worker
    if (
      !payload.t ||
      typeof payload.t !== 'number' ||
      Math.abs(payload.t - new Date().getTime()) > 10 * 60 * 1000
    ) {
      return new Response('Bad timestamp', { status: 400, headers })
    }

    if (!payload.k || payload.k.length > 64) {
      return new Response('Bad context id', { status: 400, headers })
    }

    // Registering an entry
    const d = payload.d

    if (d.length !== 6) {
      return new Response('Bad data length', { status: 400, headers })
    }

    // Validate session id + client id + context id
    if (!d[0] || d[0].length > 64) {
      return new Response('Bad session id', { status: 400, headers })
    }

    if (!d[1] || d[1].length > 64) {
      return new Response('Bad client id', { status: 400, headers })
    }

    if (typeof d[2] !== 'boolean') {
      return new Response('Bad is symmetric', { status: 400, headers })
    }

    if (!d[3] || d[3].length !== 44) {
      return new Response('Bad dtls', { status: 400, headers })
    }

    if (!d[4] || typeof d[4] !== 'number') {
      return new Response('Bad joined at timestamp', { status: 400, headers })
    }

    if (
      !d[5] ||
      typeof d[5] !== 'object' ||
      d[5].find(ip => !ip.match(IPV4_REGEX) && !ip.match(IPV6_REGEX))
    ) {
      return new Response('Bad reflexive IPs', { status: 400, headers })
    }

    try {
      atob(d[3])
    } catch (e) {
      return new Response('Bad base64 encoding', { status: 400, headers })
    }
  }
}

function getRandomString (length) {
  let result = ''
  const characters =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const charactersLength = characters.length
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength))
  }

  return result
}

function getEntryDeleteKey (entry) {
  return entry[entry.length - 1]
}

function getEntryContextId (entry) {
  return entry[entry.length - 2]
}

function getEntryPackages (entry) {
  return entry[entry.length - 3]
}

function getEntryTimestamp (entry) {
  return entry[entry.length - 4]
}

function getEntrySessionId (entry) {
  return entry[0]
}

function getEntryPayloadLength (entry) {
  return entry.length - 3
}

async function handleIndexGet (request, env) {
  const hasStore = !!getStore(env)

  return new Response(
    `<html><body style="font-size: 24px; padding: 18px; font-family: Arial, sans-serif"">Hello from Webspaces<br/><div style="line-height: 28px; margin-top: 8px; font-size: 0.8em">${
      hasStore
        ? '&#128077; R2 bucket is configured properly, ready to serve.'
        : '&#10060; Couldn\'t find a configured R2 bucket.<br/>Make sure you <a href="https://github.com/gfodor/p2pcf/blob/master/INSTALL.md#set-up-the-r2-bucket" target="_blank">created a bucket</a> and <a href="https://github.com/gfodor/p2pcf/blob/master/INSTALL.md#bind-the-worker-to-r2" target="_blank">connected the worker to it</a>.'
    }</div></body></html>`,
    {
      headers: {
        'Content-Type': 'text.html'
      }
    }
  )
}

async function handleCorsProxyRequest (request, url, env) {
  const origin = request.headers.get('Origin')
  const targetPath = request.url.substring(url.origin.length + 1)
  let targetUrl = targetPath.replace(/^http(s?):\/([^/])/, 'http$1://$2')

  if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
    targetUrl = url.protocol + '//' + targetUrl
  }

  const requestHeaders = new Headers(request.headers)
  requestHeaders.delete('Origin') // Some domains disallow access from improper Origins
  const fetchInit = {
    headers: requestHeaders,
    method: request.method,
    redirect: 'manual',
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy
  }

  if (request.body && request.method !== 'GET' && request.method !== 'HEAD') {
    fetchInit.body = request.body
  }

  const res = await fetch(targetUrl, fetchInit)
  const responseHeaders = new Headers(res.headers)
  const proxyUrl = new URL(url.origin)
  const redirectLocation =
    responseHeaders.get('Location') || responseHeaders.get('location')

  if (redirectLocation) {
    if (!redirectLocation.startsWith('/')) {
      responseHeaders.set(
        'Location',
        proxyUrl.protocol + '//' + proxyUrl.host + '/' + redirectLocation
      )
    } else {
      const tUrl = new URL(targetUrl)
      responseHeaders.set(
        'Location',
        proxyUrl.protocol +
          '//' +
          proxyUrl.host +
          '/' +
          tUrl.origin +
          redirectLocation
      )
    }
  }

  const corsResponseHeaders = buildCorsHeaders(request, env, {
    'Access-Control-Allow-Headers': 'Range, Content-Type, Authorization, Accept, X-Requested-With',
    'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Encoding, Content-Length, Content-Range'
  })

  for (const [key, value] of Object.entries(corsResponseHeaders)) {
    responseHeaders.set(key, value)
  }

  responseHeaders.set('Vary', 'Origin')
  responseHeaders.set('X-Content-Type-Options', 'nosniff')

  // Disallow video
  if (res.headers.get('Content-Type').indexOf('video') >= 0) {
    return new Response('', { status: 405 })
  }

  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: responseHeaders
  })
}

function isCorsProxyPath (url) {
  const pathname = url.pathname || ''

  return (
    pathname.startsWith('/http://') ||
    pathname.startsWith('/https://') ||
    pathname.startsWith('/http:/') ||
    pathname.startsWith('/https:/')
  )
}

// Fetches the access control and content for a URL
async function handleMetadataGet (request, env, context) {
  const url = new URL(request.url)
  const targetPath = request.url.substring(url.origin.length + 6)
  const targetUrl = targetPath.replace(/^http(s?):\/([^/])/, 'http$1://$2')
  const origin = request.headers.get('Origin') || 'https://example.com'
  const store = getStore(env)
  const now = new Date().getTime()

  const keyPrefix = `metas/${btoa(targetUrl)}`
  const metaMetaEntry = await store.get(`${keyPrefix}.meta.json`)

  if (metaMetaEntry) {
    const { expireAt } = await metaMetaEntry.json()

    if (now < expireAt) {
      const metaEntry = await store.get(`${keyPrefix}.json`)

      if (metaEntry) {
        const metaData = await metaEntry.arrayBuffer()

        const headers = buildCorsHeaders(request, env, {
          'Content-Length': metaData.byteLength,
          'Content-Type': 'application/json'
        })

        return new Response(metaData, {
          headers
        })
      }
    }
  }

  const optionRequestPromise = fetch(targetUrl, {
    method: 'OPTIONS',
    headers: {
      'Access-Control-Request-Method': 'GET',
      Origin: origin
    }
  })

  let contentType = null

  for (const params of [
    { method: 'HEAD' },
    { method: 'HEAD', headers: { 'User-Agent': 'webspace-worker' } },
    { method: 'GET', headers: { Range: 'bytes=0-128' } },
    { method: 'GET', headers: { 'User-Agent': 'webspace-worker', Range: 'bytes=0-128' } }
  ]) {
    const response = await fetch(targetUrl, params)
    const header = response.headers.get('Content-Type')
    const isSuccess = (response.status === 200 || response.status === 206) && header

    if (isSuccess) {
      contentType = header
    }

    await drainResponse(response)

    if (isSuccess) {
      break
    }
  }

  if (contentType === null) {
    return new Response('', { status: 404 })
  }

  const optionsResponse = await optionRequestPromise
  const allowOriginHeader = optionsResponse.headers.get('Access-Control-Allow-Origin')
  const getAllowed =
    optionsResponse.status === 200 &&
    (allowOriginHeader === '*' || allowOriginHeader === origin)

  await drainResponse(optionsResponse)

  const data = JSON.stringify({
    content_type: contentType,
    get_allowed: getAllowed
  })

  context.waitUntil(
    store.put(
      `${keyPrefix}.meta.json`,
      JSON.stringify({ expireAt: now + 8 * 60 * 60 * 1000 })
    )
  )

  context.waitUntil(store.put(`${keyPrefix}.json`, data))

  const headers = buildCorsHeaders(request, env, {
    'Content-Type': 'application/json',
    'Content-Length': data.length
  })

  return new Response(data, {
    headers
  })
}

async function handleThumbnailGet (request, env, context) {
  const url = new URL(request.url)
  const targetPath = request.url.substring(url.origin.length + 11)
  const targetUrl = targetPath.replace(/^http(s?):\/([^/])/, 'http$1://$2')

  const store = getStore(env)
  const now = new Date().getTime()

  const keyPrefix = `thumbnails/${btoa(targetUrl)}`
  const thumbMetaEntry = await store.get(`${keyPrefix}.meta.json`)

  if (thumbMetaEntry) {
    const { expireAt } = await thumbMetaEntry.json()

    if (now < expireAt) {
      const thumbEntry = await store.get(`${keyPrefix}.png`)

      if (thumbEntry) {
        const thumbData = await thumbEntry.arrayBuffer()

        const headers = buildCorsHeaders(request, env, {
          'Content-Length': thumbData.byteLength,
          'Content-Type': 'image/png'
        })

        return new Response(thumbData, {
          headers
        })
      }
    }
  }

  let thumbData

  if (env.BROWSERLESS_API_KEY) {
    let browserlessUrl

    try {
      const endpoint = new URL(
        (env.BROWSERLESS_ENDPOINT && env.BROWSERLESS_ENDPOINT.trim()) ||
          'https://production-sfo.browserless.io/screenshot'
      )
      endpoint.searchParams.set('token', env.BROWSERLESS_API_KEY)
      browserlessUrl = endpoint.toString()
    } catch (err) {
      console.warn('Invalid Browserless endpoint, falling back to default', err)
      const fallback = new URL('https://production-sfo.browserless.io/screenshot')
      fallback.searchParams.set('token', env.BROWSERLESS_API_KEY)
      browserlessUrl = fallback.toString()
    }

    let lastError = null

    for (let i = 0; i < 30; i++) {
      const payload = {
        options: {
          type: 'png'
        },
        url: targetUrl,
        viewport: {
          deviceScaleFactor: 1.0,
          hasTouch: false,
          height: 720,
          isLandscape: true,
          isMobile: false,
          width: 1280
        },
        waitForTimeout: 10000
      }

      if (i === 0) {
        payload.gotoOptions = {
          waitUntil: 'networkidle2'
        }
      }

      const res = await fetch(browserlessUrl, {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache'
        }
      })

      if (res.status === 200) {
        thumbData = await res.arrayBuffer()
        break
      }

      try {
        const errorText = await res.text()
        lastError = { status: res.status, body: errorText }
      } catch (error) {
        lastError = { status: res.status }
      }

      await new Promise(resolve => setTimeout(resolve, 1000))
    }

    if (!thumbData && lastError) {
      console.warn('Browserless screenshot failed', lastError)
    }
  } else {
    let res

    try {
      res = await fetch(targetUrl)
    } catch (e) {
      return new Response('', { status: 404 })
    }

    const body = await res.text()
    const regex1 = /<meta [^>]*property=["']og:image["'] [^>]*content=["']([^'^"]+?)["'][^>]*>/i
    const regex2 = /<meta [^>]*content=["']([^'^"]+?)["'] [^>]*property=["']og:image["'][^>]*>/

    let imageUrl = null

    const match1 = body.match(regex1)
    const match2 = body.match(regex2)

    if (match1) {
      imageUrl = match1[1]
    } else if (match2) {
      imageUrl = match2[1]
    } else {
      return new Response('', { status: 404 })
    }

    thumbData = await (await fetch(imageUrl)).arrayBuffer()
  }

  if (thumbData) {
    context.waitUntil(
      store.put(
        `${keyPrefix}.meta.json`,
        JSON.stringify({ expireAt: now + 8 * 60 * 60 * 1000 })
      )
    )

    context.waitUntil(store.put(`${keyPrefix}.png`, thumbData))

    const headers = buildCorsHeaders(request, env, {
      'Content-Length': thumbData.byteLength,
      'Content-Type': 'image/png'
    })

    return new Response(thumbData, {
      headers
    })
  } else {
    return new Response('', { status: 404 })
  }
}

async function handleGet (request, env, context) {
  const url = new URL(request.url)
  if (url.pathname === '/favicon.ico') return new Response('', { status: 404 })

  if (url.pathname === '/') {
    return handleIndexGet(request, env)
  }
  if (url.pathname.startsWith('/thumbnail')) {
    return handleThumbnailGet(request, env, context)
  }
  if (url.pathname.startsWith('/meta')) {
    return handleMetadataGet(request, env, context)
  }

  return handleCorsProxyRequest(request, url, env)
}

async function handleOptions (request, env) {
  const headers = request.headers

  if (
    headers.get('Origin') !== null &&
    headers.get('Access-Control-Request-Method') !== null
  ) {
    const overrides = {}
    const requestedHeaders = headers.get('Access-Control-Request-Headers')

    if (requestedHeaders) {
      overrides['Access-Control-Allow-Headers'] = requestedHeaders
    }

    const respHeaders = buildCorsHeaders(request, env, overrides)

    return new Response(null, {
      headers: respHeaders
    })
  } else {
    // Handle standard OPTIONS request.
    // If you want to allow other HTTP Methods, you can do that here.
    const respHeaders = buildCorsHeaders(request, env, {
      Allow: 'HEAD, GET, POST, PUT, PATCH, DELETE, OPTIONS'
    })

    return new Response(null, {
      headers: respHeaders
    })
  }
}

async function lookupEntries (roomId, store) {
  let maxIndex = -1
  const maxIndexEntry = await store.get(`rooms/${roomId}/max_index`)

  if (maxIndexEntry) {
    maxIndex = parseInt(await maxIndexEntry.text())
  }

  const entries = []
  const ps = []

  // read a few ahead of max index just to reduce latency during small groups joining on KV
  // read entries as promises first to parallelize reads. if the entries are empty then don't do this.
  for (let i = 0; i <= maxIndex; i++) {
    const p = store
      .get(`rooms/${roomId}/entries:${i}`)
      .then(v => (v ? v.json() : v))

    entries.push(p)
    ps.push(p)

    // Connection limit
    if (ps.length >= 2) {
      await Promise.all(ps)
      ps.length = 0
    }
  }

  await Promise.all(ps)

  return [entries, maxIndex]
}

function getStore (env) {
  let store = null

  for (const obj of Object.values(env)) {
    if (obj.get && obj.put && obj.delete && obj.list) {
      store = obj
      break
    }
  }

  return store
}

async function handleDelete (request, env, context) {
  const headers = buildCorsHeaders(request, env, { Vary: 'Origin' })
  const payload = await request.json()

  if (!payload.dk) {
    return new Response('Missing delete key', { status: 400, headers })
  }

  const errorResponse = validatePayload(headers, payload)
  if (errorResponse) return errorResponse

  const roomId = payload.r
  const store = getStore(env)

  const [entries, maxIndex] = await lookupEntries(roomId, store)

  for (let i = 0; i < entries.length; i++) {
    const value = await entries[i]

    if (value) {
      entries[i] = value
    } else {
      entries[i] = null
    }
  }

  for (let i = 0; i < entries.length; i++) {
    if (entries[i] === null) continue

    const entry = entries[i]
    const entrySessionId = getEntrySessionId(entry)
    const entryContextId = getEntryContextId(entry)
    const entryDeleteKey = getEntryDeleteKey(entry)

    if (
      payload.k === entryContextId &&
      payload.d[0] === entrySessionId &&
      payload.dk === entryDeleteKey
    ) {
      context.waitUntil(store.delete(`rooms/${roomId}/entries:${i}`))

      if (maxIndex === i) {
        const now = new Date().getTime()

        context.waitUntil(
          store.put(`rooms/${roomId}/max_index`, `${i - 1}`, {
            customMetadata: { expireAt: now + 8 * 60 * 60 * 1000 }
          })
        )
      }

      return new Response('{}', { status: 200, headers })
    }
  }

  return new Response('No delete key', { status: 404, headers })
}

async function handlePost (request, env, context) {
  const headers = buildCorsHeaders(request, env, { Vary: 'Origin' })

  const payload = await request.json()
  const errorResponse = validatePayload(headers, payload)

  if (errorResponse) return errorResponse
  const store = getStore(env)

  const roomId = payload.r
  const now = new Date().getTime()

  // R2 needs vacuum
  const nextVacuumEntry = store.get(`rooms/${roomId}/next_vacuum`)

  const [entries, maxIndex] = await lookupEntries(roomId, store)

  for (let i = 0; i < entries.length; i++) {
    const value = await entries[i]

    if (value) {
      entries[i] = value
    } else {
      entries[i] = null
    }
  }

  const contextId = payload.k
  let deleteKeyForEntry = null

  if (payload.d && payload.p) {
    // This is the timestamp on the session side of this data set if this changes, we write to the store
    const timestamp = payload.t
    const packages = payload.p
    deleteKeyForEntry = getRandomString(24)

    let shouldSave = true

    // Need to save the entry if it doesn't exist already.
    for (let i = 0; i < entries.length; i++) {
      if (entries[i] === null) continue

      const entry = entries[i]
      const entryContextId = getEntryContextId(entry)
      const entryTimestamp = getEntryTimestamp(entry)
      const entryDeleteKey = getEntryDeleteKey(entry)

      if (contextId === entryContextId) {
        deleteKeyForEntry = entryDeleteKey

        if (entryTimestamp === timestamp) {
          shouldSave = false
        }

        break
      }
    }

    if (shouldSave) {
      let saved = false

      // Entry is the payload plus additional data that isn't directly returned to the session.
      const newEntry = [
        ...payload.d,
        timestamp,
        packages,
        contextId,
        deleteKeyForEntry
      ]

      // Cap expiration to 15 minutes
      const expireIn = Math.min(15 * 60 * 1000, payload.x)
      const putOptions = { customMetadata: { expireAt: now + expireIn } }

      // First search for an exisitng one
      for (let i = 0; i < entries.length; i++) {
        if (entries[i] === null) continue

        const entry = entries[i]

        const entryContextId = getEntryContextId(entry)
        if (entryContextId !== contextId) continue

        if (saved) {
          // Duplicate, weird
          context.waitUntil(store.delete(`rooms/${roomId}/entries:${i}`))
          entries[i] = null
        } else {
          context.waitUntil(
            store.put(
              `rooms/${roomId}/entries:${i}`,
              JSON.stringify(newEntry),
              putOptions
            )
          )
          entries[i] = newEntry
          saved = true
        }
      }

      // Could not find an existing slot to replace, so look for an empty slot or add to the end.
      if (!saved) {
        // Look for a null slot
        for (let i = 0; i < entries.length; i++) {
          if (entries[i] !== null) continue
          context.waitUntil(
            store.put(
              `rooms/${roomId}/entries:${i}`,
              JSON.stringify(newEntry),
              putOptions
            )
          )
          entries[i] = newEntry
          saved = true
          break
        }

        // Otherwise push a new entry
        if (!saved) {
          entries.push(newEntry)
          context.waitUntil(
            store.put(
              `rooms/${roomId}/entries:${entries.length - 1}`,
              JSON.stringify(newEntry),
              putOptions
            )
          )
        }
      }
    }

    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i] === null) continue

      // max index always increases, rely on expiration to lower watermark
      if (maxIndex < i) {
        context.waitUntil(
          store.put(`rooms/${roomId}/max_index`, `${i}`, {
            customMetadata: { expireAt: now + 8 * 60 * 60 * 1000 }
          })
        )
        break
      }
    }
  }

  // Build the peer payload, list and the packages.
  const map = new Map()
  const packages = []

  for (let i = 0; i < entries.length; i++) {
    if (entries[i] === null) continue

    const entry = entries[i]
    const entryContextId = getEntryContextId(entry)
    if (contextId === entryContextId) continue

    const timestamp = getEntryTimestamp(entry)

    // Get the earliest entry for a given context id.
    if (!map.has(entryContextId)) {
      map.set(entryContextId, entry.slice(0, getEntryPayloadLength(entry)))
    } else {
      const existing = map.get(entryContextId)

      if (existing[existing.length - 1] < timestamp) {
        map.set(entryContextId, entry.slice(0, getEntryPayloadLength(entry)))
      }
    }

    // Add to the packages due to this session.
    if (payload.d) {
      const sessionId = payload.d[0]
      const entryPackages = getEntryPackages(entry)

      for (let j = 0; j < entryPackages.length; j++) {
        // Package was meant for this session
        if (entryPackages[j][0] === sessionId) {
          packages.push(entryPackages[j])
        }
      }
    }
  }

  const peers = [...map.values()]
  const responseData = { ps: peers, pk: packages }

  if (deleteKeyForEntry) {
    responseData.dk = deleteKeyForEntry
  }

  // Check for vacuum
  const nextVacuumEntryValue = await nextVacuumEntry

  if (
    !nextVacuumEntryValue ||
    now > parseInt(await nextVacuumEntryValue.text())
  ) {
    // Add a random delay and re-check to avoid stampede.
    context.waitUntil(
      new Promise(resolve => {
        setTimeout(async () => {
          const now = new Date().getTime()
          const nextVacuumEntry = await store.get(`rooms/${roomId}/next_vacuum`)

          if (
            !nextVacuumEntry ||
            now > parseInt(await nextVacuumEntry.text())
          ) {
            let removed = 0

            // Vacuum
            await store.put(`rooms/${roomId}/next_vacuum`, `${now + 30 * 1000}`) // One mintue room vacuum interval

            const list = await store.list({
              include: ['customMetadata'],
              prefix: `rooms/${roomId}/`
            })
            const removePromises = []

            for (const {
              key,
              customMetadata: { expireAt }
            } of list.objects) {
              if (!expireAt || now < expireAt) continue
              removePromises.push(store.delete(key))
              removed++

              if (removePromises.length >= 5) {
                await Promise.all(removePromises)
                removePromises.length = 0
              }
            }

            await Promise.all(removePromises)

            console.log(
              'Vacuumed room ' +
                roomId +
                '. Removed ' +
                (removed + 1) +
                ' keys.'
            )
          }

          resolve()
        }, Math.floor(Math.random() * 10 * 1000))
      })
    )
  }

  return new Response(JSON.stringify(responseData), { status: 200, headers })
}

async function getResponseIfDisallowed (request, env) {
  // No CORS header, so can't do anything
  const origin = request.headers.get('Origin')
  if (!origin) return null

  let originQuota = env.ORIGIN_QUOTA ? parseInt(env.ORIGIN_QUOTA) : 10000
  const allowedOrigins = getAllowedOrigins(env)
  const originAllowed = isOriginAllowed(origin, env)

  if (allowedOrigins) {
    if (!originAllowed) {
      return new Response('Unauthorized', { status: 401 })
    }

    if (!env.ORIGIN_QUOTA) {
      return null
    }
  }

  if (originQuota === 0) {
    return new Response('Unauthorized', { status: 401 })
  }

  const store = getStore(env)

  const d = new Date()
  const currentCountKey = `join-counts/${d.getYear()}-${d.getMonth()}/${encodeURIComponent(
    origin
  )}`
  const currentCountEntry = await store.get(currentCountKey)

  let currentCount = 0

  if (currentCountEntry) {
    currentCount = parseInt(await currentCountEntry.text())
  }

  if (currentCount >= originQuota) {
    return new Response('Over quota', { status: 429 })
  }

  // Do 1 out of RATE_LIMITING_SAMPLING_RATE sampling
  if (Math.random() < 1.0 / RATE_LIMITING_SAMPLING_RATE) {
    await store.put(
      currentCountKey,
      (currentCount + Math.floor(RATE_LIMITING_SAMPLING_RATE)).toString()
    )
  }
}

export default {
  async fetch (request, env, context) {
    const url = new URL(request.url)
    const disallowedResponse = await getResponseIfDisallowed(request, env)

    if (disallowedResponse) {
      return disallowedResponse
    }

    if (request.method === 'OPTIONS') {
      return handleOptions(request, env, context)
    }

    if (isCorsProxyPath(url)) {
      return handleCorsProxyRequest(request, url, env)
    }

    if (request.method === 'GET') {
      return handleGet(request, env, context)
    }

    if (request.method === 'HEAD') {
      return handleCorsProxyRequest(request, url, env)
    }

    if (request.headers.get('content-type') !== 'application/json') {
      return new Response('Expected content-type application/json', {
        status: 400
      })
    }

    if (
      request.headers.get('x-worker-method') === 'DELETE' ||
      request.method === 'DELETE'
    ) {
      return await handleDelete(request, env, context)
    }

    if (request.method === 'POST') {
      return await handlePost(request, env, context)
    }

    return new Response('Method not allowed', { status: 405 })
  }
}
