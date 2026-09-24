import { request } from './request'

// ─── 剧集运维(2026-09-24) ─────────────────────────────────────
// 调的是用户端同源的 /api/dramas 系列端点(uuid 直查,无归属校验),
// admin 凭自身 JWT 即可排障:看缺镜/失败原因、一键补做、续跑批次。
// 注意:step4/step5 generate 是分钟级同步任务,调用方必须传 timeout: 0。
// 响应信封兼容:data 包一层或裸对象,view 侧用 unwrapDramaRes 兜底。

export interface DramaEpisodeLike {
  epNo?: number
  status?: string
  durationSec?: number | string
  shotCount?: number
  finalUrl?: string | null
  error?: string | null
  stepData?: Record<string, any>
}

export interface DramaBatchLike {
  uuid?: string
  status?: string
  cursorEp?: number
  cursorStep?: number
  updatedAt?: string
  policy?: any
  error?: string | null
  log?: Array<{ msg?: string; step?: number; ok?: boolean }>
}

function unwrap<T>(r: any): T {
  return (r?.data ?? r) as T
}

export const dramaApi = {
  getDrama(uuid: string) {
    return request({ url: `/dramas/${uuid}`, noCache: true }).then(unwrap<any>)
  },
  getEpisodes(uuid: string) {
    return request({ url: `/dramas/${uuid}/episodes`, noCache: true }).then(unwrap<DramaEpisodeLike[]>)
  },
  getBatches(uuid: string) {
    return request({ url: `/dramas/${uuid}/batches`, noCache: true }).then(unwrap<DramaBatchLike[]>)
  },
  getBatch(batchUuid: string) {
    return request({ url: `/dramas/batches/${batchUuid}`, noCache: true }).then(unwrap<DramaBatchLike>)
  },
  /** 跑集内某步(4 分镜视频 / 5 重合成)。分钟级,timeout 由调用方定。 */
  generateStep(uuid: string, epNo: number, step: number, body: any = {}, timeout = 0) {
    return request({
      url: `/dramas/${uuid}/episodes/${epNo}/steps/${step}/generate`,
      method: 'POST',
      data: body,
      timeout,
      noCache: true,
    }).then(unwrap<any>)
  },
  resumeBatch(batchUuid: string, budgetCredits?: number) {
    return request({
      url: `/dramas/batches/${batchUuid}/resume`,
      method: 'POST',
      data: budgetCredits ? { budgetCredits } : {},
    }).then(unwrap<any>)
  },
}
