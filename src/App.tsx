import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import './App.css'

type UsageLog = {
  id: number | string
  matricula: string | null
  method: string
  path: string
  status: number
  createdAt: string
}

type Session = {
  adminToken: string
  httpBase: string
  wsPath: string
}

type ConnectionState = {
  mode: 'idle' | 'websocket' | 'polling'
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  detail?: string
  lastEvent?: string
}

const DEFAULT_HTTP_BASE = 'https://leiame.app'
const DEFAULT_WS_PATH = '/reports/usage/stream'
const STORAGE_KEY = 'travel-planner-panel/session'
const MAX_LOGS = 400
const MINUTES_MAX = 180

const EXERCISES = [
  { id: 1, title: 'Cadastro de cliente', keywords: ['/clients'] },
  { id: 2, title: 'Destinos e hotéis', keywords: ['/locations', '/hotels'] },
  { id: 3, title: 'Detalhes de hotel', keywords: ['/hotels/', '/availability'] },
  { id: 4, title: 'Buscar voos', keywords: ['/planes'] },
  { id: 5, title: 'Ofertas e descontos', keywords: ['/offers'] },
  { id: 6, title: 'Registrar compra', keywords: ['/purchases'] },
  { id: 7, title: 'Alterar / cancelar compra', keywords: ['/purchases'] },
  { id: 8, title: 'Avaliação de hotel', keywords: ['/reviews'] },
  { id: 9, title: 'Itinerário', keywords: ['/itineraries', '/bookings'] },
  { id: 10, title: 'Resumo / relatórios', keywords: ['/reports', '/auth/login'] },
] as const

function loadStoredSession(): Session | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Session
    if (!parsed.adminToken || !parsed.httpBase) return null
    return {
      adminToken: parsed.adminToken,
      httpBase: parsed.httpBase,
      wsPath: parsed.wsPath || DEFAULT_WS_PATH,
    }
  } catch (err) {
    console.warn('Unable to read stored session', err)
    return null
  }
}

function normalizeBaseUrl(url: string) {
  const cleaned = url.trim()
  if (!cleaned) return DEFAULT_HTTP_BASE
  return cleaned.replace(/\/+$/, '')
}

function buildWsUrl(session: Session, matricula: string) {
  const httpBase = normalizeBaseUrl(session.httpBase)
  const baseUrl = new URL(httpBase)
  baseUrl.protocol = baseUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  const wsPath = session.wsPath || DEFAULT_WS_PATH
  baseUrl.pathname = wsPath.startsWith('/') ? wsPath : `/${wsPath}`
  baseUrl.searchParams.set('adminToken', session.adminToken)
  if (matricula) baseUrl.searchParams.set('matricula', matricula)
  baseUrl.searchParams.set('client', 'travel-planner-panel')
  return baseUrl.toString()
}

function mergeLogs(existing: UsageLog[], incoming: UsageLog[]) {
  const map = new Map<string | number, UsageLog>()
  const all = [...incoming, ...existing]
  all.forEach((log) => {
    const key = log.id ?? `${log.matricula || 'anon'}-${log.path}-${log.createdAt}`
    map.set(key, log)
  })
  const sorted = Array.from(map.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )
  return sorted.slice(0, MAX_LOGS)
}

function formatTime(input: string) {
  try {
    return new Date(input).toLocaleTimeString()
  } catch {
    return input
  }
}

function formatDateTime(input: string) {
  try {
    const date = new Date(input)
    return date.toLocaleString()
  } catch {
    return input
  }
}

