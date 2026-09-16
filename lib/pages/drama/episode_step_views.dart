// ============================================================================
// EpisodeStepBody —— 单集 6 步的正文渲染
// ----------------------------------------------------------------------------
// 与 episode_page.dart 拆开:页面负责会话与网络,这里只负责"把这一步的状态讲清楚"。
// 每个步骤都必须回答三件事:现在有什么、缺什么、失败了为什么。
//
// 预检裁决的 index 约定:后端 summarize 的顺序是 hits → variants → ambiguous → news,
// 前端必须用同一顺序的**下标偏移**还原 index。不要用 Map 的 indexOf ——
// Dart 的 Map 不按值相等,拿不到同一个对象会静默返回 -1,把裁决提交到错误的资产上。
// ============================================================================

import 'package:flutter/material.dart';

import '../../services/api_client.dart';
import '../../theme/app_colors.dart';
import '../../theme/app_text_styles.dart';
import '../../utils/web_download.dart';
import '../../widgets/optimized_network_image.dart';
import '../../theme/app_dimens.dart';

/// 传给各步骤视图的上下文(状态与回调由页面注入)
class EpisodeCtx {
  final Map<String, dynamic> episode;
  final Map<String, dynamic> continuity;
  final Map<String, dynamic> precheck;
  final int step;
  final bool hasOutput;
  final Map<String, dynamic> output;
  final String? error;
  final List<String> warnings;
  final List<dynamic> unresolvedAssets;
  final TextEditingController briefCtrl;
  final Future<void> Function(int step, {Map<String, dynamic>? body}) onGenerate;
  final Future<void> Function(int step) onDeleteOutput;
  final Future<void> Function(List<Map<String, dynamic>> decisions) onResolve;
  final void Function(String msg, {bool bad}) toast;
  final bool busy;
  // ── 2026-09-16(批3 透明工作台):可看可改可重做 ──
  /// 保存某步产出的行内编辑(PUT steps/:step/output)
  final Future<void> Function(int step, Map<String, dynamic> output) onPutOutput;
  /// 字幕编辑 → 重烧(复用 concat.mp4,不重烧视频配额)
  final Future<void> Function(List<Map<String, dynamic>> edits) onReburnSubtitles;
  /// 缺镜一键补做:重跑 step4(成功镜复用) + step5 重合成
  final Future<void> Function() onSupplementShots;
  /// 记一条字幕修改进待重烧清单(页面弹框收集)
  final void Function(Map<String, dynamic> cue) onEditCue;
  /// 已记下但还没重烧的字幕修改
  final List<Map<String, dynamic>> pendingSubEdits;

  const EpisodeCtx({
    required this.episode,
    required this.continuity,
    required this.precheck,
    required this.step,
    required this.hasOutput,
    required this.output,
    required this.error,
    required this.warnings,
    required this.unresolvedAssets,
    required this.briefCtrl,
    required this.onGenerate,
    required this.onDeleteOutput,
    required this.onResolve,
    required this.toast,
    required this.busy,
    required this.onPutOutput,
    required this.onReburnSubtitles,
    required this.onSupplementShots,
    required this.onEditCue,
    this.pendingSubEdits = const [],
  });

  int get epNo => (episode['epNo'] as num?)?.toInt() ?? 1;
}

class EpisodeStepBody extends StatelessWidget {
  final EpisodeCtx ctx;
  const EpisodeStepBody({super.key, required this.ctx});

  @override
  Widget build(BuildContext context) {
    final children = <Widget>[];
    switch (ctx.step) {
      case 0: children.addAll(_outline(ctx)); break;
      case 1: children.addAll(_precheckStep(ctx)); break;
      case 2: children.addAll(_storyboard(ctx, context)); break;
      case 3: children.addAll(_keyframes(ctx)); break;
      case 4: children.addAll(_videos(ctx)); break;
      default: children.addAll(_finalCut(ctx)); break;
    }
    if (ctx.error != null) {
      children.insert(
        0,
        _ErrorBox(message: ctx.error!, step: ctx.step, onRetry: () => ctx.onGenerate(ctx.step)),
      );
    }
    return ListView(padding: const EdgeInsets.fromLTRB(AppSpacing.lg, AppSpacing.lg, AppSpacing.lg, AppSpacing.xl), children: children);
  }
}

