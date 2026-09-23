const apiBaseUrl = import.meta.env.VITE_OPSFLOW_API_URL ?? 'https://v4ir0xojhi.execute-api.us-east-1.amazonaws.com/prod'
const cognitoClientId = import.meta.env.VITE_COGNITO_CLIENT_ID ?? '71r59jf5vri40sjnpr86sisqm2'
const cognitoRegion = 'us-east-1'
const sessionKey = 'opsflow.cognito-session'
export const operationalYear = Number(import.meta.env.VITE_OPSFLOW_OPERATIONAL_YEAR ?? '2026')

export type Session = { idToken: string; refreshToken?: string; expiresAt: number; startedAt: number }
type UploadType = 'production' | 'bulk-plan' | 'projection'
type AuthenticationResult = { IdToken?: string; RefreshToken?: string; ExpiresIn?: number }
let refreshInFlight: Promise<Session> | undefined

export function loadSession(): Session | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(sessionKey) ?? 'null') as Session | null
    // A valid refresh token lets an expired ID token be renewed without
    // interrupting an operator in the middle of a production shift.
    return value && (value.expiresAt > Date.now() || value.refreshToken)
      ? { ...value, startedAt: value.startedAt ?? Date.now() }
      : null
  } catch { return null }
}

export function clearSession() { sessionStorage.removeItem(sessionKey) }

export async function signIn(username: string, password: string): Promise<Session> {
  const response = await fetch(`https://cognito-idp.${cognitoRegion}.amazonaws.com/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AWSCognitoIdentityProviderService.InitiateAuth' },
    body: JSON.stringify({ AuthFlow: 'USER_PASSWORD_AUTH', ClientId: cognitoClientId, AuthParameters: { USERNAME: username, PASSWORD: password } }),
  })
  const data = await response.json() as { AuthenticationResult?: AuthenticationResult; __type?: string; message?: string; ChallengeName?: string }
  const token = data.AuthenticationResult?.IdToken
  if (!response.ok || !token) {
    if (data.ChallengeName === 'NEW_PASSWORD_REQUIRED') throw new Error('Set a permanent password for this Cognito user, then sign in again.')
    throw new Error(data.message ?? data.__type ?? 'Sign-in failed.')
  }
  const session = createSession(token, data.AuthenticationResult?.RefreshToken, data.AuthenticationResult?.ExpiresIn)
  saveSession(session)
  return session
}

async function refreshSession(session: Session): Promise<Session> {
  if (!session.refreshToken) throw new Error('Your session has expired. Please sign in again.')
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = (async () => {
    const response = await fetch(`https://cognito-idp.${cognitoRegion}.amazonaws.com/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AWSCognitoIdentityProviderService.InitiateAuth' },
      body: JSON.stringify({ AuthFlow: 'REFRESH_TOKEN_AUTH', ClientId: cognitoClientId, AuthParameters: { REFRESH_TOKEN: session.refreshToken } }),
    })
    const data = await response.json() as { AuthenticationResult?: AuthenticationResult; __type?: string; message?: string }
    const idToken = data.AuthenticationResult?.IdToken
    if (!response.ok || !idToken) {
      clearSession()
      throw new Error(data.message ?? data.__type ?? 'Your session has expired. Please sign in again.')
    }
    const refreshed = createSession(idToken, data.AuthenticationResult?.RefreshToken ?? session.refreshToken, data.AuthenticationResult?.ExpiresIn, session.startedAt)
    saveSession(refreshed)
    return refreshed
  })()
  try { return await refreshInFlight }
  finally { refreshInFlight = undefined }
}

function createSession(idToken: string, refreshToken: string | undefined, expiresIn: number | undefined, startedAt = Date.now()): Session {
  return { idToken, refreshToken, expiresAt: Date.now() + (expiresIn ?? 3600) * 1000, startedAt }
}

function saveSession(session: Session) { sessionStorage.setItem(sessionKey, JSON.stringify(session)) }

export async function continueSession(): Promise<Session> {
  const current = loadSession()
  if (!current) throw new Error('Your session has expired. Please sign in again.')
  const refreshed = await refreshSession(current)
  const continued = { ...refreshed, startedAt: Date.now() }
  saveSession(continued)
  return continued
}

export type WorkbookUpload = { importId: string; week?: number; area?: string }
const supportedWorkbookExtension = /\.(xlsx|xlsm|xls|csv)$/i
const standardizedWorkbookType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export async function uploadWorkbook(type: UploadType, file: File, token: string, operationalWeek?: number): Promise<WorkbookUpload> {
  const workbook = await standardizeWorkbook(file)
  const response = await request(`/uploads/${type}`, token, {
    method: 'POST',
    body: JSON.stringify({ operationalYear, operationalWeek, fileName: workbook.name, fileSize: workbook.size, contentType: standardizedWorkbookType }),
  })
  const data = await response.json() as { message?: string; uploadUrl?: string; importId?: string; week?: number; area?: string }
  if (!response.ok || !data.uploadUrl || !data.importId) throw new Error(data.message ?? 'Could not prepare the workbook upload.')
  const upload = await fetch(data.uploadUrl, { method: 'PUT', headers: { 'content-type': standardizedWorkbookType }, body: workbook })
  if (!upload.ok) throw new Error('The workbook could not be uploaded to S3.')
  return { importId: data.importId, week: data.week, area: data.area }
}

