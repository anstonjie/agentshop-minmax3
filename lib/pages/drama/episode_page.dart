// ============================================================================
// DramaEpisodePage —— 单集生产工作台(集内 6 步)
// ----------------------------------------------------------------------------
// 后端 API(对齐 backend/src/modules/drama/drama.controller.ts):
//   GET    /api/dramas/:uuid/episodes/:epNo
//   POST   /api/dramas/:uuid/episodes/:epNo/steps/:step/generate
//   POST   /api/dramas/:uuid/episodes/:epNo/steps/:step/confirm
//   PUT    /api/dramas/:uuid/episodes/:epNo/steps/:step/output
//   DELETE /api/dramas/:uuid/episodes/:epNo/steps/:step/output
//   POST   /api/dramas/:uuid/episodes/:epNo/precheck/resolve
//   GET    /api/dramas/:uuid/episodes/continuity
//
// 6 步:0 承接大纲 / 1 资产预检 / 2 分镜 / 3 关键帧 / 4 分镜视频 / 5 成片与回写
//
// 刻意把"失败原因可见"放在第一位:任何一步报错都在步骤内直接展开原文,
// 不只给一个红条 toast —— 生成链路的上游错误(503 队列满 / 504 网关超时)
// 对用户就是有效信息。
// ============================================================================

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';

import '../../services/api_client.dart';
import '../../theme/app_colors.dart';
import '../../theme/app_text_styles.dart';
import '../../widgets/step_rail.dart' show StepItem;
import 'episode_step_views.dart';

import '../../main.dart' show AppRoute;
import '../../theme/app_dimens.dart';
import '../../utils/app_toast.dart';
import '../../widgets/workbench_form.dart';
import '../../i18n/i18n.dart';
class DramaEpisodePage extends StatefulWidget {
  final String dramaUuid;
  final int epNo;
  final String? dramaTitle;

  const DramaEpisodePage({
    super.key, required this.dramaUuid, required this.epNo, this.dramaTitle,
  });

  @override
  State<DramaEpisodePage> createState() => _DramaEpisodePageState();
}

class _DramaEpisodePageState extends State<DramaEpisodePage> {
  final ApiClient _api = ApiClient();

  static final List<StepItem> steps = [
    StepItem(label: tr('drama.episode.t01'), subtitle: tr('drama.episode.t02')),
    StepItem(label: tr('drama.episode.t03'), subtitle: tr('drama.episode.t04')),
    StepItem(label: tr('drama.episode.t05'), subtitle: tr('drama.episode.t06')),
    StepItem(label: tr('drama.episode.t07'), subtitle: tr('drama.episode.t08')),
    StepItem(label: tr('drama.episode.t09'), subtitle: tr('drama.episode.t10')),
    StepItem(label: tr('drama.episode.t11'), subtitle: tr('drama.episode.t12')),
  ];