// ============================================================================
// 0 承接大纲
// ============================================================================
List<Widget> _outline(EpisodeCtx ctx) {
  final snap = (ctx.continuity['snapshot'] as Map?)?.cast<String, dynamic>() ?? const {};
  final facts = (snap['establishedFacts'] as List?) ?? const [];
  final openHooks = (snap['openHooks'] as List?) ?? const [];
  final hookIn = (ctx.episode['hookIn'] ?? ctx.continuity['hookIn'] ?? '').toString();
  final out = ctx.output;
  final scenes = (out['scenes'] as List?) ?? const [];
  final needs = (out['needs_assets'] as List?) ?? const [];

  return [
    _Card(
      title: '本集要接住',
      child: hookIn.isEmpty
          ? Text('第一集,无前置钩子。',
              style: AppTextStyles.bodySmall.copyWith(color: AppColors.textTertiary))
          : Text(hookIn, style: AppTextStyles.bodyMedium.copyWith(color: AppColors.primary)),
    ),
    if (facts.isNotEmpty || openHooks.isNotEmpty)
      _Card(
        title: '已确立事实(${facts.length}条)· 新集不得违反',
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            ...facts.map((f) => Padding(
                  padding: const EdgeInsets.only(bottom: AppSpacing.xs),
                  child: Text('· $f', style: AppTextStyles.bodySmall),
                )),
            if (openHooks.isNotEmpty) ...[
              const SizedBox(height: AppSpacing.sm),
              Text('未解悬念:${openHooks.join(' / ')}',
                  style: AppTextStyles.labelSmall.copyWith(color: AppColors.warning)),
            ],
          ],
        ),
      ),
    _Card(
      title: '本集补充要求(可选)',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          TextField(
            controller: ctx.briefCtrl,
            maxLines: 2,
            minLines: 1,
            style: AppTextStyles.bodySmall,
            decoration: InputDecoration(
              hintText: '例:本集把线索指向地下室,但不要让任何人死亡',
              hintStyle: AppTextStyles.labelSmall.copyWith(color: AppColors.textTertiary),
              isDense: true,
              contentPadding: const EdgeInsets.symmetric(horizontal: AppSpacing.md, vertical: AppSpacing.sm),
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(AppColors.buttonRadius),
                borderSide: BorderSide(color: AppColors.border),
              ),
            ),
          ),
          const SizedBox(height: AppSpacing.xs),
          Text('填了会在生成时一并喂给 LLM;不填就完全按全季故事线走。',
              style: AppTextStyles.labelSmall.copyWith(color: AppColors.textTertiary)),
        ],
      ),
    ),
    if (!ctx.hasOutput)
      const _Hint('生成时会自动带上世界观、既定事实、本集使命与资产索引,'
          '不需要你重复交代前情。')
    else ...[
      _Card(
        title: '本集剧本',
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('${out['title'] ?? ''}',
                style: AppTextStyles.bodyMedium.copyWith(
                    fontWeight: FontWeight.w700, fontSize: 15)),
            if ((out['logline'] ?? '').toString().isNotEmpty) ...[
              const SizedBox(height: AppSpacing.xs),
              Text('${out['logline']}', style: AppTextStyles.bodySmall),
            ],
            if ((out['synopsis'] ?? '').toString().isNotEmpty) ...[
              const SizedBox(height: AppSpacing.sm),
              Text('${out['synopsis']}',
                  style: AppTextStyles.bodySmall.copyWith(height: 1.6)),
            ],
          ],
        ),
      ),
      _Card(
        title: '分场(${scenes.length}场 · 约 ${out['total_estimated_sec'] ?? 0} 秒)',
        child: Column(
          children: scenes.map<Widget>((raw) {
            final m = (raw as Map).cast<String, dynamic>();
            final chars = (m['characters'] as List?)?.join('、') ?? '';
            final quotes = ((m['quotes'] as List?) ?? const [])
                .map((e) => e.toString()).where((e) => e.isNotEmpty).toList();
            final sub = [
              '${m['summary'] ?? ''}',
              if (chars.isNotEmpty) '引用:$chars',
              // 2026-09-16(批3):原文逐字锚点直接露出 —— 用户能核对"这场是不是照原著改的"
              if (quotes.isNotEmpty) '原文锚点:${quotes.join(' / ')}',
            ].join('\n');
            return ListTile(
              dense: true,
              contentPadding: const EdgeInsets.symmetric(horizontal: 0, vertical: AppSpacing.xxs),
              leading: CircleAvatar(
                radius: 12,
                backgroundColor: AppColors.primary.withValues(alpha: 0.14),
                child: Text('${m['idx'] ?? ''}',
                    style: AppTextStyles.labelSmall.copyWith(
                        color: AppColors.primary)),
              ),
              title: Text('${m['location'] ?? ''}',
                  maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: AppTextStyles.bodySmall.copyWith(fontWeight: FontWeight.w600)),
              subtitle: Text(sub,
                  style: AppTextStyles.labelSmall.copyWith(color: AppColors.textSecondary)),
              trailing: Text('${m['estimated_sec'] ?? 0}s',
                  style: AppTextStyles.labelSmall.copyWith(color: AppColors.textTertiary)),
            );
          }).toList(),
        ),
      ),
      if ((out['hook_out'] ?? '').toString().isNotEmpty)
        _Card(
          title: '本集留下的钩子(将成为下一集的开场)',
          child: Text('${out['hook_out']}',
              style: AppTextStyles.bodyMedium.copyWith(color: AppColors.warning)),
        ),
      // 2026-09-16(批3 透明工作台):"本集从哪来"全量可查 —— 原文锚点 + 完整提示词
      if (out['anchor'] is Map) ...[
        _Evidence('本集原文锚点 · beats 逐字',
            (((out['anchor'] as Map)['beatsAnchor'] ?? '').toString())),
        _Evidence('本集原文锚点 · 章节摘录',
            (((out['anchor'] as Map)['chapterExcerpt'] ?? '').toString())),
      ],
      if (out['prompt_used'] is Map) ...[
        _Evidence('大纲提示词 · system',
            (((out['prompt_used'] as Map)['system'] ?? '').toString())),
        _Evidence('大纲提示词 · user(本集任务/锚点/资产索引全文)',
            (((out['prompt_used'] as Map)['user'] ?? '').toString())),
      ],
      _Card(
        title: '本集声明的新资产需求(${needs.length}项)',
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (needs.isEmpty)
              Text('LLM 认为本集全部复用现有资产 —— 这是正常情况,'
                  '下一步仍会把场景引用的资产送进预检,确认复用真的成立。',
                  style: AppTextStyles.labelSmall.copyWith(color: AppColors.textTertiary))
            else
              Wrap(
                spacing: 5, runSpacing: 5,
                children: needs.map((raw) {
                  final m = (raw as Map).cast<String, dynamic>();
                  return _Tag('${m['kind'] ?? ''} · ${m['name'] ?? ''}', AppColors.accent);
                }).toList(),
              ),
            const SizedBox(height: AppSpacing.sm),
            Text('新确立事实 ${(out['established_facts_new'] as List?)?.length ?? 0} 条 · '
                '角色状态 ${(out['character_states'] as Map?)?.length ?? 0} 项',
                style: AppTextStyles.labelSmall.copyWith(color: AppColors.textSecondary)),
          ],
        ),
      ),
      ..._warnings(ctx),
    ],
  ];
}

// ============================================================================
// 1 资产预检
// ============================================================================
/// 把"无需用户拍板"的部分一次性提交:命中直接绑定、换造型挂变体、新增按 slug 建资产。
/// index 必须按后端 summarize 的顺序偏移(hits → variants → ambiguous → news)。
List<Map<String, dynamic>> _autoDecisions(
  List<dynamic> hits, List<dynamic> variants, List<dynamic> news, int newsBase,
) {
  final out = <Map<String, dynamic>>[];
  for (var i = 0; i < hits.length; i++) {
    final m = (hits[i] as Map).cast<String, dynamic>();
    out.add({'index': i, 'assetId': m['assetId']});
  }
  for (var i = 0; i < variants.length; i++) {
    final m = (variants[i] as Map).cast<String, dynamic>();
    final need = (m['need'] as Map?)?.cast<String, dynamic>() ?? const {};
    out.add({
      'index': hits.length + i,
      'assetId': m['assetId'],
      'asVariantLabel':
          (m['variantLabel'] ?? need['variantHint'] ?? '新造型').toString(),
    });
  }
  for (var i = 0; i < news.length; i++) {
    final m = (news[i] as Map).cast<String, dynamic>();
    final need = (m['need'] as Map?)?.cast<String, dynamic>() ?? const {};
    final slug = (need['slug'] ?? need['slugHint'] ?? '').toString();
    out.add({
      'index': newsBase + i,
      if (slug.isNotEmpty) 'slug': slug,
    });
  }
  return out;
}