async function standardizeWorkbook(file: File): Promise<File> {
  if (!supportedWorkbookExtension.test(file.name)) throw new Error('Use an .xlsx, .xlsm, .xls, or .csv file.')
  if (file.name.toLowerCase().endsWith('.xlsx')) return file
  try {
    const source = XLSX.read(await file.arrayBuffer(), { type: 'array', raw: true })
    const contents = XLSX.write(source, { bookType: 'xlsx', type: 'array' })
    const name = file.name.replace(/\.(xlsm|xls|csv)$/i, '.xlsx')
    return new File([contents], name, { type: standardizedWorkbookType })
  } catch {
    throw new Error('The selected file could not be read. Use a valid .xlsx, .xlsm, .xls, or .csv file.')
  }
}

export async function fetchWeeks(token: string) {
  const response = await request(`/weeks?year=${operationalYear}`, token)
  const data = await response.json() as { weeks?: string[]; message?: string }
  if (!response.ok) throw new Error(data.message ?? 'Could not load operational weeks.')
  return data.weeks ?? []
}

export async function fetchWeek(week: string, token: string) {
  const response = await request(`/weeks/${encodeURIComponent(week)}?year=${operationalYear}`, token)
  if (!response.ok) throw new Error('Could not load the selected operational week.')
  return response.json()
}

export type ProjectionMarket = { market: string; productionSourceArea: string; productionSourceWeek: number; mappings: Record<string, string[]> }

export async function fetchProjectionMarkets(week: string, token: string): Promise<ProjectionMarket[]> {
  const response = await request(`/projections?year=${operationalYear}&week=${encodeURIComponent(week)}`, token)
  const data = await response.json() as { markets?: ProjectionMarket[]; message?: string }
  if (!response.ok) throw new Error(data.message ?? 'Could not load projection mappings.')
  return data.markets ?? []
}

export async function updateProductionStatus(year: number, week: string, area: string, routeId: string, machine: string, zip: string, status: string, version: number | undefined, token: string, notes?: string) {
  const response = await request(`/production/${year}/${encodeURIComponent(week)}/${encodeURIComponent(area)}/${encodeURIComponent(routeId)}/status`, token, {
    method: 'PATCH', body: JSON.stringify({ status, machine, zip, version, ...(notes === undefined ? {} : { notes }) }),
  })
  const data = await response.json() as { message?: string }
  if (!response.ok) throw new Error(data.message ?? 'Could not update production status.')
  return data
}

export async function moveProductionZip(year: number, week: string, area: string, routeId: string, machine: string, zip: string, targetMachine: string, token: string) {
  const response = await request(`/production/${year}/${encodeURIComponent(week)}/${encodeURIComponent(area)}/${encodeURIComponent(routeId)}/move`, token, {
    method: 'PATCH', body: JSON.stringify({ machine, zip, targetMachine }),
  })
  const data = await response.json() as { message?: string; machine?: string; scheduledMachine?: string; movedAt?: string; transferHistory?: Array<{ from: string; to: string; movedAt: string }> }
  if (!response.ok) throw new Error(data.message ?? 'Could not move the production ZIP.')
  return data
}

export async function updateMachineRate(year: number, week: string, machine: string, rate: number, token: string) {
  const response = await request(`/production/${year}/${encodeURIComponent(week)}/machine-rates/${encodeURIComponent(machine)}`, token, {
    method: 'PATCH', body: JSON.stringify({ rate }),
  })
  const data = await response.json() as { message?: string; machine?: string; rate?: number }
  if (!response.ok) throw new Error(data.message ?? 'Could not update the machine hourly rate.')
  return data
}

export async function updateShippingStatus(year: number, week: string, loadNumber: string, status: string, token: string, statusAt?: string) {
  const response = await request(`/shipping/${year}/${encodeURIComponent(week)}/${encodeURIComponent(loadNumber)}/status`, token, {
    method: 'PATCH', body: JSON.stringify({ status, statusAt }),
  })
  const data = await response.json() as { message?: string; number?: string; status?: string; statusUpdatedAt?: string | null; dispatchedAt?: string | null }
  if (!response.ok) throw new Error(data.message ?? 'Could not update Shipping status.')
  return data
}

export async function updateShippingHubAssignment(year: number, week: string, loadNumber: string, hubTrip: string | undefined, token: string) {
  const response = await request(`/shipping/${year}/${encodeURIComponent(week)}/${encodeURIComponent(loadNumber)}/hub-assignment`, token, {
    method: 'PATCH', body: JSON.stringify({ hubTrip: hubTrip || null }),
  })
  const data = await response.json() as { message?: string; number?: string; assignedHubTrip?: string | null }
  if (!response.ok) throw new Error(data.message ?? 'Could not update the hub assignment.')
  return data
}

async function request(path: string, token: string, init: RequestInit = {}) {
  const send = (authorization: string) => fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization, ...(init.headers ?? {}) },
  })
  const stored = loadSession()
  const authorization = stored && stored.expiresAt - Date.now() <= 120_000
    ? (await refreshSession(stored)).idToken
    : stored?.idToken ?? token
  let response = await send(authorization)
  // A request can begin just as Cognito expires its token. Refresh once and
  // retry so normal operator activity never requires a page reload.
  if ((response.status === 401 || response.status === 403) && stored?.refreshToken) {
    response = await send((await refreshSession(stored)).idToken)
  }
  return response
}
import * as XLSX from 'xlsx'