  Map<String, dynamic> _episode = const {};
  Map<String, dynamic> _continuity = const {};
  Map<String, dynamic> _precheck = const {};
  final TextEditingController _briefCtrl = TextEditingController();
  int _current = 0;
  bool _loading = true;
  bool _busy = false;
  String _busyText = '';
  /// 每步最近一次错误原文(留在页面上,不只弹 toast)
  final Map<int, String> _stepErrors = {};
  List<String> _stepWarnings = const [];
  List<dynamic> _unresolvedAssets = const [];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _loadAll());
  }

  @override
  void dispose() {
    _briefCtrl.dispose();
    super.dispose();
  }

  dynamic _unwrap(Response r) {
    final d = r.data;
    if (d is Map && d.containsKey('data')) return d['data'];
    return d;
  }

  String _err(Object e) =>
      e is DioException ? ApiClient.describeError(e) : e.toString();

  Future<void> _loadAll() async {
    setState(() { _loading = true; });
    try {
      final ep = await _api.dio.get(
        '/dramas/${widget.dramaUuid}/episodes/${widget.epNo}');
      final data = _unwrap(ep);
      Map<String, dynamic> cont = const {};
      try {
        final c = await _api.dio.get(
          '/dramas/${widget.dramaUuid}/episodes/continuity');
        final cd = _unwrap(c);
        if (cd is Map) cont = Map<String, dynamic>.from(cd);
      } catch (_) {/* 前情提要拿不到不阻塞主流程 */}
      if (!mounted) return;
      final loaded = (data is Map) ? Map<String, dynamic>.from(data) : const <String, dynamic>{};
      setState(() {
        _episode = loaded;
        _continuity = cont;
        _current = ((loaded['step'] as num?)?.toInt() ?? 0).clamp(0, steps.length - 1);
        final pc = ((loaded['stepData'] as Map?)?['1']?['output'] as Map?);
        if (pc != null) _precheck = Map<String, dynamic>.from(pc);
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _stepErrors[_current] = _err(e);
        _loading = false;
      });
    }
  }

  /// 调生成接口。图像/视频步给足超时(逐镜推进,单次不会太长)。
  Future<void> _generate(int step, {Map<String, dynamic>? body}) async {
    setState(() {
      _busy = true;
      _busyText = '正在生成「${steps[step].label}」…';
      _stepErrors.remove(step);
    });
    try {
      final resp = await _api.dio.post(
        '/dramas/${widget.dramaUuid}/episodes/${widget.epNo}/steps/$step/generate',
        data: body ?? const {},
        options: Options(receiveTimeout: const Duration(minutes: 20)),
      );
      final data = _unwrap(resp);
      if (!mounted) return;
      if (data is Map) {
        setState(() {
          _episode = Map<String, dynamic>.from(data);
          if (step == 1 && data['precheck'] is Map) {
            _precheck = Map<String, dynamic>.from(data['precheck'] as Map);
          }
          if (data['warnings'] is List) {
            _stepWarnings = (data['warnings'] as List).map((e) => e.toString()).toList();
          }
          if (data['unresolved_assets'] is List) {
            _unresolvedAssets = data['unresolved_assets'] as List;
          }
        });
      }
    } catch (e) {
      if (mounted) setState(() => _stepErrors[step] = _err(e));
    } finally {
      if (mounted) setState(() { _busy = false; _busyText = ''; });
    }
  }

  Future<void> _confirm(int step) async {
    setState(() { _busy = true; _busyText = '保存中…'; });
    try {
      final resp = await _api.dio.post(
        '/dramas/${widget.dramaUuid}/episodes/${widget.epNo}/steps/$step/confirm',
        data: const {},
      );
      final data = _unwrap(resp);
      if (mounted && data is Map) {
        setState(() {
          _episode = Map<String, dynamic>.from(data);
          if (_current < steps.length - 1) _current = step + 1;
        });
      }
    } catch (e) {
      if (mounted) setState(() => _stepErrors[step] = _err(e));
    } finally {
      if (mounted) setState(() { _busy = false; _busyText = ''; });
    }
  }

  Future<void> _deleteOutput(int step) async {
    try {
      final resp = await _api.dio.delete(
        '/dramas/${widget.dramaUuid}/episodes/${widget.epNo}/steps/$step/output');
      final data = _unwrap(resp);
      if (mounted && data is Map) {
        setState(() {
          _episode = Map<String, dynamic>.from(data);
          if (step == 1) _precheck = const {};
        });
      }
    } catch (e) {
      if (mounted) setState(() => _stepErrors[step] = _err(e));
    }
  }

  /// 提交预检裁决。index 必须按后端 summarize 的顺序还原
  /// (hits → variants → ambiguous → news),并逐条校验 need.name 对得上,
  /// 对不上就当场报错而不是静默改错资产 —— 改错会串脸。
  Future<void> _resolve(List<Map<String, dynamic>> decisions) async {
    setState(() { _busy = true; _busyText = '应用裁决…'; });
    try {
      final resp = await _api.dio.post(
        '/dramas/${widget.dramaUuid}/episodes/${widget.epNo}/precheck/resolve',
        data: {'decisions': decisions},
        options: Options(receiveTimeout: const Duration(minutes: 10)),
      );
      final data = _unwrap(resp);
      if (mounted && data is Map) {
        setState(() => _episode = Map<String, dynamic>.from(data));
        await _loadAll();
      }
    } catch (e) {
      if (mounted) setState(() => _stepErrors[1] = _err(e));
    } finally {
      if (mounted) setState(() { _busy = false; _busyText = ''; });
    }
  }

  /// 第 0 步要把「本集补充要求」一起提交,其它步骤无额外入参
  Map<String, dynamic> _bodyForStep() {
    if (_current == 0 && _briefCtrl.text.trim().isNotEmpty) {
      return {'brief': _briefCtrl.text.trim()};
    }
    return const {};
  }

  Map<String, dynamic> _outputOf(int step) {
    final sd = (_episode['stepData'] as Map?)?.cast<String, dynamic>();
    final s = (sd?[step.toString()] as Map?)?.cast<String, dynamic>();
    final o = s?['output'];
    return (o is Map) ? Map<String, dynamic>.from(o) : const {};
  }

  // ── 2026-09-16(批3 透明工作台):可看可改可重做 ──
  /// 已记下但还没重烧的字幕修改([{shotIdx, text}])
  final List<Map<String, dynamic>> _pendingSubEdits = [];

  /// 保存某步产出的行内编辑(后端 PUT steps/:step/output 早已实现,前端此前零调用)
  Future<void> _putOutput(int step, Map<String, dynamic> output) async {
    setState(() { _busy = true; _busyText = '保存修改…'; });
    try {
      final resp = await _api.dio.put(
        '/dramas/${widget.dramaUuid}/episodes/${widget.epNo}/steps/$step/output',
        data: output);
      final data = _unwrap(resp);
      if (mounted && data is Map) {
        setState(() => _episode = Map<String, dynamic>.from(data));
      }
    } catch (e) {
      if (mounted) setState(() => _stepErrors[step] = _err(e));
    } finally {
      if (mounted) setState(() { _busy = false; _busyText = ''; });
    }
  }

  /// 字幕编辑 → 重烧(后端复用 concat.mp4,不重烧视频配额)
  Future<void> _reburnSubtitles(List<Map<String, dynamic>> edits) async {
    setState(() { _busy = true; _busyText = '重烧字幕…'; });
    try {
      final resp = await _api.dio.post(
        '/dramas/${widget.dramaUuid}/episodes/${widget.epNo}/subtitles/reburn',
        data: {'edits': edits},
        options: Options(receiveTimeout: const Duration(minutes: 10)),
      );
      final data = _unwrap(resp);
      if (mounted && data is Map) {
        setState(() {
          _episode = Map<String, dynamic>.from(data);
          _pendingSubEdits.clear();
        });
        _toast(data['needsRealign'] == true
            ? '字幕已重烧;字数变化超阈值,精确对齐需重跑分镜视频'
            : '字幕已重烧进成片');
      }
    } catch (e) {
      if (mounted) setState(() => _stepErrors[5] = _err(e));
    } finally {
      if (mounted) setState(() { _busy = false; _busyText = ''; });
    }
  }

  /// 缺镜一键补做:重跑 step4(成功镜复用,只补失败镜)+ step5 重合成
  Future<void> _supplementShots() async {
    await _generate(4);
    if (!mounted) return;
    await _generate(5);
    if (!mounted) return;
    final missing = (_outputOf(5)['missing_shots'] as num?) ?? 0;
    _toast(missing > 0 ? '补做完成,仍缺 $missing 镜(可再点一次或看失败原因)' : '补做完成,成片已重合成');
  }

  /// 记一条字幕修改(弹框收集,攒够一起重烧)
  Future<void> _editCue(Map<String, dynamic> cue) async {
    final ctrl = TextEditingController(text: '${cue['text'] ?? ''}');
    final res = await showDialog<String>(
      context: context,
      builder: (c) => AlertDialog(
        title: Text(tr('drama.episode.t13'), style: const TextStyle(fontSize: 15)),
        content: TextField(
          controller: ctrl, maxLines: 3, autofocus: true,
          style: AppTextStyles.bodySmall,
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c), child: Text(tr('common.cancel'))),
          FilledButton(
            onPressed: () => Navigator.pop(c, ctrl.text),
            child: Text(tr('drama.episode.t14')),
          ),
        ],
      ),
    );
    ctrl.dispose();
    if (res == null || res == '${cue['text'] ?? ''}') return;
    setState(() => _pendingSubEdits.add({
          'shotIdx': cue['shotIdx'],
          'text': res,
        }));
  }

  bool _confirmed(int step) {
    final sd = (_episode['stepData'] as Map?)?.cast<String, dynamic>();
    final s = (sd?[step.toString()] as Map?)?.cast<String, dynamic>();
    return s != null && s['confirmedAt'] != null;
  }

  void _toast(String msg, {bool bad = false}) {
    if (!mounted) return;
    AppToast.success(context, msg);
  }

  @override
  Widget build(BuildContext context) {
    final epTitle = (_episode['title'] ?? '第 ${widget.epNo} 集').toString();
    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        title: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('EP${widget.epNo} · $epTitle',
                maxLines: 1, overflow: TextOverflow.ellipsis,
                style: AppTextStyles.bodyMedium.copyWith(fontSize: 15, fontWeight: FontWeight.w700)),
            if (widget.dramaTitle != null)
              Text(widget.dramaTitle!,
                  maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: AppTextStyles.labelSmall.copyWith(
                       color: AppColors.textTertiary)),
          ],
        ),
        centerTitle: true,
        leading: IconButton(
          tooltip: tr('common.back'),
          icon: const Icon(Icons.arrow_back_ios_new),
          onPressed: () => Navigator.of(context).maybePop(),
        ),
        actions: [
          if (widget.epNo > 1)
            IconButton(
              tooltip: tr('drama.episode.t15'),
              icon: const Icon(Icons.chevron_left),
              onPressed: _busy ? null : () => _switchEpisode(widget.epNo - 1),
            ),
          IconButton(
            tooltip: tr('common.refresh'),
            icon: const Icon(Icons.refresh),
            onPressed: _busy ? null : _loadAll,
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : Stack(
              children: [
                Column(
                  children: [
                    _buildStepBar(),
                    Expanded(child: _buildStepBody()),
                    _buildFooter(),
                  ],
                ),
                if (_busy) _buildBusyOverlay(),
              ],
            ),
    );
  }

  Future<void> _switchEpisode(int target) async {
    await Navigator.pushReplacementNamed(
      context, AppRoute.dramaEpisode,
      arguments: {
        'dramaUuid': widget.dramaUuid,
        'epNo': target,
        'dramaTitle': widget.dramaTitle,
      },
    );
  }

  Widget _buildStepBar() {
    return Container(
      decoration: BoxDecoration(
        color: AppColors.surface.withValues(alpha: 0.6),
        border: Border(bottom: BorderSide(color: AppColors.border.withValues(alpha: 0.4))),
      ),
      child: SafeArea(
        top: false,
        child: Column(
          children: [
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md, vertical: AppSpacing.md),
              child: Row(
                children: List.generate(steps.length, (i) => _buildDot(i, i == steps.length - 1)),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(AppSpacing.lg, 0, AppSpacing.lg, AppSpacing.md),
              child: Row(
                children: [
                  Text(tr('drama.episode.t16', args: {'cur': '${_current + 1}', 'total': '${steps.length}'}),
                      style: AppTextStyles.labelSmall.copyWith(
                          color: AppColors.primary, fontWeight: FontWeight.w700)),
                  const SizedBox(width: AppSpacing.sm),
                  Expanded(
                    child: Text(steps[_current].label,
                        maxLines: 1, overflow: TextOverflow.ellipsis,
                        style: AppTextStyles.bodyMedium.copyWith(
                            fontSize: 15, fontWeight: FontWeight.w700)),
                  ),
                  Text('${_episode['status'] ?? ''}',
                      style: AppTextStyles.labelSmall.copyWith(color: AppColors.textTertiary)),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildDot(int i, bool isLast) {
    final hasOutput = _outputOf(i).isNotEmpty;
    final maxStep = (_episode['step'] as num?)?.toInt() ?? 0;
    final isDone = _confirmed(i) || i < maxStep;
    final hasError = _stepErrors.containsKey(i);
    final isActive = i == _current;
    final color = hasError
        ? AppColors.danger
        : (isDone ? AppColors.success : (isActive ? AppColors.primary : AppColors.textTertiary));

    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        InkWell(
          onTap: () => setState(() => _current = i),
          borderRadius: BorderRadius.circular(AppColors.cardRadius),
          child: Container(
            width: 30, height: 30,
            decoration: BoxDecoration(
              color: (isDone || hasError) ? color : color.withValues(alpha: 0.12),
              shape: BoxShape.circle,
              border: Border.all(color: color, width: 1.5),
              boxShadow: isActive
                  ? [BoxShadow(color: color.withValues(alpha: 0.3), blurRadius: 8, spreadRadius: 1)]
                  : null,
            ),
            child: Center(
              child: hasError
                  ? Icon(Icons.priority_high, size: 14, color: AppColors.surface)
                  : (isDone
                      ? Icon(Icons.check, size: 14, color: AppColors.surface)
                      : (hasOutput
                          ? Icon(Icons.circle, size: 9, color: color)
                          : Text('${i + 1}',
                              style: AppTextStyles.labelSmall.copyWith(
                                  color: color, fontWeight: FontWeight.w700)))),
            ),
          ),
        ),
        if (!isLast)
          Container(
            width: 20, height: 2,
            color: isDone ? AppColors.success.withValues(alpha: 0.5) : AppColors.border.withValues(alpha: 0.5),
          ),
      ],
    );
  }

  Widget _buildStepBody() {
    final ctx = EpisodeCtx(
      episode: _episode,
      continuity: _continuity,
      precheck: _precheck,
      step: _current,
      hasOutput: _outputOf(_current).isNotEmpty,
      output: _outputOf(_current),
      error: _stepErrors[_current],
      warnings: _current == 0 ? _stepWarnings : const [],
      unresolvedAssets: _current == 2 ? _unresolvedAssets : const [],
      briefCtrl: _briefCtrl,
      onGenerate: _generate,
      onDeleteOutput: _deleteOutput,
      onResolve: _resolve,
      toast: _toast,
      busy: _busy,
      onPutOutput: _putOutput,
      onReburnSubtitles: _reburnSubtitles,
      onSupplementShots: _supplementShots,
      onEditCue: _editCue,
      pendingSubEdits: _pendingSubEdits,
    );
    return EpisodeStepBody(ctx: ctx);
  }

  Widget _buildFooter() {
    final out = _outputOf(_current);
    final canConfirm = out.isNotEmpty && !_confirmed(_current);
    return Container(
      padding: const EdgeInsets.fromLTRB(AppSpacing.lg, AppSpacing.md, AppSpacing.lg, AppSpacing.lg),
      decoration: BoxDecoration(
        color: AppColors.surface.withValues(alpha: 0.9),
        border: Border(top: BorderSide(color: AppColors.border.withValues(alpha: 0.5))),
      ),
      child: Row(
        children: [
          if (out.isNotEmpty)
            IconButton(
              onPressed: _busy ? null : () => _deleteOutput(_current),
              icon: Icon(Icons.delete_outline, color: AppColors.danger),
              tooltip: tr('drama.episode.t17'),
            ),
          Expanded(
            child: canConfirm
                ? OutlinedButton.icon(
                    onPressed: _busy ? null : () => _confirm(_current),
                    icon: const Icon(Icons.check_circle_outline, size: 17),
                    label: Text(tr('drama.episode.t18')),
                    style: OutlinedButton.styleFrom(
                      foregroundColor: AppColors.success,
                      padding: const EdgeInsets.symmetric(vertical: AppSpacing.md),
                    ),
                  )
                : ElevatedButton.icon(
                    onPressed: _busy ? null : () => _generate(_current, body: _bodyForStep()),
                    icon: const Icon(Icons.auto_awesome, size: 17),
                    label: Text(out.isEmpty ? tr('drama.episode.auto_001', args: {'steps': steps[_current].label}) : tr('drama.episode.auto_002')),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: AppColors.primary,
                      foregroundColor: AppColors.surface,
                      padding: const EdgeInsets.symmetric(vertical: AppSpacing.md),
                    ),
                  ),
          ),
        ],
      ),
    );
  }

  Widget _buildBusyOverlay() {
    return Positioned.fill(
      child: Container(
        color: Colors.black.withValues(alpha: 0.45),
        child: Center(
          child: WbCard(
            margin: const EdgeInsets.symmetric(horizontal: AppSpacing.jumbo),
            padding: const EdgeInsets.all(AppSpacing.xxl),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const CircularProgressIndicator(),
                const SizedBox(height: AppSpacing.lg),
                Text(_busyText, style: AppTextStyles.bodyMedium),
                const SizedBox(height: AppSpacing.sm),
                Text(tr('drama.episode.t19'),
                    style: AppTextStyles.labelSmall.copyWith(color: AppColors.textTertiary)),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