List<Widget> _precheckStep(EpisodeCtx ctx) {
  final pc = ctx.precheck;
  if (pc.isEmpty) {
    return const [_Hint('预检会把本集需要的资产与剧级资产库做匹配:精确命中直接复用,'
        '换装走变体,相似但不确定的让你拍板,全新的才生成并回流。')];
  }
  final hits = (pc['hits'] as List?) ?? const [];
  final variants = (pc['variants'] as List?) ?? const [];
  final ambiguous = (pc['ambiguous'] as List?) ?? const [];
  final news = (pc['news'] as List?) ?? const [];
  // 2026-09-14(drama-skills 方法论):复用侧缺定妆图清单 —— 后端 matchAssets
  // 给每个 hit/variant 标了 REF/IMG/PLAN 三态,refGaps = 非 REF 的复用项。
  // 旧报告(无 refGaps 字段)兜底:从 hits/variants 里按 refState 现筛。
  final refGaps = (pc['refGaps'] as List?) ??
      [...hits, ...variants]
          .map((e) => (e as Map).cast<String, dynamic>())
          .where((m) =>
              m['refState'] != null &&
              m['refState'] != 'REF')
          .toList();
  final summary = (pc['summary'] as Map?)?.cast<String, dynamic>() ?? const {};
  // 与后端 summarize 完全一致的偏移,别用 indexOf
  final ambBase = hits.length + variants.length;
  final newsBase = ambBase + ambiguous.length;

  final used = (ctx.episode['usedAssets'] as List?) ?? const [];
  final created = (ctx.episode['newAssets'] as List?) ?? const [];

  return [
    _Card(
      title: '预检结果',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Wrap(
            spacing: 6, runSpacing: 6,
            children: [
              _Tag('共 ${summary['total'] ?? 0} 项', AppColors.textSecondary),
              _Tag('复用 ${hits.length}', AppColors.success),
              if (variants.isNotEmpty) _Tag('换造型 ${variants.length}', AppColors.primary),
              if (ambiguous.isNotEmpty) _Tag('待你拍板 ${ambiguous.length}', AppColors.warning),
              _Tag('新增 ${news.length}', AppColors.accent),
              if (refGaps.isNotEmpty) _Tag('待补定妆图 ${refGaps.length}', AppColors.warning),
            ],
          ),
          const SizedBox(height: AppSpacing.md),
          // 后端只绑定出现在 decisions 里的资产:命中项若只展示不提交,
          // usedAssets 会一直是空、useCount 不涨,"复用"就没有真正生效。
          ElevatedButton.icon(
            onPressed: (ctx.busy || (hits.isEmpty && variants.isEmpty && news.isEmpty))
                ? null
                : () => ctx.onResolve(_autoDecisions(hits, variants, news, newsBase)),
            icon: const Icon(Icons.done_all, size: 17),
            label: Text(used.isEmpty ? '确认本集资产清单(命中即绑定)' : '重新提交本集资产清单'),
            style: ElevatedButton.styleFrom(
              backgroundColor: AppColors.primary,
              foregroundColor: AppColors.surface,
              padding: const EdgeInsets.symmetric(vertical: AppSpacing.md),
            ),
          ),
          if (ambiguous.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: AppSpacing.sm),
              child: Text('还有 ${ambiguous.length} 项要你逐条拍板,不会被这个按钮自动处理。',
                  style: AppTextStyles.labelSmall.copyWith(color: AppColors.warning)),
            ),
        ],
      ),
    ),
    if (hits.isNotEmpty || variants.isNotEmpty)
      _Card(
        title: '库内命中 · 直接复用(${hits.length + variants.length})',
        child: Column(
          children: [...hits, ...variants].map((raw) {
            final m = (raw as Map).cast<String, dynamic>();
            final need = (m['need'] as Map?)?.cast<String, dynamic>() ?? const {};
            final isVariant = m['verdict'] == 'variant';
            return Padding(
              padding: const EdgeInsets.only(bottom: AppSpacing.sm),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(isVariant ? Icons.style_outlined : Icons.check_circle_outline,
                      size: 15, color: isVariant ? AppColors.primary : AppColors.success),
                  const SizedBox(width: AppSpacing.sm),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('${need['name'] ?? m['name'] ?? ''}',
                            style: AppTextStyles.bodySmall.copyWith(fontWeight: FontWeight.w600)),
                        Text('${m['reason'] ?? ''}',
                            style: AppTextStyles.labelSmall.copyWith(
                                 color: AppColors.textTertiary)),
                      ],
                    ),
                  ),
                ],
              ),
            );
          }).toList(),
        ),
      ),
    // 2026-09-14(drama-skills 方法论,「提示词条目不是已有图片的证明」):
    // 复用判定通过 ≠ 垫图可用。缺定妆图的资产显式列出来,让用户在预检阶段
    // 就决定补图或接受文生图降级 —— 对齐管线「任何降级必须显式告诉用户」纪律,
    // 不等成片换脸了才发现。文案(refGap)由后端说人话,前端只负责呈现。
    if (refGaps.isNotEmpty)
      _Card(
        title: '待补定妆图 · 复用但图未就绪(${refGaps.length})',
        child: Column(
          children: refGaps.map((raw) {
            final m = (raw as Map).cast<String, dynamic>();
            final need = (m['need'] as Map?)?.cast<String, dynamic>() ?? const {};
            final state = (m['refState'] ?? '').toString();
            final label = (m['variantLabel'] ?? '').toString();
            final name = '${need['name'] ?? m['name'] ?? ''}${label.isNotEmpty ? ' · $label' : ''}';
            return Padding(
              padding: const EdgeInsets.only(bottom: AppSpacing.sm),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(
                    state == 'PLAN'
                        ? Icons.report_gmailerrorred_outlined
                        : Icons.image_not_supported_outlined,
                    size: 15,
                    color: AppColors.warning,
                  ),
                  const SizedBox(width: AppSpacing.sm),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(name,
                            style: AppTextStyles.bodySmall
                                .copyWith(fontWeight: FontWeight.w600)),
                        Text(
                          (m['refGap'] ??
                                  (state == 'PLAN' ? '没有参考图也没有视觉描述,投产前需要补齐素材' : '定妆图还没生成,关键帧将退化为文生图'))
                              .toString(),
                          style: AppTextStyles.labelSmall
                              .copyWith(color: AppColors.warning),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            );
          }).toList(),
        ),
      ),
    if (ambiguous.isNotEmpty) ...[
      _Card(
        title: '需要你拍板(${ambiguous.length})',
        child: Column(
          children: ambiguous.asMap().entries.map((entry) {
            final m = (entry.value as Map).cast<String, dynamic>();
            final need = (m['need'] as Map?)?.cast<String, dynamic>() ?? const {};
            final cands = ((m['candidates'] as List?) ?? const [])
                .map((e) => Map<String, dynamic>.from(e as Map))
                .toList();
            final myIndex = ambBase + entry.key;
            return Padding(
              padding: const EdgeInsets.only(bottom: AppSpacing.md),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('${need['name'] ?? ''}',
                      style: AppTextStyles.bodySmall.copyWith(fontWeight: FontWeight.w700)),
                  Text('${m['reason'] ?? ''}',
                      style: AppTextStyles.labelSmall.copyWith(color: AppColors.warning)),
                  const SizedBox(height: AppSpacing.xs),
                  Wrap(
                    spacing: 6, runSpacing: 6,
                    children: [
                      for (final c in cands.take(3))
                        ActionChip(
                          avatar: const Icon(Icons.link, size: 13),
                          label: Text('是「${c['name']}」', style: const TextStyle(fontSize: 11)),
                          backgroundColor: AppColors.surface,
                          onPressed: ctx.busy
                              ? null
                              : () => ctx.onResolve([{'index': myIndex, 'assetId': c['assetId']}]),
                        ),
                      for (final c in cands.take(2))
                        ActionChip(
                          avatar: const Icon(Icons.style_outlined, size: 13),
                          label: Text('「${c['name']}」的新造型',
                              style: const TextStyle(fontSize: 11)),
                          backgroundColor: AppColors.surface,
                          onPressed: ctx.busy
                              ? null
                              : () => ctx.onResolve([{
                                    'index': myIndex,
                                    'assetId': c['assetId'],
                                    'asVariantLabel': (need['variantHint'] ?? need['name'] ?? '新造型')
                                        .toString(),
                                  }]),
                        ),
                      ActionChip(
                        avatar: const Icon(Icons.add_circle_outline, size: 13),
                        label: const Text('不是,是新资产', style: TextStyle(fontSize: 11)),
                        backgroundColor: AppColors.surface,
                        onPressed: ctx.busy
                            ? null
                            : () {
                                final slug = (need['slug'] ?? need['slugHint'] ?? '').toString();
                                ctx.onResolve([{
                                  'index': myIndex,
                                  if (slug.isNotEmpty) 'slug': slug,
                                }]);
                              },
                      ),
                    ],
                  ),
                ],
              ),
            );
          }).toList(),
        ),
      ),
      const _Hint('确认"是同一个角色"会把本集写法记进别名表,下次同样写法直接精确命中 —— 同一个问题只问一次。'),
    ],
    if (news.isNotEmpty)
      _Card(
        title: '本集新增(${news.length})',
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            ...news.asMap().entries.map((entry) {
              final m = (entry.value as Map).cast<String, dynamic>();
              final need = (m['need'] as Map?)?.cast<String, dynamic>() ?? const {};
              return Padding(
                padding: const EdgeInsets.only(bottom: AppSpacing.sm),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Icon(Icons.add_circle_outline, size: 15, color: AppColors.accent),
                    const SizedBox(width: AppSpacing.sm),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('${need['name'] ?? ''} · ${need['kind'] ?? ''} · '
                              '${need['slug'] ?? need['slugHint'] ?? ''}',
                              style: AppTextStyles.bodySmall.copyWith(fontWeight: FontWeight.w600)),
                          Text('${need['descVisual'] ?? ''}',
                              maxLines: 2, overflow: TextOverflow.ellipsis,
                              style: AppTextStyles.labelSmall.copyWith(
                                   color: AppColors.textTertiary)),
                        ],
                      ),
                    ),
                  ],
                ),
              );
            }),
            const SizedBox(height: AppSpacing.sm),
            Text('用上方「确认本集资产清单」一并入库;之后到资产库点「生成定妆图」才会真正出参考图。',
                style: AppTextStyles.labelSmall.copyWith(color: AppColors.textTertiary)),
          ],
        ),
      ),
    if (used.isNotEmpty)
      _Card(
        title: '本集已绑定资产(${used.length})',
        child: Wrap(
          spacing: 5, runSpacing: 5,
          children: used.map((raw) {
            final m = (raw as Map).cast<String, dynamic>();
            final v = (m['variant'] ?? '').toString();
            final shots = (m['shotIdxs'] as List?)?.length ?? 0;
            return _Tag('${m['name'] ?? m['slug'] ?? ''}'
                '${v.isEmpty ? '' : '·$v'}${shots > 0 ? ' ×$shots镜' : ''}', AppColors.success);
          }).toList(),
        ),
      ),
    if (created.isNotEmpty)
      Padding(
        padding: const EdgeInsets.only(top: AppSpacing.sm),
        child: Text('本集已回流 ${created.length} 项新资产进剧级库',
            style: AppTextStyles.labelSmall.copyWith(color: AppColors.accent)),
      ),
  ];
}

