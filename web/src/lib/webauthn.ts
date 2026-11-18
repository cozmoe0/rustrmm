/*
 * Bridges webauthn-rs JSON (base64url binary fields under `publicKey`) and the browser
 * Credential Management API. Prefers the native JSON helpers (WebAuthn L3) and falls back
 * to manual base64url conversion on older browsers.
 */

type Json = Record<string, unknown>

export function base64urlToBuffer(value: string): ArrayBuffer {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

export function bufferToBase64url(buffer: ArrayBuffer | ArrayBufferView): string {
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

type PkcStatic = typeof PublicKeyCredential & {
  parseCreationOptionsFromJSON?: (json: Json) => PublicKeyCredentialCreationOptions
  parseRequestOptionsFromJSON?: (json: Json) => PublicKeyCredentialRequestOptions
}

function pkc(): PkcStatic | undefined {
  return typeof window !== 'undefined' && 'PublicKeyCredential' in window
    ? (window.PublicKeyCredential as PkcStatic)
    : undefined
}

export function isWebauthnSupported(): boolean {
  return Boolean(pkc() && navigator.credentials)
}

function convertDescriptors(list: unknown): PublicKeyCredentialDescriptor[] | undefined {
  if (!Array.isArray(list)) return undefined
  return list.map((item: Json) => ({
    ...(item as object),
    id: base64urlToBuffer(String(item.id)),
  })) as PublicKeyCredentialDescriptor[]
}

function toRequestOptions(publicKey: Json): PublicKeyCredentialRequestOptions {
  const native = pkc()?.parseRequestOptionsFromJSON
  if (native) return native(publicKey)
  return {
    ...(publicKey as object),
    challenge: base64urlToBuffer(String(publicKey.challenge)),
    allowCredentials: convertDescriptors(publicKey.allowCredentials),
  } as PublicKeyCredentialRequestOptions
}

function toCreationOptions(publicKey: Json): PublicKeyCredentialCreationOptions {
  const native = pkc()?.parseCreationOptionsFromJSON
  if (native) return native(publicKey)
  const user = publicKey.user as Json
  return {
    ...(publicKey as object),
    challenge: base64urlToBuffer(String(publicKey.challenge)),
    user: { ...(user as object), id: base64urlToBuffer(String(user.id)) },
    excludeCredentials: convertDescriptors(publicKey.excludeCredentials),
  } as PublicKeyCredentialCreationOptions
}

type JsonCapableCredential = PublicKeyCredential & { toJSON?: () => Json }

/** Serializes a credential into the JSON shape webauthn-rs deserializes. */
export function credentialToJson(credential: PublicKeyCredential): Json {
  const withJson = credential as JsonCapableCredential
  let json: Json
  if (typeof withJson.toJSON === 'function') {
    json = withJson.toJSON() as unknown as Json
  } else {
    const response = credential.response as AuthenticatorAttestationResponse &
      AuthenticatorAssertionResponse
    const encoded: Json = { clientDataJSON: bufferToBase64url(response.clientDataJSON) }
    if ('attestationObject' in response && response.attestationObject) {
      encoded.attestationObject = bufferToBase64url(response.attestationObject)
    }
    if ('authenticatorData' in response && response.authenticatorData) {
      encoded.authenticatorData = bufferToBase64url(response.authenticatorData)
      encoded.signature = bufferToBase64url(response.signature)
      encoded.userHandle = response.userHandle ? bufferToBase64url(response.userHandle) : null
    }
    json = {
      id: credential.id,
      rawId: bufferToBase64url(credential.rawId),
      type: credential.type,
      response: encoded,
      clientExtensionResults: credential.getClientExtensionResults(),
    }
  }
  // webauthn-rs names the extension outputs `extensions`.
  return { ...json, extensions: json.clientExtensionResults ?? {} }
}

export async function getAssertion(options: { publicKey: Json }): Promise<Json> {
  const credential = (await navigator.credentials.get({
    publicKey: toRequestOptions(options.publicKey),
  })) as PublicKeyCredential | null
  if (!credential) throw new Error('No passkey was selected')
  return credentialToJson(credential)
}

export async function createCredential(options: { publicKey: Json }): Promise<Json> {
  const credential = (await navigator.credentials.create({
    publicKey: toCreationOptions(options.publicKey),
  })) as PublicKeyCredential | null
  if (!credential) throw new Error('Passkey registration was cancelled')
  return credentialToJson(credential)
}

/** Maps DOMExceptions from the authenticator to readable messages. */
export function webauthnErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') return 'The passkey prompt was dismissed or timed out.'
    if (error.name === 'InvalidStateError') return 'This authenticator is already registered.'
    if (error.name === 'SecurityError') return 'Passkeys need a secure (HTTPS) connection.'
  }
  return error instanceof Error ? error.message : 'Passkey operation failed'
}
