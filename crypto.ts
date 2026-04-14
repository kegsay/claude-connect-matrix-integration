import { webcrypto } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import nacl from 'tweetnacl'
import bs58 from 'bs58'
import type { MatrixClient } from 'matrix-bot-sdk'

export interface RelogResult {
  accessToken: string
  deviceId: string | null
}

export async function relogWithPinnedDevice(opts: {
  homeserverUrl: string
  username: string
  password: string
  storeDir: string
  existingToken?: string | null
}): Promise<RelogResult> {
  const { homeserverUrl, username, password, storeDir, existingToken } = opts
  const tokenFile = path.join(storeDir, 'matrix-token')

  let cryptoDeviceId: string | null = null
  try {
    const botSdkJson = JSON.parse(
      fs.readFileSync(path.join(storeDir, 'matrix-crypto', 'bot-sdk.json'), 'utf-8'),
    ) as { deviceId?: string }
    cryptoDeviceId = botSdkJson.deviceId ?? null
  } catch { /* first run */ }

  let storedToken: string | null = existingToken ?? null
  if (!storedToken) {
    try { storedToken = fs.readFileSync(tokenFile, 'utf-8').trim() || null } catch {}
  }

  if (storedToken && cryptoDeviceId) {
    try {
      const res = await fetch(`${homeserverUrl}/_matrix/client/v3/account/whoami`, {
        headers: { Authorization: `Bearer ${storedToken}` },
      })
      if (res.ok) {
        const whoami = await res.json() as { device_id?: string }
        if (whoami.device_id === cryptoDeviceId) {
          return { accessToken: storedToken, deviceId: cryptoDeviceId }
        }
      }
    } catch {}
  }

  const loginBody: Record<string, unknown> = {
    type: 'm.login.password',
    identifier: { type: 'm.id.user', user: username },
    password,
    initial_device_display_name: 'Claude Code Matrix bot',
  }
  if (cryptoDeviceId) loginBody.device_id = cryptoDeviceId

  const res = await fetch(`${homeserverUrl}/_matrix/client/v3/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(loginBody),
  })
  const data = await res.json() as { access_token?: string; device_id?: string }
  if (!res.ok || !data.access_token) {
    throw new Error(`Matrix login failed: ${JSON.stringify(data)}`)
  }
  fs.mkdirSync(storeDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(tokenFile, data.access_token, { mode: 0o600 })
  return { accessToken: data.access_token, deviceId: cryptoDeviceId ?? data.device_id ?? null }
}

export async function autoSignDevice(opts: {
  client: MatrixClient
  homeserverUrl: string
  accessToken: string
  userId: string
  recoveryKey: string
}): Promise<void> {
  const { client, homeserverUrl, accessToken, userId, recoveryKey } = opts
  const { subtle } = webcrypto
  const b64d = (s: string) => Buffer.from(s, 'base64')

  // Generic external error to avoid leaking which validation step failed
  // (would otherwise form a recovery-key oracle via stderr / log access).
  // Internal step is logged at debug to aid local troubleshooting only.
  const RECOVERY_KEY_ERR = 'recovery key invalid'
  const debug = (step: string) => process.stderr.write(`[crypto] recovery-key check failed: ${step}\n`)

  const OLM_PREFIX = [0x8b, 0x01]
  let rawKey: Uint8Array
  try {
    rawKey = bs58.decode(recoveryKey.replace(/ /g, ''))
  } catch {
    debug('base58 decode')
    throw new Error(RECOVERY_KEY_ERR)
  }
  let parity = 0
  for (const b of rawKey) parity ^= b
  if (parity !== 0) { debug('parity'); throw new Error(RECOVERY_KEY_ERR) }
  for (let i = 0; i < OLM_PREFIX.length; i++) {
    if (rawKey[i] !== OLM_PREFIX[i]) { debug('prefix'); throw new Error(RECOVERY_KEY_ERR) }
  }
  if (rawKey.length < OLM_PREFIX.length + 32 + 1) { debug('length'); throw new Error(RECOVERY_KEY_ERR) }
  const masterKey = rawKey.slice(OLM_PREFIX.length, OLM_PREFIX.length + 32)

  const matrixReq = async (method: string, urlPath: string, body?: unknown) => {
    const res = await fetch(`${homeserverUrl}/_matrix/client/v3${urlPath}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const json = await res.json() as Record<string, unknown>
    if (!res.ok) throw new Error(`${method} ${urlPath}: ${JSON.stringify(json)}`)
    return json
  }

  const deviceId = (client.crypto as unknown as { clientDeviceId?: string })?.clientDeviceId
  if (!deviceId) throw new Error('Could not determine crypto device ID — is E2EE enabled?')

  const defaultKeyData = await matrixReq(
    'GET',
    `/user/${encodeURIComponent(userId)}/account_data/m.secret_storage.default_key`,
  )
  const keyId = defaultKeyData.key as string

  const secretName = 'm.cross_signing.self_signing'
  const encSecretData = await matrixReq(
    'GET',
    `/user/${encodeURIComponent(userId)}/account_data/${encodeURIComponent(secretName)}`,
  )
  const encItem = (encSecretData.encrypted as Record<string, unknown>)[keyId] as {
    ciphertext: string
    mac: string
    iv: string
  }
  if (!encItem) throw new Error(`Secret "${secretName}" not found for key ${keyId}`)

  const hkdfKey = await subtle.importKey('raw', masterKey, { name: 'HKDF' }, false, ['deriveBits'])
  const bits = await subtle.deriveBits(
    {
      name: 'HKDF',
      salt: new Uint8Array(8),
      info: new TextEncoder().encode(secretName),
      hash: 'SHA-256',
    },
    hkdfKey,
    512,
  )
  const aesKey = await subtle.importKey('raw', bits.slice(0, 32), { name: 'AES-CTR' }, false, ['decrypt'])
  const hmacKey = await subtle.importKey(
    'raw',
    bits.slice(32),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  )

  const ciphertext = b64d(encItem.ciphertext)
  const ivBytes = b64d(encItem.iv)
  if (ivBytes.length !== 16) { debug('iv length'); throw new Error(RECOVERY_KEY_ERR) }
  const valid = await subtle.verify({ name: 'HMAC' }, hmacKey, b64d(encItem.mac), ciphertext)
  if (!valid) { debug('hmac verify'); throw new Error(RECOVERY_KEY_ERR) }

  const plaintext = await subtle.decrypt(
    { name: 'AES-CTR', counter: ivBytes, length: 64 },
    aesKey,
    ciphertext,
  )
  const selfSigningPrivKey = b64d(new TextDecoder().decode(plaintext))

  const keyPair = nacl.sign.keyPair.fromSeed(selfSigningPrivKey.slice(0, 32))
  const selfSigningPubKey = Buffer.from(keyPair.publicKey).toString('base64').replace(/=/g, '')

  const keysResp = await matrixReq('POST', '/keys/query', {
    device_keys: { [userId]: [deviceId] },
  })
  const deviceKeys = (
    (keysResp.device_keys as Record<string, Record<string, unknown>>)[userId]
  )?.[deviceId] as Record<string, unknown> | undefined
  if (!deviceKeys) throw new Error(`Device ${deviceId} not found in /keys/query response`)

  const toSign = { ...deviceKeys }
  delete toSign.signatures
  delete toSign.unsigned

  const canonicalJSON = (obj: unknown): string => {
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return JSON.stringify(obj)
    const keys = Object.keys(obj as object).sort()
    return (
      '{' +
      keys
        .map(k => `${JSON.stringify(k)}:${canonicalJSON((obj as Record<string, unknown>)[k])}`)
        .join(',') +
      '}'
    )
  }

  const message = Buffer.from(canonicalJSON(toSign))
  const signature = nacl.sign.detached(message, keyPair.secretKey)
  const signatureB64 = Buffer.from(signature).toString('base64')

  const uploadBody = {
    [userId]: {
      [deviceId]: {
        ...toSign,
        signatures: {
          [userId]: { [`ed25519:${selfSigningPubKey}`]: signatureB64 },
        },
      },
    },
  }
  const uploadResp = await matrixReq('POST', '/keys/signatures/upload', uploadBody)
  const failures = uploadResp.failures as Record<string, unknown> | undefined
  if (failures && Object.keys(failures).length > 0) {
    throw new Error(`Signature upload failures: ${JSON.stringify(failures)}`)
  }
}