// ============================================================================
// 2 分镜脚本
// ============================================================================
List<Widget> _storyboard(EpisodeCtx ctx, BuildContext context) {
  if (!ctx.hasOutput) {
    return const [_Hint('分镜只引用资产库里的 slug,不会自己发明人物长相 —— '
        '长相由定妆参考图决定,文字再写一遍会和参考图打架导致换脸。')];
  }
  final shots = (ctx.output['shots'] as List?) ?? const [];
  // 2026-09-16(批3):本集各场 quotes(原文逐字锚点),按 scene_idx 挂到镜头上
  final scenes0 = ((ctx.episode['stepData'] as Map?)?['0']?['output']?['scenes'] as List?)
      ?? const [];
  List<String> quotesOfScene(dynamic sceneIdx) {
    for (final s in scenes0) {
      final m = (s as Map);
      if (m['idx'] == sceneIdx) {
        return ((m['quotes'] as List?) ?? const [])
            .map((e) => e.toString()).where((e) => e.isNotEmpty).toList();
      }
    }
    return const [];
  }

  return [
    if (ctx.output['hookShotMissing'] == true)
      _Card(
        title: '集尾钩子镜缺失',
        child: Text(
          '${(ctx.output['endHook'] is Map ? (ctx.output['endHook'] as Map)['reason'] : '') ?? ''}'
          ' —— 末镜没留悬念,下一集开场会接不上。可重跑本步(会自动带钩子重生成一次),'
          '或在展开末镜后手工改节奏/台词。',
          style: AppTextStyles.labelSmall.copyWith(color: AppColors.warning)),
      ),
    _Card(
      title: '分镜(${shots.length}镜)',
      child: Column(
        children: shots.map((raw) {
          final m = (raw as Map).cast<String, dynamic>();
          final chars = (m['characters'] as List?) ?? const [];
          final props = (m['props'] as List?) ?? const [];
          final loc = (m['location_id'] ?? '').toString();
          final quotes = quotesOfScene(m['scene_idx']);
          return Theme(
            data: ThemeData(dividerColor: Colors.transparent),
            child: ExpansionTile(
              tilePadding: EdgeInsets.zero,
              childrenPadding: const EdgeInsets.only(bottom: AppSpacing.sm),
              title: Row(
                children: [
                  Text('#${m['idx'] ?? ''}',
                      style: AppTextStyles.labelSmall.copyWith(
                          color: AppColors.primary, fontWeight: FontWeight.w700)),
                  const SizedBox(width: AppSpacing.sm),
                  Expanded(
                    child: Text('${m['description'] ?? ''}',
                        maxLines: 1, overflow: TextOverflow.ellipsis,
                        style: AppTextStyles.bodySmall),
                  ),
                  Text('${m['shot_type'] ?? ''} ${m['duration_sec'] ?? ''}s',
                      style: AppTextStyles.labelSmall.copyWith(
                          fontSize: 10, color: AppColors.textTertiary)),
                ],
              ),
              children: [
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: AppSpacing.xs),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('${m['description'] ?? ''}',
                          style: AppTextStyles.bodySmall.copyWith(height: 1.6)),
                      if ((m['dialogue'] ?? '').toString().isNotEmpty) ...[
                        const SizedBox(height: AppSpacing.sm),
                        Text('台词/旁白:${m['dialogue']}',
                            style: AppTextStyles.labelSmall.copyWith(color: AppColors.textSecondary)),
                      ],
                      const SizedBox(height: AppSpacing.sm),
                      Wrap(
                        spacing: 5, runSpacing: 5,
                        children: [
                          if (loc.isNotEmpty) _Tag('场景 $loc', AppColors.success),
                          ...chars.map((c) => _Tag('角色 $c', AppColors.primary)),
                          ...props.map((p) => _Tag('道具 $p', AppColors.accent)),
                          _Tag('运镜 ${m['camera_motion'] ?? '静止'}', AppColors.textTertiary),
                          // 节奏角色:集尾钩子门的判据,露出来用户才看得懂"为什么拦"
                          _Tag('节奏 ${m['rhythm'] ?? '未标'}', AppColors.textTertiary),
                        ],
                      ),
                      if (quotes.isNotEmpty) ...[
                        const SizedBox(height: AppSpacing.sm),
                        Text('本场原文锚点:${quotes.join(' / ')}',
                            style: AppTextStyles.labelSmall.copyWith(
                                fontSize: 10, color: AppColors.success)),
                      ],
                      const SizedBox(height: AppSpacing.xs),
                      Align(
                        alignment: Alignment.centerLeft,
                        child: TextButton.icon(
                          onPressed: ctx.busy ? null : () async {
                            final res = await showDialog<Map<String, String>>(
                              context: context,
                              builder: (_) => _ShotEditDialog(
                                initialDesc: '${m['description'] ?? ''}',
                                initialDialogue: '${m['dialogue'] ?? ''}',
                              ),
                            );
                            if (res == null) return;
                            final next = ((ctx.output['shots'] as List?) ?? const [])
                                .map((e) => Map<String, dynamic>.from(e as Map))
                                .toList();
                            for (final s in next) {
                              if (s['idx'] == m['idx']) {
                                s['description'] = res['description'];
                                s['dialogue'] = res['dialogue'];
                              }
                            }
                            await ctx.onPutOutput(2, {...ctx.output, 'shots': next});
                            ctx.toast('分镜已保存;改画面/配音需重跑第 3/4 步,改成片字幕到第 6 步重烧');
                          },
                          icon: const Icon(Icons.edit_outlined, size: 14),
                          label: const Text('改这一镜', style: TextStyle(fontSize: 11)),
                          style: TextButton.styleFrom(
                              padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm),
                              minimumSize: const Size(0, 26)),
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          );
        }).toList(),
      ),
    ),
    if (ctx.output['prompt_used'] is Map) ...[
      _Evidence('分镜提示词 · system(导演要求/节奏角色/钩子门)',
          (((ctx.output['prompt_used'] as Map)['system'] ?? '').toString())),
      _Evidence('分镜提示词 · user(大纲/资产索引全文)',
          (((ctx.output['prompt_used'] as Map)['user'] ?? '').toString())),
    ],
    if (ctx.unresolvedAssets.isNotEmpty)
      _Card(
        title: '有 ${ctx.unresolvedAssets.length} 个标识不在资产库',
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(ctx.unresolvedAssets.join('、'),
                style: AppTextStyles.bodySmall.copyWith(color: AppColors.warning)),
            const SizedBox(height: AppSpacing.xs),
            Text('这些镜头拿不到参考图,会退化成纯文字生成(脸不稳)。'
                '建议回第 1 步处理预检,或在资产库手工补建该资产后重跑分镜。',
                style: AppTextStyles.labelSmall.copyWith(color: AppColors.textTertiary)),
          ],
        ),
      ),
  ];
}

