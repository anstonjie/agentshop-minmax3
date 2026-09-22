// ============================================================================
// DramaCreateDialog —— 建剧表单(剧名 / 主题 / 类型 / 风格圣经 / 画幅)
// ----------------------------------------------------------------------------
// 风格与画幅在这里一次定死:它们是跨集一致性的锚,后续每集只读不改。
// 改风格要在剧集详情的「概览」里改,并会提示受影响资产数。
// ============================================================================

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';

import '../../services/api_client.dart';
import '../../theme/app_colors.dart';
import '../../theme/app_text_styles.dart';
import '../../theme/app_dimens.dart';
import '../../utils/app_toast.dart';
import '../../i18n/i18n.dart';

const _genres = ['现代都市', '悬疑推理', '古装权谋', '科幻惊悚', '都市喜剧', '年代情感'];
const _aspects = ['9:16', '16:9', '4:3', '3:4', '1:1', '21:9'];
const _styles = ['电影质感, 高细节, 写实', '冷色调胶片质感', '国漫赛璐璐', '水墨国风', '复古港片颗粒感'];

class DramaCreateDialog extends StatefulWidget {
  final int? agentId;
  const DramaCreateDialog({super.key, this.agentId});

  @override
  State<DramaCreateDialog> createState() => _DramaCreateDialogState();
}

class _DramaCreateDialogState extends State<DramaCreateDialog> {
  final ApiClient _api = ApiClient();
  final _title = TextEditingController();
  final _topic = TextEditingController();
  final _stylePrompt = TextEditingController(text: _styles.first);
  final _world = TextEditingController();
  String _genre = _genres.first;
  String _aspect = _aspects.first;
  bool _saving = false;

  @override
  void dispose() {
    _title.dispose(); _topic.dispose(); _stylePrompt.dispose(); _world.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final topic = _topic.text.trim();
    if (topic.isEmpty) {
      AppToast.error(context, tr('drama.create_dialog.t01'));
      return;
    }
    setState(() => _saving = true);
    try {
      final resp = await _api.dio.post('/dramas', data: {
        'title': _title.text.trim().isEmpty ? topic : _title.text.trim(),
        'topic': topic,
        'genre': _genre,
        if (widget.agentId != null) 'agentId': widget.agentId,
        'storyMode': 'serial',
        'styleSpec': {'stylePrompt': _stylePrompt.text.trim(), 'aspectRatio': _aspect},
        'bible': {'world': _world.text.trim(), 'genre': _genre},
      });
      final data = (resp.data is Map && (resp.data as Map).containsKey('data'))
          ? (resp.data as Map)['data']
          : resp.data;
      final uuid = (data is Map ? data['uuid'] : null)?.toString();
      if (uuid == null) throw Exception('建剧未返回 uuid');
      if (mounted) Navigator.pop(context, uuid);
    } catch (e) {
      if (!mounted) return;
      setState(() => _saving = false);
      AppToast.error(context, e is DioException ? ApiClient.describeError(e) : '$e');
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      backgroundColor: AppColors.surface,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppColors.cardRadius)),
      title: Row(
        children: [
          Icon(Icons.movie_filter_rounded, size: 18, color: AppColors.primary),
          const SizedBox(width: AppSpacing.sm),
          Flexible(child: Text(tr('drama.create_dialog.t02'), style: const TextStyle(fontWeight: FontWeight.w700), maxLines: 1, overflow: TextOverflow.ellipsis)),
        ],
      ),
      content: SizedBox(
        width: 420,
        child: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              _label('故事主题'),
              _field(_topic, '例:1990 年代渔港,灯塔守人连续失踪'),
              _label('剧名(留空自动取主题)'),
              _field(_title, '例:雾港灯塔'),
              _label('世界观 / 时代'),
              _field(_world, '例:1990s 南方渔港,封闭、多雾、靠海吃饭'),
              _label('类型'),
              Wrap(
                spacing: 8, runSpacing: 8,
                children: _genres.map((g) {
                  final on = g == _genre;
                  return ChoiceChip(
                    label: Text(g),
                    selected: on,
                    labelStyle: AppTextStyles.labelSmall.copyWith(
                        color: on ? AppColors.surface : AppColors.textSecondary),
                    backgroundColor: AppColors.background,
                    selectedColor: AppColors.primary,
                    showCheckmark: false,
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppColors.slotRadius)),
                    onSelected: (_) => setState(() => _genre = g),
                  );
                }).toList(),
              ),
              _label('画幅(全剧统一,决定每镜构图与成片比例)'),
              Wrap(
                spacing: 8, runSpacing: 8,
                children: _aspects.map((a) {
                  final on = a == _aspect;
                  return ChoiceChip(
                    label: Text(a),
                    selected: on,
                    labelStyle: AppTextStyles.labelSmall.copyWith(
                        color: on ? AppColors.surface : AppColors.textSecondary),
                    backgroundColor: AppColors.background,
                    selectedColor: AppColors.primary,
                    showCheckmark: false,
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppColors.slotRadius)),
                    onSelected: (_) => setState(() => _aspect = a),
                  );
                }).toList(),
              ),
              _label('风格锚(全剧唯一,后续每集强制拼接)'),
              _field(_stylePrompt, '电影质感, 高细节, 写实'),
              Wrap(
                spacing: 8, runSpacing: 8,
                children: _styles.map((s) => ActionChip(
                      label: Text(s.length > 12 ? '${s.substring(0, 12)}…' : s),
                      labelStyle: AppTextStyles.labelSmall.copyWith(color: AppColors.textSecondary),
                      backgroundColor: AppColors.background,
                      onPressed: () => setState(() => _stylePrompt.text = s),
                    )).toList(),
              ),
              const SizedBox(height: AppSpacing.md),
              Container(
                padding: const EdgeInsets.all(AppSpacing.md),
                decoration: BoxDecoration(
                  color: AppColors.primary.withValues(alpha: 0.07),
                  borderRadius: BorderRadius.circular(AppColors.slotRadius),
                ),
                child: Text(
                  tr('drama.create.auto_001'),
                  style: AppTextStyles.labelSmall.copyWith(color: AppColors.textSecondary),
                ),
              ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: Text(tr('common.cancel'))),
        ElevatedButton(
          onPressed: _saving ? null : _submit,
          style: ElevatedButton.styleFrom(
            backgroundColor: AppColors.primary,
            foregroundColor: AppColors.surface,
          ),
          child: _saving
              ? const SizedBox(width: AppSpacing.lg, height: AppSpacing.lg,
                  child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
              : Text(tr('drama.create_dialog.t03')),
        ),
      ],
    );
  }

  Widget _label(String t) => Padding(
        padding: const EdgeInsets.only(top: AppSpacing.md, bottom: AppSpacing.xs),
        child: Text(t,
            style: AppTextStyles.labelSmall.copyWith(
                color: AppColors.textSecondary, fontWeight: FontWeight.w600)),
      );

  Widget _field(TextEditingController c, String hint) => TextField(
        controller: c,
        maxLines: 2,
        minLines: 1,
        style: AppTextStyles.bodySmall,
        decoration: InputDecoration(
          hintText: hint,
          hintStyle: AppTextStyles.labelSmall.copyWith(color: AppColors.textTertiary),
          isDense: true,
          contentPadding: const EdgeInsets.symmetric(horizontal: AppSpacing.md, vertical: AppSpacing.md),
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(AppColors.buttonRadius),
            borderSide: BorderSide(color: AppColors.border),
          ),
        ),
      );
}
