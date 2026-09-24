import axios, {
  type AxiosInstance,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
  type AxiosRequestConfig,
} from 'axios'
import { ElMessage } from 'element-plus'
import router from '@/router'
import { useUserStore } from '@/stores/user'
import type { ApiEnvelope, LoginResult } from '@/types/api'

// dev 阶段通过 Vite proxy 转发到 :3003，免 CORS
const baseURL = import.meta.env.VITE_API_BASE_URL || '/api'

const service: AxiosInstance = axios.create({
  baseURL,
  // 8s:admin 后端在本机通常 < 200ms,慢于 8s 多半是卡了。
  // 原 15s 让 admin 列表在网络抖动时卡死转圈几秒。
  timeout: 8000,
})

// ── GET in-flight 去重 + 短 TTL 缓存 ──
// 同一 method+url+params 的并发请求只发一次,结果在 30s 内复用。
// admin dashboard 5 个并行请求、列表页快速切换 tab 时避免重复打接口。
// opt-out: RequestOptions.noCache / noDedup
const inflight = new Map<string, Promise<unknown>>()
const cache = new Map<string, { value: unknown; expiresAt: number }>()
const DEFAULT_TTL_MS = 30_000

function cacheKey(method: string, url: string, params?: unknown) {
  return `${method}|${url}|${JSON.stringify(params ?? null)}`
}

function getCached<T>(key: string): T | undefined {
  const hit = cache.get(key)
  if (hit && hit.expiresAt > Date.now()) return hit.value as T
  if (hit) cache.delete(key)
  return undefined
}

// ─── Request 拦截器：注入 Bearer ────────────────────────────
service.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    const userStore = useUserStore()
    if (userStore.accessToken) {
      config.headers.Authorization = `Bearer ${userStore.accessToken}`
    }
    return config
  },
  (error) => Promise.reject(error),
)

// ─── Refresh-Token 单飞锁 ─────────────────────────────────
let refreshing: Promise<string | null> | null = null

/**
 * 拿到新的 accessToken。
 * 用 Promise 缓存避免并发请求触发多次 /auth/refresh。
 */
async function refreshAccessToken(): Promise<string | null> {
  if (refreshing) return refreshing

  const userStore = useUserStore()
  const refreshToken = userStore.refreshToken
  if (!refreshToken) return Promise.resolve(null)

  refreshing = (async () => {
    try {
      // 用裸 axios 避免触发本拦截器造成循环
      const { data } = await axios.post<ApiEnvelope<LoginResult>>(
        `${baseURL}/auth/refresh`,
        { refreshToken },
      )
      if (data?.code === 200 && data.data?.accessToken) {
        userStore.setTokens(data.data.accessToken, data.data.refreshToken || refreshToken)
        return data.data.accessToken
      }
      return null
    } catch {
      return null
    } finally {
      refreshing = null
    }
  })()

  return refreshing
}

// ─── Response 拦截器：解一层 envelope + 401 自动续期 ─────
service.interceptors.response.use(
  (response: AxiosResponse<ApiEnvelope<unknown>>) => {
    if (response.config.responseType === 'blob') return response

    const body = response.data
    if (body && body.code === 200) {
      return body.data as any
    }

    const message = body?.message || '请求失败'
    ElMessage.error(message)
    return Promise.reject(new Error(message))
  },
  async (error) => {
    const status = error.response?.status
    const original = error.config as InternalAxiosRequestConfig & { _retry?: boolean }
    const message = error.response?.data?.message || error.message || '网络错误'

    // 401 自动续期：refresh 接口本身也 401 时不再重试
    if (
      status === 401 &&
      original &&
      !original._retry &&
      !original.url?.includes('/auth/')
    ) {
      original._retry = true
      const newToken = await refreshAccessToken()
      if (newToken) {
        original.headers = original.headers || ({} as any)
        ;(original.headers as any).Authorization = `Bearer ${newToken}`
        return service.request(original)
      }
    }

    if (status === 401) {
      ElMessage.error('登录已过期，请重新登录')
      const userStore = useUserStore()
      userStore.clearAuth()
      const currentPath = router.currentRoute.value.fullPath
      router.push({ path: '/login', query: { redirect: currentPath } })
    } else if (status === 403) {
      ElMessage.error('无权限访问')
      router.push('/403')
    } else if (status && status >= 500) {
      ElMessage.error(`服务器错误 (${status})`)
    } else if (!original?._retry) {
      // 只在非 401 重试场景下提示，避免重复 toast
      ElMessage.error(message)
    }

    return Promise.reject(error)
  },
)