// ============================================================================
// 3 关键帧(参考图驱动)
// ============================================================================
List<Widget> _keyframes(EpisodeCtx ctx) {
  final shots = _shotsOf(ctx);
  if (shots.isEmpty) return const [_Hint('请先完成第 2 步分镜。')];

  final kfs = ((ctx.output['keyframes'] as List?) ?? const [])
      .map((e) => Map<String, dynamic>.from(e as Map))
      .toList();
  Map<String, dynamic>? kfOf(int idx) {
    for (final k in kfs) {
      if ((k['shot_idx'] as num?)?.toInt() == idx) return k;
    }
    return null;
  }

  final done = kfs.where((k) => (k['url'] ?? '').toString().isNotEmpty).length;
  final missing = (ctx.output['missing_refs'] as List?) ?? const [];

  return [
    _Card(
      title: '关键帧 $done/${shots.length} 镜',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(AppColors.thumbRadius),
            child: LinearProgressIndicator(
              value: shots.isEmpty ? 0 : done / shots.length,
              minHeight: 5, backgroundColor: AppColors.border,
              valueColor: AlwaysStoppedAnimation<Color>(AppColors.primary),
            ),
          ),
          const SizedBox(height: AppSpacing.sm),
          Text('带参考图 ${ctx.output['ref_backed'] ?? 0} 镜 · '
              '无参考退化 ${ctx.output['degraded_count'] ?? 0} 镜',
              style: AppTextStyles.labelSmall.copyWith(color: AppColors.textSecondary)),
          if (missing.isNotEmpty)
            Text('缺参考图:${missing.join('、')} —— 请到资产库为它们「生成定妆图」后重跑该镜',
                style: AppTextStyles.labelSmall.copyWith(color: AppColors.warning)),
          const SizedBox(height: AppSpacing.sm),
          OutlinedButton.icon(
            onPressed: ctx.busy ? null : () => ctx.onGenerate(3),
            icon: const Icon(Icons.playlist_play, size: 16),
            label: Text(done == 0 ? '生成全部 ${shots.length} 镜' : '补齐未完成镜头'),
            style: OutlinedButton.styleFrom(
                foregroundColor: AppColors.primary,
                padding: const EdgeInsets.symmetric(vertical: AppSpacing.md)),
          ),
        ],
      ),
    ),
    ...shots.map((raw) {
      final sh = (raw as Map).cast<String, dynamic>();
      final idx = (sh['idx'] as num?)?.toInt() ?? 0;
      final k = kfOf(idx);
      final url = (k?['url'] ?? '').toString();
      final err = (k?['error'] ?? '').toString();
      final refs = ((k?['ref_sources'] as List?) ?? const [])
          .map((e) => Map<String, dynamic>.from(e as Map))
          .toList();
      final isDegraded = k?['degraded'] == true;

      return Container(
        margin: const EdgeInsets.only(bottom: AppSpacing.sm),
        padding: const EdgeInsets.all(AppSpacing.md),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(AppColors.cardRadius),
          border: Border.all(color: AppColors.border.withValues(alpha: 0.6)),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            ClipRRect(
              borderRadius: BorderRadius.circular(AppColors.thumbRadius),
              child: SizedBox(
                width: 74, height: 96,
                child: url.isNotEmpty
                    ? OptimizedNetworkImage(
                        url: ApiClient.resolveUrl(url), fit: BoxFit.cover, cacheWidth: 220)
                    : Container(
                        color: AppColors.background,
                        child: Center(
                          child: Icon(
                              err.isEmpty ? Icons.image_outlined : Icons.error_outline,
                              size: 20,
                              color: err.isEmpty ? AppColors.textTertiary : AppColors.danger),
                        ),
                      ),
              ),
            ),
            const SizedBox(width: AppSpacing.md),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Text('#$idx', style: AppTextStyles.labelSmall.copyWith(
                          color: AppColors.primary, fontWeight: FontWeight.w700)),
                      const SizedBox(width: AppSpacing.sm),
                      Expanded(
                        child: Text('${sh['description'] ?? ''}',
                            maxLines: 2, overflow: TextOverflow.ellipsis,
                            style: AppTextStyles.labelSmall),
                      ),
                    ],
                  ),
                  const SizedBox(height: AppSpacing.xs),
                  if (isDegraded)
                    Text('无参考图 · 本镜靠文字描述,脸可能不稳',
                        style: AppTextStyles.labelSmall.copyWith(
                            fontSize: 10, color: AppColors.warning))
                  else if (refs.isNotEmpty)
                    Text('参考:${refs.map((r) => '${r['name']}/${r['angle']}').join(' ')}',
                        maxLines: 2, overflow: TextOverflow.ellipsis,
                        style: AppTextStyles.labelSmall.copyWith(
                            fontSize: 10, color: AppColors.success)),
                  if (err.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: AppSpacing.xs),
                      child: Text(err,
                          maxLines: 3, overflow: TextOverflow.ellipsis,
                          style: AppTextStyles.labelSmall.copyWith(
                              fontSize: 10, color: AppColors.danger)),
                    ),
                  // 2026-09-16(批3):关键帧 prompt + 参考图 URL 露出,换脸/坏图可溯源
                  if ((k?['prompt'] ?? '').toString().isNotEmpty)
                    _Evidence('关键帧 prompt #$idx',
                        '${k?['prompt']}\n参考图:${_joinRefs(k)}'),
                ],
              ),
            ),
            const SizedBox(width: AppSpacing.xs),
            url.isNotEmpty
                ? IconButton(
                    icon: const Icon(Icons.refresh, size: 18),
                    tooltip: '重出这一镜',
                    onPressed: ctx.busy ? null : () => ctx.onGenerate(3, body: {'shotIdx': idx}),
                  )
                : TextButton(
                    onPressed: ctx.busy ? null : () => ctx.onGenerate(3, body: {'shotIdx': idx}),
                    child: const Text('出这镜', style: TextStyle(fontSize: 12)),
                  ),
          ],
        ),
      );
    }),
  ];
}

