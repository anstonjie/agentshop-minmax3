# skill 优势审查(短视频质量) — 2026-09-24

## 结论摘要

产品侧「短视频质量」能力在 **Nest drama/open-montage 管线**,不在 `backend/skill-repos/*` driver。
本轮已核对:两条路径**不共享** xfade/relay/identity/unanchored 实现。

| 能力 | drama/open-montage(成片主路径) | skill-repos driver(DAG/长驻路径) |
|---|---|---|
| xfade 转场 | ✅ 默认开 `DRAMA_COMPOSE_TRANSITIONS=1` | ❌ 无 |
| 尾帧接力 | ✅ 默认开 `DRAMA_SHOT_RELAY=1` | ❌ 无 |
| 身份/换脸门 | ✅ unanchored 双口径 + degraded 阻断 | ❌ 无 |
| 变体换装参考 | ✅ `pickUsableRef` variant 路径 | ❌ 无 |
| vehicle/wardrobe 全链 | ✅ outline→needs→kf→step4 | ❌ 无 |
| compose gate 时长门 | ✅ ≥40% 目标/≥30s + 存活镜≥60% | ❌ 无 |
| GitHub 通道收编 | ✅ `github-channel/` | driver 自带清单(刻意未动) |

**不要把 skill-repos 的 driver 当成成片质量的单一真相源** —— 它们服务 DAG skill 派发;
成片质量走 `open-montage.service` genStep3–7 + `drama-orchestrator` 门。

## 编码 skill 实际用到的

- `planning-and-task-breakdown`:e2e 脚本/修复任务拆分
- `test-driven-development`:`normalizeBatchPolicy` 先红后绿
- `debugging-and-error-recovery`:`Number(null)=0` 预算校验漏洞
- `observability-and-instrumentation`:step6 镜级耗时/失败日志
- `code-review-and-quality` / `performance-optimization`:flag 注释与默认开核对
- `agnes-video-flash` / `agnes-ai-generation`:实测参考(主路径仍走后端 `callVideoI2vWithKey`)
- `shipping-and-launch`:实测 PASS/FAIL 判据(时长≥90s、batch done)

## 遗留质量开关

| flag | 默认 | 实测建议 |
|---|---|---|
| `DRAMA_SHOT_RELAY` | 开 | 保持开 |
| `DRAMA_COMPOSE_TRANSITIONS` | 开 | 保持开 |
| `DRAMA_KEYFRAME_RETRY_DEGRADED` | **关**(烧图额度) | 质量验收可临时 `=1`;防换脸重生 |
| `DRAMA_EPISODE_BOUNDARY` | 关(顾问) | `repackLedgerEpisodes` 内部已硬编码 enabled |

## 实测入口

```powershell
powershell -ExecutionPolicy Bypass -File tasks\e2e-2min-video\run-e2e-2min.ps1
```

链路:建剧 → novel ingest epTargetSec=120 → 三门 → batch → ffprobe。
产物保留供人工验收(不自动删剧)。
