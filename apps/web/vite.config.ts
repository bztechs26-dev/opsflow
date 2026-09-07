import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import react from '@vitejs/plugin-react'
import * as XLSX from 'xlsx'
import { defineConfig, type Plugin } from 'vite'

type UploadRow = { id: number; week: string; fileName: string; fileSize: number; status: 'MAPPED'; tripCount: number; requirementCount: number; uploadedAt: string }
type RequirementRow = { trip: string; atz: string; jobNumber: string; requiredHH: number; sourceName: string }
type TripRequirement = Omit<RequirementRow, 'sourceName'>

const workspaceRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..')
const localDataDirectory = resolve(workspaceRoot, '.opsflow-local')
const sourceDirectory = resolve(localDataDirectory, 'projection-files')
mkdirSync(sourceDirectory, { recursive: true })
const database = new DatabaseSync(resolve(localDataDirectory, 'opsflow.sqlite'))
database.exec(`CREATE TABLE IF NOT EXISTS projection_uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT, week TEXT NOT NULL, file_name TEXT NOT NULL,
  file_size INTEGER NOT NULL, file_hash TEXT NOT NULL UNIQUE, status TEXT NOT NULL,
  trip_count INTEGER NOT NULL DEFAULT 0, zip_count INTEGER NOT NULL DEFAULT 0, uploaded_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trip_requirements (
  id INTEGER PRIMARY KEY AUTOINCREMENT, week TEXT NOT NULL, trip TEXT NOT NULL, atz TEXT NOT NULL,
  job_number TEXT NOT NULL, required_hh INTEGER NOT NULL, source_upload_id INTEGER NOT NULL,
  UNIQUE(week, trip, atz, job_number, source_upload_id),
  FOREIGN KEY(source_upload_id) REFERENCES projection_uploads(id)
);
CREATE INDEX IF NOT EXISTS trip_requirement_lookup ON trip_requirements(week, trip);
CREATE INDEX IF NOT EXISTS trip_requirement_job_atz ON trip_requirements(job_number, atz);`)

function projectionApi(): Plugin {
  return { name: 'opsflow-local-projection-api', configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      const requestUrl = new URL(request.url ?? '/', 'http://localhost')
      if (requestUrl.pathname === '/api/projections' && request.method === 'GET') {
        const week = requestUrl.searchParams.get('week')
        const uploads = database.prepare(`SELECT id, week, file_name AS fileName, file_size AS fileSize, status, trip_count AS tripCount, zip_count AS requirementCount, uploaded_at AS uploadedAt FROM projection_uploads ORDER BY id DESC`).all() as UploadRow[]
        const requirements = week ? database.prepare(`SELECT requirement.trip, requirement.atz, requirement.job_number AS jobNumber, requirement.required_hh AS requiredHH, upload.file_name AS sourceName FROM trip_requirements requirement JOIN projection_uploads upload ON upload.id = requirement.source_upload_id WHERE requirement.week = ? ORDER BY requirement.id DESC`).all(week) as RequirementRow[] : []
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ uploads, requirements })); return
      }
      if (requestUrl.pathname === '/api/projections/upload' && request.method === 'POST') {
        try {
          const headers = new Headers()
          for (const [name, value] of Object.entries(request.headers)) if (typeof value === 'string') headers.set(name, value)
          const form = await new Request('http://localhost/api/projections/upload', { method: 'POST', headers, body: request as unknown as ReadableStream, duplex: 'half' }).formData()
          const week = String(form.get('week') ?? '').trim(); const file = form.get('file')
          if (!/^\d{1,2}$/.test(week) || !file || typeof file === 'string') throw new Error('Provide a shipping week and ZIP/TR workbook.')
          if (file.name.split('.').pop()?.toLowerCase() !== 'xlsx') throw new Error('Use an Excel (.xlsx) ZIP/TR mapping workbook.')
          const fileWeek = weekFromFileName(file.name)
          if (!fileWeek) throw new Error('Include the operational week in the file name, for example “BE Wk 36.xlsx”.')
          if (fileWeek !== week) throw new Error(`${file.name} is for Week ${fileWeek}, but Week ${week} is selected. Select Week ${fileWeek} and try again.`)
          const buffer = Buffer.from(await file.arrayBuffer()); const hash = createHash('sha256').update(buffer).digest('hex')
          if (database.prepare('SELECT id FROM projection_uploads WHERE file_hash = ?').get(hash)) { response.statusCode = 409; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ message: 'This exact ZIP/TR workbook is already stored.' })); return }
          const parsed = parseTripMappingWorkbook(buffer)
          if (!parsed.requirements.length) throw new Error('No usable ZIP/TR rows were found. The workbook must have ZIP in column A and TR in column C.')
          const uploadedAt = new Date().toISOString()
          const insert = database.prepare('INSERT INTO projection_uploads (week, file_name, file_size, file_hash, status, trip_count, zip_count, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          const result = insert.run(week, file.name, buffer.length, hash, 'MAPPED', parsed.tripCount, parsed.requirements.length, uploadedAt)
          const uploadId = Number(result.lastInsertRowid)
          writeFileSync(resolve(sourceDirectory, `${uploadId}-${safeName(file.name)}`), buffer)
          const insertRequirement = database.prepare('INSERT OR IGNORE INTO trip_requirements (week, trip, atz, job_number, required_hh, source_upload_id) VALUES (?, ?, ?, ?, ?, ?)')
          for (const requirement of parsed.requirements) insertRequirement.run(week, requirement.trip, requirement.atz, requirement.jobNumber, requirement.requiredHH, uploadId)
          response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ message: `Stored ${parsed.requirements.length} ZIP/TR mappings across ${parsed.tripCount} trips. Job number and household quantities were included where available.` }))
        } catch (error) { response.statusCode = 400; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ message: error instanceof Error ? error.message : 'The ZIP/TR workbook could not be stored.' })) }
        return
      }
      next()
    })
  } }
}

function parseTripMappingWorkbook(buffer: Buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' }); const requirements: TripRequirement[] = []; const trips = new Set<string>()
  for (const sheetName of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], { header: 1, defval: '' })
    const headerRow = rows.findIndex((row) => cellText(row[0]).toLowerCase() === 'zip' && cellText(row[2]).toLowerCase() === 'tr')
    if (headerRow < 0) continue
    for (const row of rows.slice(headerRow + 1)) {
      const atz = normalizeAtz(cellText(row[0])); const trip = cellText(row[2])
      if (!atz || !/^\d+$/.test(trip)) continue
      trips.add(trip)
      requirements.push({ trip, atz, jobNumber: cellText(row[4]), requiredHH: Number(cellText(row[5]).replaceAll(',', '')) || 0 })
    }
  }
  const aggregated = new Map<string, TripRequirement>()
  for (const item of requirements) { const key = `${item.trip}|${item.atz}|${item.jobNumber}`; const existing = aggregated.get(key); aggregated.set(key, existing ? { ...existing, requiredHH: existing.requiredHH + item.requiredHH } : item) }
  return { requirements: [...aggregated.values()], tripCount: trips.size }
}

function cellText(value: unknown) { return String(value ?? '').trim() }
function weekFromFileName(fileName: string) { return fileName.match(/\b(?:wk|week)[\s_-]*(\d{1,2})\b/i)?.[1] }
function normalizeAtz(value: string) { return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '') }
function safeName(fileName: string) { return fileName.replace(/[^a-z0-9._-]/gi, '_') }
export default defineConfig({ plugins: [react(), projectionApi()] })