// ============================================================================
// 4 分镜视频
// ============================================================================
List<Widget> _videos(EpisodeCtx ctx) {
  final shots = _shotsOf(ctx);
  final kfs = ((ctx.episode['stepData'] as Map?)?['3']?['output']?['keyframes'] as List?)
      ?? const [];
  if (kfs.isEmpty) return const [_Hint('请先完成第 3 步关键帧。')];

  final list = ((ctx.output['shots'] as List?) ?? const [])
      .map((e) => Map<String, dynamic>.from(e as Map))
      .toList();
  Map<String, dynamic>? vOf(int idx) {
    for (final v in list) {
      if ((v['shot_idx'] as num?)?.toInt() == idx) return v;
    }
    return null;
  }

  bool hasKeyframe(int idx) => kfs.any((k) =>
      (k as Map)['shot_idx'] == idx && (k['url'] ?? '').toString().isNotEmpty);

  final doneCount = list.where((v) => v['status'] == 'completed').length;

  return [
    _Card(
      title: '分镜视频 $doneCount/$shots.length',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('上游限制每个密钥每分钟只能创建 1 次视频任务,整集跑完通常 5~25 分钟。'
              '已完成的镜头不会被重烧。',
              style: AppTextStyles.labelSmall.copyWith(color: AppColors.textTertiary)),
          const SizedBox(height: AppSpacing.sm),
          OutlinedButton.icon(
            onPressed: ctx.busy ? null : () => ctx.onGenerate(4),
            icon: const Icon(Icons.movie_creation_outlined, size: 16),
            label: Text(doneCount == 0 ? '开始生成全部' : '补齐未完成镜头'),
            style: OutlinedButton.styleFrom(
                foregroundColor: AppColors.primary,
                padding: const EdgeInsets.symmetric(vertical: AppSpacing.md)),
          ),
        ],
      ),
    ),
    ...shots.map((raw) {
      final sh = (raw as Map).cast<String, dynamic>();
      final idx = (sh['idx'] as num?)?.toInt() ?? 0;
      final v = vOf(idx);
      final status = (v?['status'] ?? '').toString();
      final url = (v?['video_url'] ?? '').toString();
      final ready = hasKeyframe(idx);

      Color color;
      String label;
      if (url.isNotEmpty) { color = AppColors.success; label = '已完成'; }
      else if (status == 'failed') { color = AppColors.danger; label = '失败'; }
      else if (!ready) { color = AppColors.textTertiary; label = '缺关键帧'; }
      else { color = AppColors.textTertiary; label = '待生成'; }

      return Container(
        margin: const EdgeInsets.only(bottom: AppSpacing.sm),
        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md, vertical: AppSpacing.sm),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(AppColors.slotRadius),
          border: Border.all(color: AppColors.border.withValues(alpha: 0.6)),
        ),
        child: Row(
          children: [
            Text('#$idx', style: AppTextStyles.labelSmall.copyWith(
                color: AppColors.primary, fontWeight: FontWeight.w700)),
            const SizedBox(width: AppSpacing.sm),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('${sh['description'] ?? ''}',
                      maxLines: 1, overflow: TextOverflow.ellipsis,
                      style: AppTextStyles.labelSmall),
                  Text('$label'
                      '${v?['duration_sec'] != null ? ' · ${v?['duration_sec']}s' : ''}'
                      '${v?['reused'] == true ? ' · 沿用上轮' : ''}',
                      style: AppTextStyles.labelSmall.copyWith(fontSize: 10, color: color)),
                  if ((v?['error'] ?? '').toString().isNotEmpty)
                    Text('${v?['error']}',
                        maxLines: 2, overflow: TextOverflow.ellipsis,
                        style: AppTextStyles.labelSmall.copyWith(
                            fontSize: 10, color: AppColors.danger)),
                  // 2026-09-16(批3):i2v prompt + seed 露出 —— 补做/复现靠 seed,
                  // "这一镜为什么是这个画面"靠 prompt
                  if ((v?['prompt'] ?? '').toString().isNotEmpty)
                    _Evidence('i2v prompt #$idx',
                        '${v?['prompt']}${v?['seed'] != null ? '\nseed: ${v?['seed']}' : ''}'),
                ],
              ),
            ),
            if (url.isNotEmpty)
              IconButton(
                icon: const Icon(Icons.play_circle_outline, size: 20),
                color: AppColors.success,
                onPressed: () => webOpenInNewTab(Uri.parse(ApiClient.resolveUrl(url))),
                tooltip: '播放这一镜',
              )
            else
              TextButton(
                onPressed: (!ready || ctx.busy)
                    ? null
                    : () => ctx.onGenerate(4, body: {'shotIdx': idx}),
                child: const Text('出这镜', style: TextStyle(fontSize: 12)),
              ),
          ],
        ),
      );
    }),
  ];
}