function App() {
  const [session, setSession] = useState<Session | null>(() => loadStoredSession())
  const [matriculaScope, setMatriculaScope] = useState('')
  const [matriculaDraft, setMatriculaDraft] = useState('')
  const [search, setSearch] = useState('')
  const [windowMinutes, setWindowMinutes] = useState(5)
  const [logs, setLogs] = useState<UsageLog[]>([])
  const [connection, setConnection] = useState<ConnectionState>({
    mode: 'idle',
    status: 'disconnected',
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const pollRef = useRef<number | null>(null)
  const keepaliveRef = useRef<number | null>(null)
  const liveMarker = useRef<number>(Date.now())
  const cancelRef = useRef(false)

  useEffect(() => {
    if (!session) return
    cancelRef.current = false

    const syncSnapshot = async () => {
      setLoading(true)
      try {
        const data = await fetchUsage(session, matriculaScope)
        if (!cancelRef.current) {
          setLogs((current) => mergeLogs(current, data))
          setConnection((prev) =>
            prev.mode === 'idle'
              ? { mode: 'polling', status: 'connected', detail: 'HTTP snapshot' }
              : prev,
          )
        }
      } catch (err) {
        if (!cancelRef.current) {
          setError(
            err instanceof Error ? err.message : 'Falha ao puxar /reports/usage para início',
          )
          setConnection({
            mode: 'idle',
            status: 'error',
            detail: 'Snapshot falhou',
          })
        }
      } finally {
        if (!cancelRef.current) setLoading(false)
      }
    }

    const start = () => {
      cleanupConnections()
      syncSnapshot()
      connectWebSocket(session, matriculaScope, cancelRef)
    }

    start()
    return () => {
      cancelRef.current = true
      cleanupConnections()
    }
  }, [session, matriculaScope])

  const cleanupConnections = () => {
    if (keepaliveRef.current) {
      clearInterval(keepaliveRef.current)
      keepaliveRef.current = null
    }
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }
  }

  const startPolling = (activeSession: Session, matricula: string) => {
    if (keepaliveRef.current) {
      clearInterval(keepaliveRef.current)
      keepaliveRef.current = null
    }
    if (pollRef.current) clearInterval(pollRef.current)
    const poll = async () => {
      try {
        const data = await fetchUsage(activeSession, matricula)
        if (cancelRef.current) return
        setLogs((current) => mergeLogs(current, data))
        setConnection({
          mode: 'polling',
          status: 'connected',
          detail: 'HTTP polling (fallback)',
          lastEvent: new Date().toISOString(),
        })
      } catch (err) {
        if (cancelRef.current) return
        setConnection({
          mode: 'polling',
          status: 'error',
          detail: err instanceof Error ? err.message : 'Erro no polling',
        })
      }
    }
    poll()
    pollRef.current = window.setInterval(poll, 4000)
  }

  const startKeepalive = (activeSession: Session, matricula: string) => {
    if (keepaliveRef.current) clearInterval(keepaliveRef.current)
    const tick = async () => {
      if (cancelRef.current) return
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
      try {
        const data = await fetchUsage(activeSession, matricula)
        setLogs((current) => mergeLogs(current, data))
        setConnection((prev) => ({
          ...prev,
          lastEvent: new Date().toISOString(),
        }))
      } catch (err) {
        console.warn('Keepalive polling failed', err)
      }
    }
    keepaliveRef.current = window.setInterval(tick, 5000)
  }

const connectWebSocket = (
  activeSession: Session,
  matricula: string,
  cancelled: MutableRefObject<boolean>,
) => {
    const url = buildWsUrl(activeSession, matricula)
    try {
      const ws = new WebSocket(url)
      wsRef.current = ws
      setConnection({ mode: 'websocket', status: 'connecting', detail: url })
      ws.onopen = () => {
        if (cancelled.current || wsRef.current !== ws) return
        setConnection({ mode: 'websocket', status: 'connected', detail: url })
        startKeepalive(activeSession, matricula)
      }
      ws.onerror = () => {
        if (cancelled.current || wsRef.current !== ws) return
        if (keepaliveRef.current) {
          clearInterval(keepaliveRef.current)
          keepaliveRef.current = null
        }
        setConnection({
          mode: 'websocket',
          status: 'error',
          detail: 'WebSocket falhou, trocando para polling',
        })
        startPolling(activeSession, matricula)
      }
      ws.onclose = () => {
        if (cancelled.current || wsRef.current !== ws) return
        if (keepaliveRef.current) {
          clearInterval(keepaliveRef.current)
          keepaliveRef.current = null
        }
        startPolling(activeSession, matricula)
      }
      ws.onmessage = (event) => {
        if (cancelled.current || wsRef.current !== ws) return
        try {
          const parsed = JSON.parse(event.data)
          const incoming = Array.isArray(parsed) ? parsed : [parsed]
          const normalized = incoming
            .map((item) => normalizeLog(item))
            .filter((item): item is UsageLog => Boolean(item))
          if (normalized.length) {
            liveMarker.current = Date.now()
            setLogs((current) => mergeLogs(current, normalized))
            setConnection((prev) => ({
              ...prev,
              lastEvent: new Date().toISOString(),
              status: 'connected',
            }))
          }
        } catch (err) {
          console.warn('Failed to parse WebSocket message', err)
        }
      }
    } catch (err) {
      setConnection({
        mode: 'websocket',
        status: 'error',
        detail: err instanceof Error ? err.message : 'Erro ao abrir WebSocket',
      })
      startPolling(activeSession, matricula)
    }
  }

  const filteredLogs = useMemo(() => {
    const cutoff = Date.now() - windowMinutes * 60 * 1000
    return logs.filter((log) => {
      if (!log.matricula) return false
      const ts = new Date(log.createdAt).getTime()
      if (Number.isNaN(ts) || ts < cutoff) return false
      const matchesText =
        !search ||
        log.path.toLowerCase().includes(search.toLowerCase()) ||
        log.method.toLowerCase().includes(search.toLowerCase())
      return matchesText
    })
  }, [logs, search, windowMinutes])

  const methodCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    filteredLogs.forEach((log) => {
      counts[log.method] = (counts[log.method] || 0) + 1
    })
    return Object.entries(counts).sort((a, b) => b[1] - a[1])
  }, [filteredLogs])

  const exerciseCounts = useMemo(() => {
    return EXERCISES.map((item) => ({
      ...item,
      count: filteredLogs.filter((log) =>
        item.keywords.some((k) => log.path.toLowerCase().includes(k.toLowerCase())),
      ).length,
    }))
  }, [filteredLogs])

  const latestUpdate = filteredLogs[0]?.createdAt

  const uniqueMatriculas = useMemo(() => {
    return Array.from(
      new Set(filteredLogs.map((l) => l.matricula).filter((m): m is string => Boolean(m))),
    )
  }, [filteredLogs])

  const matriculaActivity = useMemo(() => {
    const map = new Map<
      string,
      { matricula: string; lastTs: number; lastPath: string; lastMethod: string; count: number }
    >()
    filteredLogs.forEach((log) => {
      if (!log.matricula) return
      const key = log.matricula
      const ts = new Date(log.createdAt).getTime()
      const existing = map.get(key)
      if (!existing) {
        map.set(key, {
          matricula: key,
          lastTs: ts,
          lastPath: log.path,
          lastMethod: log.method,
          count: 1,
        })
        return
      }
      const newest = ts > existing.lastTs
      map.set(key, {
        matricula: key,
        lastTs: newest ? ts : existing.lastTs,
        lastPath: newest ? log.path : existing.lastPath,
        lastMethod: newest ? log.method : existing.lastMethod,
        count: existing.count + 1,
      })
    })
    return Array.from(map.values()).sort((a, b) => b.count - a.count || b.lastTs - a.lastTs)
  }, [filteredLogs])

  const handleLogin = async (payload: Session) => {
    setLoading(true)
    setError(null)
    try {
      const normalized: Session = {
        adminToken: payload.adminToken.trim(),
        httpBase: normalizeBaseUrl(payload.httpBase || DEFAULT_HTTP_BASE),
        wsPath: payload.wsPath?.trim() || DEFAULT_WS_PATH,
      }
      await validateAdmin(normalized)
      localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized))
      setSession(normalized)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao validar token')
    } finally {
      setLoading(false)
    }
  }

  const handleLogout = () => {
    cleanupConnections()
    setSession(null)
    setLogs([])
    setMatriculaScope('')
    setMatriculaDraft('')
    setConnection({ mode: 'idle', status: 'disconnected' })
    localStorage.removeItem(STORAGE_KEY)
  }

  const statusLabel = connection.mode === 'websocket'
    ? `WebSocket · ${connection.status}`
    : connection.mode === 'polling'
      ? `Polling · ${connection.status}`
      : 'Offline'

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">
          <span className="pill">live</span>
          <div>
            <div className="brand-title">Travel Planner Observer</div>
            <div className="brand-sub">Matrícula x método em tempo real</div>
          </div>
        </div>
        {session ? (
          <div className="top-actions">
            <div className={`status-badge status-${connection.status}`}>
              {statusLabel}
            </div>
            <button className="ghost" onClick={handleLogout}>
              Sair
            </button>
          </div>
        ) : null}
      </header>

      {!session ? (
        <LoginPanel
          defaultHttpBase={DEFAULT_HTTP_BASE}
          defaultWsPath={DEFAULT_WS_PATH}
          onSubmit={handleLogin}
          loading={loading}
          error={error}
          remembered={loadStoredSession()}
        />
      ) : (
        <main className="layout">
          <section className="controls">
            <div>
              <p className="label">Backend</p>
              <div className="muted">{session.httpBase}</div>
              <div className="muted">WS path: {session.wsPath}</div>
            </div>
            <form
              className="matricula-form"
              onSubmit={(e) => {
                e.preventDefault()
                setMatriculaScope(matriculaDraft.trim())
              }}
            >
              <label className="label" htmlFor="matricula-scope">
                Filtrar matrícula (backend)
              </label>
              <div className="inline">
                <input
                  id="matricula-scope"
                  value={matriculaDraft}
                  onChange={(e) => setMatriculaDraft(e.target.value)}
                  placeholder="Opcional · 7 dígitos"
                  autoComplete="off"
                />
                <button type="submit" className="primary">
                  Aplicar
                </button>
              </div>
              <p className="muted small">
                Essa matrícula vai no WebSocket/polling; deixe vazio para observar tudo.
              </p>
            </form>
            <div className="search-block">
              <label className="label" htmlFor="search">
                Filtro local (path ou método)
              </label>
              <input
                id="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="/hotels, POST, /reports/usage..."
              />
            </div>
            <div className="window-block">
              <label className="label" htmlFor="window">
                Janela (minutos)
              </label>
              <div className="inline window-inline">
                <input
                  id="window"
                  type="range"
                  min={1}
                  max={MINUTES_MAX}
                  step={1}
                  value={windowMinutes}
                  onChange={(e) => setWindowMinutes(Number(e.target.value))}
                />
                <div className="window-value">{windowMinutes}m</div>
              </div>
              <p className="muted small">Corta eventos mais antigos que essa janela (até 3h).</p>
            </div>
          </section>

          <section className="stats">
            <StatCard title="Eventos no painel" value={filteredLogs.length} hint="limite 400" />
            <StatCard
              title="Matrículas vistas"
              value={uniqueMatriculas.length}
            />
            <StatCard
              title="Último evento"
              value={latestUpdate ? formatTime(latestUpdate) : '—'}
              hint={connection.lastEvent ? `ping: ${formatTime(connection.lastEvent)}` : ''}
            />
            <StatCard
              title="Estado"
              value={connection.status === 'connected' ? 'Online' : connection.status}
              hint={connection.detail}
            />
          </section>

          <section className="panels">
            <div className="panel">
              <div className="panel-head">
                <div>
                  <h2>Trilhas do exercício</h2>
                  <p className="muted small">
                    Agrupado pelos passos de exercise-instructions-plain-pt-br.md (últimos {windowMinutes}m)
                  </p>
                </div>
              </div>
              <div className="exercise-grid">
                {exerciseCounts.map((item) => (
                  <div key={item.id} className="exercise-card">
                    <div className="exercise-top">
                      <div className="exercise-id">#{item.id}</div>
                      <div className="exercise-count">{item.count}</div>
                    </div>
                    <div className="exercise-title">{item.title}</div>
                    <div className="exercise-keywords">
                      {item.keywords.join(' · ')}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="panel">
              <div className="panel-head">
                <div>
                  <h2>Métodos mais usados</h2>
                  <p className="muted small">GET/POST/PUT/PATCH/DELETE na janela atual</p>
                </div>
                <button
                  className="ghost"
                  onClick={() => {
                    if (session) {
                      cleanupConnections()
                      cancelRef.current = false
                      connectWebSocket(session, matriculaScope, cancelRef)
                    }
                  }}
                >
                  Reabrir WebSocket
                </button>
              </div>
              <div className="methods">
                {methodCounts.length === 0 && <p className="muted">Sem eventos ainda.</p>}
                {methodCounts.map(([method, count]) => (
                  <div key={method} className="method-row">
                    <div className={`method-pill method-${method.toLowerCase()}`}>{method}</div>
                    <div className="bar">
                      <div
                        className="bar-fill"
                        style={{ width: `${Math.min(100, (count / methodCounts[0][1]) * 100)}%` }}
                      />
                    </div>
                    <div className="muted">{count}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="panel">
              <div className="panel-head">
                <div>
                  <h2>Matrículas (mais recentes)</h2>
                  <p className="muted small">
                    Ordenado por volume e último evento na janela de {windowMinutes}m
                  </p>
                </div>
              </div>
              <div className="matriculas">
                {matriculaActivity.length === 0 && <p className="muted">Sem eventos ainda.</p>}
                {matriculaActivity.map((item) => (
                  <div key={item.matricula} className="matricula-row">
                    <div className="matricula-id">{item.matricula}</div>
                    <div className="matricula-path truncate">
                      <span className={`method-pill method-${item.lastMethod.toLowerCase()}`}>
                        {item.lastMethod}
                      </span>
                      <span className="muted">{item.lastPath}</span>
                    </div>
                  <div className="matricula-meta">
                      <div className="muted small">última</div>
                      <div>{formatDateTime(new Date(item.lastTs).toISOString())}</div>
                    </div>
                    <div className="matricula-count">
                      <div className="muted small">reqs</div>
                      <div className="count-chip">{item.count}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="panel live">
            <div className="panel-head">
              <div>
                <h2>Live tail (últimos {Math.min(filteredLogs.length, 80)})</h2>
                <p className="muted small">Deixe a aba aberta para acompanhar em tempo real.</p>
              </div>
              {loading && <div className="status-badge status-connecting">Atualizando…</div>}
            </div>
            <div className="table">
              <div className="table-head">
                <span>Método</span>
                <span>Path</span>
                <span>Matrícula</span>
                <span>Status</span>
                <span>Horário</span>
              </div>
              {filteredLogs.slice(0, 80).map((log, idx) => (
                <div
                  key={`${log.id}-${log.createdAt}-${idx}`}
                  className={`table-row ${log.createdAt && new Date(log.createdAt).getTime() >= liveMarker.current ? 'fresh' : ''}`}
                >
                  <span className={`method-pill method-${log.method.toLowerCase()}`}>
                    {log.method}
                  </span>
                  <span className="truncate">{log.path}</span>
                  <span>{log.matricula || '—'}</span>
                  <span className={`status-chip status-${log.status}`}>{log.status}</span>
                  <span>{formatTime(log.createdAt)}</span>
                </div>
              ))}
            </div>
          </section>
        </main>
      )}
    </div>
  )
}

type LoginPanelProps = {
  defaultHttpBase: string
  defaultWsPath: string
  onSubmit: (session: Session) => void
  loading: boolean
  error: string | null
  remembered: Session | null
}

function LoginPanel({
  defaultHttpBase,
  defaultWsPath,
  onSubmit,
  loading,
  error,
  remembered,
}: LoginPanelProps) {
  const [adminToken, setAdminToken] = useState(remembered?.adminToken || '')
  const [httpBase, setHttpBase] = useState(remembered?.httpBase || defaultHttpBase)
  const [wsPath, setWsPath] = useState(remembered?.wsPath || defaultWsPath)

  return (
    <div className="login">
      <div className="login-card">
        <h1>Painel admin</h1>
        <p className="muted">
          Insira o token de admin do backend em produção ({defaultHttpBase}) para destravar
          o monitoramento em tempo real via WebSocket (fallback para polling se necessário).
        </p>
        <form
          className="login-form"
          onSubmit={(e) => {
            e.preventDefault()
            onSubmit({ adminToken, httpBase, wsPath })
          }}
        >
          <label className="label" htmlFor="admin-token">
            Admin token
          </label>
          <input
            id="admin-token"
            type="password"
            placeholder="Cole o ADMIN_TOKEN configurado na API"
            value={adminToken}
            onChange={(e) => setAdminToken(e.target.value)}
            required
          />
          <label className="label" htmlFor="http-base">
            API base (HTTP)
          </label>
          <input
            id="http-base"
            value={httpBase}
            onChange={(e) => setHttpBase(e.target.value)}
            placeholder="https://leiame.app"
          />
          <label className="label" htmlFor="ws-path">
            Caminho WebSocket
          </label>
          <input
            id="ws-path"
            value={wsPath}
            onChange={(e) => setWsPath(e.target.value)}
            placeholder="/reports/usage/stream"
          />
          {error && <div className="error">{error}</div>}
          <button type="submit" className="primary" disabled={loading}>
            {loading ? 'Validando…' : 'Entrar'}
          </button>
        </form>
        <div className="muted small">
          O token vai para o header `Authorization` no /reports/usage e como query param no WS.
        </div>
      </div>
    </div>
  )
}

type StatCardProps = {
  title: string
  value: string | number
  hint?: string
}

function StatCard({ title, value, hint }: StatCardProps) {
  return (
    <div className="stat">
      <div className="stat-label">{title}</div>
      <div className="stat-value">{value}</div>
      {hint && <div className="muted small">{hint}</div>}
    </div>
  )
}

function normalizeLog(input: any): UsageLog | null {
  if (!input) return null
  const createdAt =
    typeof input.createdAt === 'string' ? input.createdAt : new Date().toISOString()
  return {
    id: input.id ?? `${input.matricula || 'anon'}-${createdAt}-${input.path}`,
    matricula: input.matricula ?? null,
    method: String(input.method || '').toUpperCase(),
    path: String(input.path || ''),
    status: Number(input.status) || 0,
    createdAt,
  }
}

async function fetchUsage(session: Session, matricula: string) {
  const base = normalizeBaseUrl(session.httpBase)
  const url = new URL('/reports/usage', base)
  if (matricula) url.searchParams.set('matricula', matricula)
  const res = await fetch(url.toString(), {
    headers: { Authorization: session.adminToken },
  })
  if (!res.ok) {
    throw new Error(`Falha ao ler /reports/usage (${res.status})`)
  }
  const json = await res.json()
  const normalized = Array.isArray(json) ? json.map(normalizeLog) : []
  return normalized.filter((x): x is UsageLog => Boolean(x))
}

async function validateAdmin(session: Session) {
  const test = await fetchUsage(session, '')
  if (!test) {
    throw new Error('Não foi possível validar o token de admin')
  }
}

export default App