export interface RequestOptions {
  url: string
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  params?: Record<string, unknown>
  data?: unknown
  headers?: Record<string, string>
  responseType?: 'json' | 'blob'
  // 性能优化:跳过 GET 缓存 / 去重
  noCache?: boolean
  noDedup?: boolean
  // 缓存 TTL(毫秒),默认 30s。仅对 GET 生效。
  ttlMs?: number
  // 单次请求超时(毫秒)。不传 = 实例默认 8s。
  // 2026-09-24:剧集运维的补做/重合成是分钟级同步任务,需要 timeout: 0(不限时)。
  timeout?: number
}

/**
 * GET in-flight 去重 + 短 TTL 缓存:
 * - 并发的同请求共用同一 future(避免重复打接口)
 * - 命中 30s 内的缓存直接返回(切 tab 不重打)
 * - 写操作(opt-out by noCache/noDedup)永远直打
 */
export function request<T = unknown>(options: RequestOptions): Promise<T> {
  const method = options.method || 'GET'
  const key = cacheKey(method, options.url, options.params)
  const ttl = options.ttlMs ?? DEFAULT_TTL_MS

  if (method === 'GET' && !options.noCache) {
    const cached = getCached<T>(key)
    if (cached !== undefined) return Promise.resolve(cached)
  }
  if (method === 'GET' && !options.noDedup) {
    const pending = inflight.get(key) as Promise<T> | undefined
    if (pending) return pending
  }

  const p = service
    .request<unknown, T>({
      url: options.url,
      method,
      params: options.params,
      data: options.data,
      headers: options.headers,
      responseType: options.responseType,
      ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
    } as AxiosRequestConfig)
    .then((value) => {
      if (method !== 'GET') {
        // 写操作:失效同一 URL(去掉 query)及其各级父路径的 GET 缓存,
        // 确保下一读拿到新数据。只失效精确 URL 会漏掉兄弟列表缓存
        // (如 PATCH /admin/agents/123/billing 后列表 GET /admin/agents
        //  仍是旧数据 → 用户以为"保存失败,要点第二次"),逐级上溯到
        // 两段路径为止,把同一资源树下的读缓存全部刷新。
        const path = options.url.split('?')[0]
        invalidateCache(path)
        const segs = path.split('/').filter(Boolean)
        for (let i = segs.length - 1; i >= 2; i--) {
          invalidateCache('/' + segs.slice(0, i).join('/'))
        }
      }

      if (method === 'GET' && !options.noCache) {
        cache.set(key, { value, expiresAt: Date.now() + ttl })
      }
      return value
    })
    .finally(() => {
      inflight.delete(key)
    })

  if (method === 'GET' && !options.noDedup) {
    inflight.set(key, p)
  }
  return p
}

/** 主动失效缓存(写操作后调,确保下次读拿到新数据) */
export function invalidateCache(prefix?: string) {
  if (!prefix) {
    cache.clear()
    return
  }
  for (const k of cache.keys()) {
    if (k.includes(prefix)) cache.delete(k)
  }
}

// 周期清理过期缓存,避免 cache Map 在 admin 长会话中无限增长。
// (原版只在 getCached 时按访问删除;如果某个 URL 很长时间没被访问,
//  它的过期 entry 会一直留着。)
if (typeof window !== 'undefined') {
  setInterval(() => {
    const now = Date.now()
    for (const [k, v] of cache.entries()) {
      if (v.expiresAt <= now) cache.delete(k)
    }
  }, 60_000)
}

export default service