// ============================================================================
// 5 成片与状态回写
// ============================================================================
List<Widget> _finalCut(EpisodeCtx ctx) {
  final out = ctx.output;
  final videos = ((ctx.episode['stepData'] as Map?)?['4']?['output']?['shots'] as List?)
      ?? const [];
  final ready = videos.where((v) => (v as Map)['video_url'] != null).length;
  final updated = ctx.episode['snapshotUpdated'];
  final notice = (ctx.episode['snapshotNotice'] ?? '').toString();
  final finalUrl = (out['final_url'] ?? ctx.episode['finalUrl'] ?? '').toString();

  return [
    _Card(
      title: '合成成片',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('已就绪镜头 $ready/${videos.length}。合成会把它们按顺序拼接并生成字幕文件。',
              style: AppTextStyles.labelSmall.copyWith(color: AppColors.textSecondary)),
          if (ready == 0)
            Padding(
              padding: const EdgeInsets.only(top: AppSpacing.xs),
              child: Text('还没有任何镜头视频,先回第 4 步生成。',
                  style: AppTextStyles.labelSmall.copyWith(color: AppColors.warning)),
            ),
        ],
      ),
    ),
    if (finalUrl.isNotEmpty)
      _Card(
        title: '本集成片',
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('${out['duration_sec'] ?? ctx.episode['durationSec'] ?? 0} 秒'
                '${out['segment_count'] != null ? ' · ${out['segment_count']} 段' : ''}'
                '${out['size_bytes'] != null ? ' · ${(out['size_bytes'] as num).toInt() ~/ 1048576} MB' : ''}',
                style: AppTextStyles.bodyMedium.copyWith(fontWeight: FontWeight.w600)),
            const SizedBox(height: AppSpacing.sm),
            Row(
              children: [
                Expanded(
                  child: SelectableText(finalUrl,
                      style: AppTextStyles.labelSmall.copyWith(color: AppColors.primary)),
                ),
                IconButton(
                  icon: const Icon(Icons.play_circle_outline, size: 22),
                  color: AppColors.primary,
                  onPressed: () => webOpenInNewTab(Uri.parse(ApiClient.resolveUrl(finalUrl))),
                ),
              ],
            ),
            if ((out['subtitle_url'] ?? '').toString().isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: AppSpacing.xs),
                child: Text('字幕:${out['subtitle_url']}',
                    style: AppTextStyles.labelSmall.copyWith(color: AppColors.textTertiary)),
              ),
          ],
        ),
      ),
    // 2026-09-16(批3 透明工作台):缺镜/成片门/质检/回顾/字幕全文 —— 成片不再黑盒
    if (((out['missing_shots'] as num?) ?? 0) > 0)
      _Card(
        title: '缺 ${out['missing_shots']} 镜 · 成片 ${out['duration_sec'] ?? 0}s / 计划 ${out['planned_shots'] ?? 0} 镜',
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('失败或缺关键帧的镜头没进成片(上游 503 队列满是最常见原因)。'
                '补做会复用已成功镜头,只重跑失败镜,不重复烧配额。',
                style: AppTextStyles.labelSmall.copyWith(color: AppColors.textSecondary)),
            const SizedBox(height: AppSpacing.sm),
            OutlinedButton.icon(
              onPressed: ctx.busy ? null : ctx.onSupplementShots,
              icon: const Icon(Icons.healing, size: 16),
              label: const Text('一键补做失败镜并重合成'),
              style: OutlinedButton.styleFrom(
                  foregroundColor: AppColors.warning,
                  padding: const EdgeInsets.symmetric(vertical: AppSpacing.md)),
            ),
          ],
        ),
      ),
    if (out['compose_gate'] is Map)
      _Card(
        title: '成片门判定',
        child: (out['compose_gate'] as Map)['passed'] == true
            ? Text('达标:存活 ${((out['compose_gate'] as Map)['composed'] ?? 0)}/'
                '${((out['compose_gate'] as Map)['planned'] ?? 0)} 镜 · '
                '${((out['compose_gate'] as Map)['durationSec'] ?? 0).toString()}s ≥ '
                '${((out['compose_gate'] as Map)['minDurationSec'] ?? 0)}s 门',
                style: AppTextStyles.bodySmall.copyWith(color: AppColors.success))
            : Text(
                (((out['compose_gate'] as Map)['reasons'] as List?) ?? const [])
                    .join(';'),
                style: AppTextStyles.bodySmall.copyWith(color: AppColors.danger)),
      ),
    if (out['audit'] is Map && (out['audit'] as Map)['skipped'] != true)
      _Card(
        title: '拉片质检(客观指标)',
        child: Text(
          '${(out['audit'] as Map)['shotCount'] ?? 0} 镜 · 均镜长 '
          '${((out['audit'] as Map)['avgShotSec'] as num?)?.toStringAsFixed(1) ?? '?'}s · '
          '每分钟 ${(out['audit'] as Map)['cutsPerMin'] ?? 0} 切 · '
          '死镜 ${(((out['audit'] as Map)['staticShots'] as List?) ?? const []).length} · '
          '硬跳接缝 ${(((out['audit'] as Map)['seamOutliers'] as List?) ?? const []).length} → '
          '${(out['audit'] as Map)['verdict'] ?? ''}',
          style: AppTextStyles.labelSmall.copyWith(color: AppColors.textSecondary)),
      ),
    if (out['recap'] is Map)
      _Card(
        title: '集首视觉回顾',
        child: (out['recap'] as Map)['enabled'] == true
            ? Text('已接 3s 上集尾帧淡入 + 字卡:「${(out['recap'] as Map)['text'] ?? ''}」',
                style: AppTextStyles.labelSmall.copyWith(color: AppColors.success))
            : Text('本集未接回顾:${(out['recap'] as Map)['reason'] ?? '非第 2 集起/上集无成片'}',
                style: AppTextStyles.labelSmall.copyWith(color: AppColors.textTertiary)),
      ),
    if (((out['subtitle_cues'] as List?) ?? const []).isNotEmpty)
      _Card(
        title: '字幕全文(${((out['subtitle_cues'] as List?) ?? const []).length}条)· 可改可重烧',
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            ...((out['subtitle_cues'] as List?) ?? const []).map((raw) {
              final c = (raw as Map).cast<String, dynamic>();
              return Padding(
                padding: const EdgeInsets.only(bottom: AppSpacing.xs),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('${_mmss((c['startSec'] as num?) ?? 0)}',
                        style: AppTextStyles.labelSmall.copyWith(
                            fontSize: 10, color: AppColors.textTertiary)),
                    const SizedBox(width: AppSpacing.sm),
                    Expanded(
                      child: Text('${c['text'] ?? ''}',
                          style: AppTextStyles.labelSmall),
                    ),
                    IconButton(
                      visualDensity: VisualDensity.compact,
                      icon: const Icon(Icons.edit_outlined, size: 14),
                      tooltip: '改这条字幕',
                      onPressed: ctx.busy ? null : () => ctx.onEditCue(c),
                    ),
                  ],
                ),
              );
            }),
            if (ctx.pendingSubEdits.isNotEmpty) ...[
              const SizedBox(height: AppSpacing.sm),
              Text('已记下 ${ctx.pendingSubEdits.length} 处修改,待重烧',
                  style: AppTextStyles.labelSmall.copyWith(color: AppColors.warning)),
              const SizedBox(height: AppSpacing.sm),
              OutlinedButton.icon(
                onPressed: ctx.busy ? null : () => ctx.onReburnSubtitles(ctx.pendingSubEdits),
                icon: const Icon(Icons.subtitles_outlined, size: 16),
                label: Text('重烧字幕(${ctx.pendingSubEdits.length}处) · 复用已合成画面,不烧视频配额'),
                style: OutlinedButton.styleFrom(
                    foregroundColor: AppColors.primary,
                    padding: const EdgeInsets.symmetric(vertical: AppSpacing.md)),
              ),
            ],
            if (out['subtitle_needs_realign'] == true)
              Padding(
                padding: const EdgeInsets.only(top: AppSpacing.sm),
                child: Text('注意:有修改字数变化超阈值,字幕时间窗未重算 —— '
                    '精确对齐需重跑分镜视频后重新合成。',
                    style: AppTextStyles.labelSmall.copyWith(color: AppColors.warning)),
              ),
          ],
        ),
      ),
    if (out.isNotEmpty)
      _Card(
        title: '世界状态回写',
        child: updated == false
            ? Text(notice.isEmpty ? '快照未更新:本集序号早于快照来源集。' : notice,
                style: AppTextStyles.bodySmall.copyWith(color: AppColors.danger))
            : Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('快照已推进到 EP${ctx.epNo}',
                      style: AppTextStyles.bodySmall.copyWith(color: AppColors.success)),
                  const SizedBox(height: AppSpacing.xs),
                  Text('本集钩子已交给下一集:建集时会自动填进「要接住」栏。',
                      style: AppTextStyles.labelSmall.copyWith(color: AppColors.textTertiary)),
                ],
              ),
      ),
    if ((ctx.episode['hookOut'] ?? '').toString().isNotEmpty)
      _Card(
        title: '下一集将接住',
        child: Text('${ctx.episode['hookOut']}',
            style: AppTextStyles.bodyMedium.copyWith(color: AppColors.warning)),
      ),
    ..._warnings(ctx),
  ];
}

