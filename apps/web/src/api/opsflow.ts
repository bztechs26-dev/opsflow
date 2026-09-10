const apiBaseUrl = import.meta.env.VITE_OPSFLOW_API_URL ?? 'https://v4ir0xojhi.execute-api.us-east-1.amazonaws.com/prod'
const cognitoClientId = import.meta.env.VITE_COGNITO_CLIENT_ID ?? '71r59jf5vri40sjnpr86sisqm2'
const cognitoRegion = 'us-east-1'
const sessionKey = 'opsflow.cognito-session'

export type Session = { idToken: string; expiresAt: number }
type UploadType = 'production' | 'bulk-plan' | 'projection'

export function loadSession(): Session | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(sessionKey) ?? 'null') as Session | null
    return value && value.expiresAt > Date.now() ? value : null
  } catch { return null }
}

export function clearSession() { sessionStorage.removeItem(sessionKey) }

export async function signIn(username: string, password: string): Promise<Session> {
  const response = await fetch(`https://cognito-idp.${cognitoRegion}.amazonaws.com/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AWSCognitoIdentityProviderService.InitiateAuth' },
    body: JSON.stringify({ AuthFlow: 'USER_PASSWORD_AUTH', ClientId: cognitoClientId, AuthParameters: { USERNAME: username, PASSWORD: password } }),
  })
  const data = await response.json() as { AuthenticationResult?: { IdToken?: string; ExpiresIn?: number }; __type?: string; message?: string; ChallengeName?: string }
  const token = data.AuthenticationResult?.IdToken
  if (!response.ok || !token) {
    if (data.ChallengeName === 'NEW_PASSWORD_REQUIRED') throw new Error('Set a permanent password for this Cognito user, then sign in again.')
    throw new Error(data.message ?? data.__type ?? 'Sign-in failed.')
  }
  const session = { idToken: token, expiresAt: Date.now() + (data.AuthenticationResult?.ExpiresIn ?? 3600) * 1000 }
  sessionStorage.setItem(sessionKey, JSON.stringify(session))
  return session
}

export async function uploadWorkbook(type: UploadType, file: File, token: string) {
  const response = await request(`/uploads/${type}`, token, {
    method: 'POST',
    body: JSON.stringify({ fileName: file.name, fileSize: file.size, contentType: file.type || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
  })
  const data = await response.json() as { message?: string; uploadUrl?: string; importId?: string }
  if (!response.ok || !data.uploadUrl || !data.importId) throw new Error(data.message ?? 'Could not prepare the workbook upload.')
  const upload = await fetch(data.uploadUrl, { method: 'PUT', headers: { 'content-type': file.type || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, body: file })
  if (!upload.ok) throw new Error('The workbook could not be uploaded to S3.')
  return data.importId
}

export async function fetchWeeks(token: string) {
  const response = await request('/weeks', token)
  const data = await response.json() as { weeks?: string[]; message?: string }
  if (!response.ok) throw new Error(data.message ?? 'Could not load operational weeks.')
  return data.weeks ?? []
}

export async function fetchWeek(week: string, token: string) {
  const response = await request(`/weeks/${encodeURIComponent(week)}`, token)
  if (!response.ok) throw new Error('Could not load the selected operational week.')
  return response.json()
}

export async function fetchImportStatus(importId: string, token: string) {
  const response = await request(`/imports/${encodeURIComponent(importId)}`, token)
  const data = await response.json() as { status?: 'PENDING_UPLOAD' | 'PROCESSING' | 'PROCESSED' | 'FAILED'; message?: string }
  if (!response.ok || !data.status) throw new Error(data.message ?? 'Could not check upload progress.')
  return data.status
}

export async function fetchProjectionRequirements(week: string, token: string) {
  const response = await request(`/projections?week=${encodeURIComponent(week)}`, token)
  const data = await response.json() as { requirements?: unknown[]; message?: string }
  if (!response.ok) throw new Error(data.message ?? 'Could not load projection mappings.')
  return data.requirements ?? []
}

function request(path: string, token: string, init: RequestInit = {}) {
  return fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: token, ...(init.headers ?? {}) },
  })
}