// ============================================================================
// 通用小块
// ============================================================================
List<dynamic> _shotsOf(EpisodeCtx ctx) =>
    ((ctx.episode['stepData'] as Map?)?['2']?['output']?['shots'] as List?) ?? const [];

List<Widget> _warnings(EpisodeCtx ctx) {
  if (ctx.warnings.isEmpty) return const [];
  return [
    _Card(
      title: '注意(${ctx.warnings.length})',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: ctx.warnings
            .map((w) => Padding(
                  padding: const EdgeInsets.only(bottom: AppSpacing.xs),
                  child: Text('· $w',
                      style: AppTextStyles.labelSmall.copyWith(color: AppColors.warning)),
                ))
            .toList(),
      ),
    ),
  ];
}

class _Card extends StatelessWidget {
  final String title;
  final Widget child;
  const _Card({required this.title, required this.child});

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: AppSpacing.md),
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(AppColors.cardRadius),
        border: Border.all(color: AppColors.border.withValues(alpha: 0.6)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(title, style: AppTextStyles.labelSmall.copyWith(
              color: AppColors.textSecondary, fontWeight: FontWeight.w700)),
          const SizedBox(height: AppSpacing.sm),
          child,
        ],
      ),
    );
  }
}

class _Tag extends StatelessWidget {
  final String text;
  final Color color;
  const _Tag(this.text, this.color);

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm, vertical: AppSpacing.xxs),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(AppColors.tagRadius),
      ),
      child: Text(text, style: AppTextStyles.labelSmall.copyWith(
           color: color, fontWeight: FontWeight.w600)),
    );
  }
}

class _Hint extends StatelessWidget {
  final String text;
  const _Hint(this.text);

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(AppSpacing.lg),
      decoration: BoxDecoration(
        color: AppColors.surface.withValues(alpha: 0.7),
        borderRadius: BorderRadius.circular(AppColors.cardRadius),
        border: Border.all(color: AppColors.border.withValues(alpha: 0.5)),
      ),
      child: Text(text, style: AppTextStyles.bodySmall.copyWith(
          color: AppColors.textSecondary, height: 1.7)),
    );
  }
}

class _ErrorBox extends StatelessWidget {
  final String message;
  final int step;
  final VoidCallback onRetry;
  const _ErrorBox({required this.message, required this.step, required this.onRetry});

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: AppSpacing.md),
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: AppColors.danger.withValues(alpha: 0.07),
        borderRadius: BorderRadius.circular(AppColors.cardRadius),
        border: Border.all(color: AppColors.danger.withValues(alpha: 0.35)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.error_outline, size: 16, color: AppColors.danger),
              const SizedBox(width: AppSpacing.sm),
              Expanded(child: Text('第 ${step + 1} 步失败', style: AppTextStyles.labelSmall.copyWith(
                  color: AppColors.danger, fontWeight: FontWeight.w700),
                  maxLines: 1, overflow: TextOverflow.ellipsis)),
              const Spacer(),
              TextButton(
                onPressed: onRetry,
                style: TextButton.styleFrom(
                    foregroundColor: AppColors.danger,
                    padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md)),
                child: const Text('重试', style: TextStyle(fontSize: 12)),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.xs),
          // 原文完整展示:上游的 503 队列满 / 504 网关超时对用户就是有效信息
          SelectableText(message,
              style: AppTextStyles.labelSmall.copyWith(color: AppColors.danger, height: 1.6)),
        ],
      ),
    );
  }
}

// ============================================================================
// 2026-09-16(批3 透明工作台):证据块 / 行内编辑
// ----------------------------------------------------------------------------
// 用户诉求:每集生成用了什么剧情段、提示词、参考图、字幕,都要能看见、能改、
// 能知道哪步做得不好。_Evidence 是统一的"折叠证据块":默认收起不吵,
// 展开即原文全量(SelectableText 可复制去核对)。
// ============================================================================

/// 秒 → m:ss(字幕时间轴展示用)
String _mmss(num sec) {
  final s = sec.toDouble();
  final m = (s ~/ 60).toInt();
  final r = (s % 60).toStringAsFixed(1).padLeft(4, '0');
  return '$m:$r';
}

/// 关键帧参考图 URL 列表 → 展示文本(空 = 文生图降级)
String _joinRefs(dynamic k) {
  final urls = (((k as Map?)?['ref_urls'] as List?) ?? const []).join(' ');
  return urls.isEmpty ? '无(文生图降级)' : urls;
}

class _Evidence extends StatelessWidget {
  final String title;
  final String body;
  const _Evidence(this.title, this.body);

  @override
  Widget build(BuildContext context) {
    final text = body.trim();
    if (text.isEmpty) return const SizedBox.shrink();
    return Theme(
      data: ThemeData(dividerColor: Colors.transparent),
      child: ExpansionTile(
        tilePadding: EdgeInsets.zero,
        childrenPadding: const EdgeInsets.only(bottom: AppSpacing.sm),
        title: Row(
          children: [
            Icon(Icons.fact_check_outlined, size: 13, color: AppColors.textTertiary),
            const SizedBox(width: AppSpacing.xs),
            Expanded(child: Text(title,
                maxLines: 1, overflow: TextOverflow.ellipsis,
                style: AppTextStyles.labelSmall.copyWith(color: AppColors.textTertiary))),
          ],
        ),
        children: [
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(AppSpacing.sm),
            decoration: BoxDecoration(
              color: AppColors.background,
              borderRadius: BorderRadius.circular(AppColors.slotRadius),
            ),
            child: SelectableText(text,
                style: AppTextStyles.labelSmall.copyWith(height: 1.6, fontSize: 10)),
          ),
        ],
      ),
    );
  }
}

/// 分镜行内编辑弹框:描述 + 台词一起改,保存走 PUT steps/2/output
class _ShotEditDialog extends StatefulWidget {
  final String initialDesc;
  final String initialDialogue;
  const _ShotEditDialog({required this.initialDesc, required this.initialDialogue});

  @override
  State<_ShotEditDialog> createState() => _ShotEditDialogState();
}

class _ShotEditDialogState extends State<_ShotEditDialog> {
  late final TextEditingController _desc = TextEditingController(text: widget.initialDesc);
  late final TextEditingController _dlg = TextEditingController(text: widget.initialDialogue);

  @override
  void dispose() {
    _desc.dispose();
    _dlg.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('改这一镜', style: TextStyle(fontSize: 15)),
      content: SizedBox(
        width: 420,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('画面描述(供图像/视频生成)', style: AppTextStyles.labelSmall),
            const SizedBox(height: AppSpacing.xs),
            TextField(controller: _desc, maxLines: 3, style: AppTextStyles.bodySmall),
            const SizedBox(height: AppSpacing.md),
            Text('台词/旁白(决定配音与字幕来源)', style: AppTextStyles.labelSmall),
            const SizedBox(height: AppSpacing.xs),
            TextField(controller: _dlg, maxLines: 3, style: AppTextStyles.bodySmall),
            const SizedBox(height: AppSpacing.sm),
            Text('保存后:重跑第 3/4 步才会改画面与配音;只改成片字幕显示请到第 6 步改字幕重烧。',
                style: AppTextStyles.labelSmall.copyWith(fontSize: 10, color: AppColors.textTertiary)),
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        FilledButton(
          onPressed: () => Navigator.pop(context, {
            'description': _desc.text, 'dialogue': _dlg.text,
          }),
          child: const Text('保存'),
        ),
      ],
    );
  }
}
