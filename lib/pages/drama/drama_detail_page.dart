// ============================================================================
// DramaDetailPage —— 剧集详情(概览 / 资产库 / 分集 三 Tab)
// ----------------------------------------------------------------------------
// 「一部剧 = 一个区域,里面罗列所有分集」就是本页的分集 Tab。
// 后端:GET /api/dramas/:uuid · POST /episodes · POST /batches · PUT /style · POST /arc
// ============================================================================

import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';

import '../../services/api_client.dart';
import '../../theme/app_colors.dart';
import '../../theme/app_text_styles.dart';
import '../../utils/web_download.dart';
import '../../services/ws_progress_client.dart';
import 'drama_assets_tab.dart';

import '../../main.dart' show AppRoute;
import '../../theme/app_dimens.dart';
import '../../utils/app_toast.dart';
import '../../i18n/i18n.dart';
class DramaDetailPage extends StatefulWidget {
  final String uuid;
  final String? agentName;
  final int initialTab;

  const DramaDetailPage({
    super.key, required this.uuid, this.agentName, this.initialTab = 0,
  });

  @override
  State<DramaDetailPage> createState() => _DramaDetailPageState();
}

class _DramaDetailPageState extends State<DramaDetailPage>
    with SingleTickerProviderStateMixin {
  final ApiClient _api = ApiClient();
  late final TabController _tabs;

  Map<String, dynamic> _drama = const {};
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _tabs = TabController(length: 3, vsync: this, initialIndex: widget.initialTab);
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  @override
  void dispose() {
    _tabs.dispose();
    super.dispose();
  }

  dynamic _unwrap(Response r) {
    final d = r.data;
    if (d is Map && d.containsKey('data')) return d['data'];
    return d;
  }

  Future<void> _load() async {
    setState(() { _loading = true; _error = null; });
    try {
      final resp = await _api.dio.get('/dramas/${widget.uuid}');
      final data = _unwrap(resp);
      if (data is Map && mounted) {
        setState(() {
          _drama = Map<String, dynamic>.from(data);
          _loading = false;
        });
      } else if (mounted) {
        setState(() { _loading = false; _error = '剧集数据格式异常'; });
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e is DioException ? ApiClient.describeError(e) : e.toString();
        _loading = false;
      });
    }
  }

  void _toast(String msg, {bool bad = false}) {
    if (!mounted) return;
    AppToast.success(context, msg);
  }

  /// 打开账本原文阅读器(只读通路 —— 传 dramaUuid 而非生成任务 uuid)
  void _openNovel() {
    Navigator.pushNamed(context, AppRoute.novelReader, arguments: {
      'dramaUuid': widget.uuid,
      'title': (_drama['title'] ?? '').toString(),
    });
  }

  @override
  Widget build(BuildContext context) {
    final title = (_drama['title'] ?? '剧集详情').toString();
    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        title: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis),
        centerTitle: true,
        actions: [
          // 2026-09-14:小说原文入口 —— 上传型小说(入口 B)没有生成任务,
          //   「我的小说」书架靠账本快照列出它;这里再给一个就近入口,
          //   后端 hasNovelText 为 false 时整个按钮不出现(避免必然报错)。
          if (_drama['hasNovelText'] == true)
            IconButton(
              tooltip: tr('drama.detail.t01'),
              onPressed: _openNovel,
              icon: const Icon(Icons.menu_book_outlined),
            ),
          IconButton(tooltip: tr('common.refresh'), onPressed: _load, icon: const Icon(Icons.refresh)),
        ],
        bottom: TabBar(
          controller: _tabs,
          labelColor: AppColors.primary,
          unselectedLabelColor: AppColors.textTertiary,
          indicatorColor: AppColors.primary,
          tabs: const [
            Tab(text: '概览'),
            Tab(text: '资产库'),
            Tab(text: '分集'),
          ],
        ),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(AppSpacing.xxxl),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(_error!, textAlign: TextAlign.center,
                            style: AppTextStyles.bodySmall.copyWith(color: AppColors.danger)),
                        const SizedBox(height: AppSpacing.md),
                        OutlinedButton(onPressed: _load, child: Text(tr('common.retry'))),
                      ],
                    ),
                  ),
                )
              : TabBarView(
                  controller: _tabs,
                  children: [
                    _OverviewTab(
                      drama: _drama,
                      onReload: _load,
                      onStyleSaved: (n) {
                        _toast(n > 0 ? '风格已更新,$n 项资产需重制' : '风格已更新');
                        _load();
                      },
                      onArcSaved: () { _toast('故事线已保存'); _load(); },
                    ),
                    DramaAssetsTab(uuid: widget.uuid),
                    _EpisodesTab(
                      uuid: widget.uuid,
                      drama: _drama,
                      onChanged: _load,
                      toast: _toast,
                    ),
                  ],
                ),
    );
  }
}

// ============================================================================
// Tab 1 · 概览:圣经 / 风格圣经 / 全季故事线 / 世界状态快照
// ============================================================================
class _OverviewTab extends StatefulWidget {
  final Map<String, dynamic> drama;
  final ValueChanged<int> onStyleSaved;
  final VoidCallback onArcSaved;
  /// 定妆设计完成后刷新整页(资产库 Tab 要立刻看到新增的待补图资产)
  final VoidCallback onReload;
  const _OverviewTab({
    required this.drama, required this.onStyleSaved,
    required this.onArcSaved, required this.onReload,
  });

  @override
  State<_OverviewTab> createState() => _OverviewTabState();
}

class _OverviewTabState extends State<_OverviewTab> {
  final ApiClient _api = ApiClient();
  final _stylePrompt = TextEditingController();
  String _aspect = '9:16';
  bool _busy = false;
  bool _designBusy = false;
  String? _designResult;

  static const _aspects = ['9:16', '16:9', '4:3', '3:4', '1:1', '21:9'];

  @override
  void initState() {
    super.initState();
    final s = (widget.drama['styleSpec'] as Map?)?.cast<String, dynamic>() ?? const {};
    _stylePrompt.text = (s['stylePrompt'] ?? '').toString();
    _aspect = (s['aspectRatio'] ?? '9:16').toString();
  }

  @override
  void dispose() {
    _stylePrompt.dispose();
    super.dispose();
  }

  Future<void> _saveStyle() async {
    setState(() => _busy = true);
    try {
      final resp = await _api.dio.put(
        '/dramas/${widget.drama['uuid']}/style',
        data: {'stylePrompt': _stylePrompt.text.trim(), 'aspectRatio': _aspect},
      );
      final data = (resp.data is Map && (resp.data as Map).containsKey('data'))
          ? (resp.data as Map)['data'] : resp.data;
      widget.onStyleSaved((data is Map ? data['staleAssetCount'] : 0) as int? ?? 0);
    } catch (e) {
      if (mounted) {
        AppToast.error(context, tr('drama.detail.t02', args: {'err': '${e is DioException ? ApiClient.describeError(e) : e}'}));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// 跑一次剧级美术设计:只花一次 LLM,不烧图像配额。
  /// 图留给资产库逐资产生成 —— 整剧一把梭必然把请求吊死在 HTTP 里。
  Future<void> _runDesign() async {
    setState(() { _designBusy = true; _designResult = null; });
    try {
      final resp = await _api.dio.post(
        '/dramas/${widget.drama['uuid']}/setup/design',
        data: const {},
        options: Options(receiveTimeout: const Duration(minutes: 3)),
      );
      final raw = resp.data;
      final data = (raw is Map && raw.containsKey('data')) ? raw['data'] : raw;
      final created = (data is Map ? (data['created'] as List?) : null) ?? const [];
      final skipped = (data is Map ? (data['skipped'] as List?) : null) ?? const [];
      setState(() {
        _designResult = created.isEmpty
            ? '资产库已是最新(跳过 ${skipped.length} 项)'
            : '已建 ${created.length} 项资产,去「资产库」逐个生成定妆图';
      });
      widget.onReload();
    } catch (e) {
      // 失败原因要能读到,不能只给一句"操作失败"
      if (!mounted) return;
      AppToast.error(context, tr('drama.detail.t03',
            args: {'err': '${e is DioException ? ApiClient.describeError(e) : e}'}));
    } finally {
      if (mounted) setState(() => _designBusy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final d = widget.drama;
    final bible = (d['bible'] as Map?)?.cast<String, dynamic>() ?? const {};
    final snap = (d['snapshot'] as Map?)?.cast<String, dynamic>() ?? const {};
    final arc = (d['storyArc'] as List?)?.cast<Map>() ?? const [];
    final facts = (snap['establishedFacts'] as List?)?.cast<dynamic>() ?? const [];
    final hooks = (snap['openHooks'] as List?)?.cast<dynamic>() ?? const [];

    return ListView(
      padding: const EdgeInsets.fromLTRB(AppSpacing.lg, AppSpacing.lg, AppSpacing.lg, AppSpacing.jumbo),
      children: [
        if ((d['logline'] ?? '').toString().isNotEmpty)
          _card('一句话故事', Text('${d['logline']}', style: AppTextStyles.bodyMedium)),
        if ((d['synopsis'] ?? '').toString().isNotEmpty)
          _card('剧情梗概', Text('${d['synopsis']}', style: AppTextStyles.bodySmall)),
        _card('世界观 / 设定', Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _kv('类型', bible['genre']), _kv('时代', bible['era']),
            _kv('基调', bible['tone']), _kv('世界', bible['world']),
            if ((bible['rules'] as List?)?.isNotEmpty ?? false) ...[
              const SizedBox(height: AppSpacing.sm),
              Text(tr('drama.detail.t04', args: {'rules': (bible['rules'] as List).join(' / ')}),
                  style: AppTextStyles.labelSmall.copyWith(color: AppColors.textSecondary)),
            ],
          ],
        )),
        _card('风格圣经(全剧统一,改了就等于换美术)', Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            TextField(
              controller: _stylePrompt,
              maxLines: 2, minLines: 1,
              style: AppTextStyles.bodySmall,
              decoration: InputDecoration(
                isDense: true, labelText: tr('drama.detail.t05'), labelStyle: const TextStyle(),
              ),
            ),
            const SizedBox(height: AppSpacing.sm),
            Wrap(
              spacing: 8, runSpacing: 6,
              children: _aspects.map((a) {
                final on = a == _aspect;
                return InkWell(
                  onTap: () => setState(() => _aspect = a),
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md, vertical: AppSpacing.xs),
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(AppColors.slotRadius),
                      color: on ? AppColors.primary : AppColors.background,
                      border: Border.all(color: on ? AppColors.primary : AppColors.border),
                    ),
                    child: Text(a, style: AppTextStyles.labelSmall.copyWith(
                        color: on ? Colors.white : AppColors.textSecondary)),
                  ),
                );
              }).toList(),
            ),
            const SizedBox(height: AppSpacing.md),
            Row(
              children: [
                Expanded(child: Text(tr('drama.detail.t06', args: {'sig': "${(d['styleSpec'] as Map?)?['sigHash'] ?? '—'}"}),
                    style: AppTextStyles.labelSmall.copyWith(
                        fontSize: 10, color: AppColors.textTertiary),
                        maxLines: 1, overflow: TextOverflow.ellipsis)),
                const Spacer(),
                ElevatedButton(
                  onPressed: _busy ? null : _saveStyle,
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppColors.primary, foregroundColor: AppColors.surface,
                    padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg, vertical: AppSpacing.sm),
                  ),
                  child: Text(tr('drama.detail.t07')),
                ),
              ],
            ),
          ],
        )),
        _card('剧级美术设定(角色 / 场景 / 道具)', Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(tr('drama.detail.t08'),
                style: AppTextStyles.labelSmall.copyWith(color: AppColors.textTertiary)),
            const SizedBox(height: AppSpacing.sm),
            ElevatedButton.icon(
              onPressed: _designBusy ? null : _runDesign,
              icon: _designBusy
                  ? const SizedBox(width: AppSpacing.lg, height: AppSpacing.lg,
                      child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                  : const Icon(Icons.palette_outlined, size: 16),
              label: Text(_designBusy ? tr('drama.detail.auto_001') : tr('drama.detail.auto_002')),
              style: ElevatedButton.styleFrom(
                backgroundColor: AppColors.primary, foregroundColor: AppColors.surface,
                padding: const EdgeInsets.symmetric(vertical: AppSpacing.md),
              ),
            ),
            if (_designResult != null) ...[
              const SizedBox(height: AppSpacing.sm),
              Text(_designResult!,
                  style: AppTextStyles.labelSmall.copyWith(color: AppColors.success)),
            ],
          ],
        )),
        _card('全季故事线(${arc.length} 集规划)', arc.isEmpty
            ? Text(tr('drama.detail.t09'),
                style: AppTextStyles.labelSmall.copyWith(color: AppColors.textTertiary))
            : Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: arc.map((a) => Padding(
                  padding: const EdgeInsets.only(bottom: AppSpacing.sm),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm, vertical: AppSpacing.xxs),
                        decoration: BoxDecoration(
                          color: a['done'] == true
                              ? AppColors.success.withValues(alpha: 0.14)
                              : AppColors.primary.withValues(alpha: 0.12),
                          borderRadius: BorderRadius.circular(AppColors.tagRadius),
                        ),
                        child: Text('EP${a['ep']}', style: AppTextStyles.labelSmall.copyWith(
                            color: a['done'] == true ? AppColors.success : AppColors.primary,
                            fontWeight: FontWeight.w700)),
                      ),
                      const SizedBox(width: AppSpacing.sm),
                      Expanded(
                        child: Text(
                          tr('drama.detail.auto_003', args: {'a': "${a['purpose'] ?? ''}", 'cliff': ((a['cliffhanger'] ?? '').toString().isEmpty ? '' : tr('drama.cliffhanger_suffix', args: {'text': "${a['cliffhanger']}"}))}),
                          style: AppTextStyles.bodySmall,
                        ),
                      ),
                    ],
                  ),
                )).toList(),
              )),
        _card('世界状态快照(第 ${snap['sourceEp'] ?? 0} 集结尾)', Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (facts.isEmpty)
              Text(tr('drama.detail.t10'),
                  style: AppTextStyles.labelSmall.copyWith(color: AppColors.textTertiary))
            else
              ...facts.map((f) => Text('· $f', style: AppTextStyles.bodySmall)),
            if (hooks.isNotEmpty) ...[
              const SizedBox(height: AppSpacing.sm),
              Text(tr('drama.detail.t11', args: {'hooks': hooks.join(' / ')}),
                  style: AppTextStyles.labelSmall.copyWith(color: AppColors.warning)),
            ],
          ],
        )),
        if ((d['nextHookIn'] ?? '').toString().isNotEmpty)
          _card('下一集将接住', Text('${d['nextHookIn']}',
              style: AppTextStyles.bodyMedium.copyWith(color: AppColors.primary))),
      ],
    );
  }

  Widget _kv(String k, dynamic v) => (v == null || v.toString().isEmpty)
      ? const SizedBox.shrink()
      : Padding(
          padding: const EdgeInsets.only(bottom: AppSpacing.xs),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SizedBox(width: AppSpacing.huge, child: Text(k,
                  style: AppTextStyles.labelSmall.copyWith(color: AppColors.textTertiary))),
              Expanded(child: Text('$v', style: AppTextStyles.bodySmall)),
            ],
          ),
        );

  Widget _card(String title, Widget child) {
    return Container(
      margin: const EdgeInsets.only(bottom: AppSpacing.md),
      padding: const EdgeInsets.all(AppSpacing.lg),
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

// ============================================================================
// Tab 3 · 分集:一部剧一个区域,罗列所有集
// ============================================================================
class _EpisodesTab extends StatefulWidget {
  final String uuid;
  final Map<String, dynamic> drama;
  final VoidCallback onChanged;
  final void Function(String msg, {bool bad}) toast;
  const _EpisodesTab({
    required this.uuid, required this.drama, required this.onChanged, required this.toast,
  });

  @override
  State<_EpisodesTab> createState() => _EpisodesTabState();
}

class _EpisodesTabState extends State<_EpisodesTab> {
  final ApiClient _api = ApiClient();
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _syncBatchSubscriptions());
  }

  /// 活跃批次的 WS 订阅。进度事件到达时节流刷新,避免每镜一条事件就打一次接口。
  final Map<String, StreamSubscription<ProgressEvent>> _subs = {};
  DateTime _lastRefresh = DateTime.fromMillisecondsSinceEpoch(0);

  void _syncBatchSubscriptions() {
    final batches = ((widget.drama['batches'] as List?) ?? const [])
        .whereType<Map>()
        .map((e) => Map<String, dynamic>.from(e))
        .toList();
    final active = batches
        .where((b) => ['queued', 'running'].contains(b['status']))
        .map((b) => b['uuid'].toString())
        .toSet();
    // 掉出活跃集合的订阅要取消,否则会一直挂着泄漏
    for (final id in _subs.keys.toList()) {
      if (!active.contains(id)) {
        _subs.remove(id)?.cancel();
        WsProgressClient().unsubscribe('batch:$id');
      }
    }
    for (final id in active) {
      if (_subs.containsKey(id)) continue;
      final room = 'batch:$id';
      _subs[id] = WsProgressClient().subscribe(room).listen((ev) {
        if (!mounted) return;
        final now = DateTime.now();
        if (now.difference(_lastRefresh).inSeconds < 3) return;
        _lastRefresh = now;
        widget.onChanged();
      });
    }
  }

  @override
  void didUpdateWidget(covariant _EpisodesTab oldWidget) {
    super.didUpdateWidget(oldWidget);
    _syncBatchSubscriptions();
  }

  @override
  void dispose() {
    for (final id in _subs.keys) {
      WsProgressClient().unsubscribe('batch:$id');
    }
    for (final s in _subs.values) {
      s.cancel();
    }
    _subs.clear();
    super.dispose();
  }

  Future<void> _resume(String batchUuid, int budget) async {
    try {
      final resp = await _api.dio.post(
        '/dramas/batches/$batchUuid/resume',
        data: {'budgetCredits': budget},
      );
      final data = resp.data is Map ? Map<String, dynamic>.from(resp.data as Map) : const {};
      if (data['enqueued'] == false) {
        widget.toast(tr('drama.resume_failed', args: {'reason': data['reason'] ?? tr('novel_drama.queue_unavailable')}), bad: true);
      } else {
        widget.toast('已从断点续跑');
      }
      widget.onChanged();
    } catch (e) {
      widget.toast('续跑失败:${e is DioException ? ApiClient.describeError(e) : e}', bad: true);
    }
  }

  List<Map<String, dynamic>> get _eps {
    final raw = widget.drama['episodes'] as List?;
    if (raw == null) return const [];
    return raw.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList();
  }

  Future<void> _createEpisode() async {
    final ctrl = TextEditingController();
    final title = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppColors.surface,
        title: Text(tr('drama.detail.t12')),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(tr('drama.detail.t13', args: {'n': "${(_eps.isEmpty ? 0 : _eps.last['epNo'] as int) + 1}"}),
                style: AppTextStyles.bodyMedium),
            const SizedBox(height: AppSpacing.sm),
            TextField(
              controller: ctrl, autofocus: true, style: AppTextStyles.bodySmall,
              decoration: InputDecoration(hintText: tr('drama.detail.t14')),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: Text(tr('common.cancel'))),
          ElevatedButton(
            onPressed: () => Navigator.pop(ctx, ctrl.text.trim()),
            style: ElevatedButton.styleFrom(
                backgroundColor: AppColors.primary, foregroundColor: AppColors.surface),
            child: Text(tr('drama.detail.t15')),
          ),
        ],
      ),
    );
    ctrl.dispose();
    if (title == null) return;
    try {
      await _api.dio.post('/dramas/${widget.uuid}/episodes',
          data: {'title': title.isEmpty ? null : title});
      widget.toast('已新建分集,前情钩子自动带入');
      widget.onChanged();
    } catch (e) {
      widget.toast('建集失败:${e is DioException ? ApiClient.describeError(e) : e}', bad: true);
    }
  }

  Future<void> _openBatch() async {
    final from = TextEditingController();
    final to = TextEditingController();
    final budget = TextEditingController(text: '900');
    final next = (_eps.isEmpty ? 0 : _eps.last['epNo'] as int) + 1;
    from.text = '$next';
    to.text = '${next + 2}';
    final go = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppColors.surface,
        title: Text(tr('drama.detail.t16')),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(tr('drama.detail.t17'),
                style: const TextStyle(fontSize: 12)),
            const SizedBox(height: AppSpacing.md),
            Row(children: [
              Expanded(child: _num(from, '起始集')),
              const SizedBox(width: AppSpacing.sm),
              Expanded(child: _num(to, '结束集')),
            ]),
            const SizedBox(height: AppSpacing.sm),
            _num(budget, '积分预算(必填)'),
            const SizedBox(height: AppSpacing.sm),
            Text(tr('drama.detail.t18'),
                style: AppTextStyles.labelSmall.copyWith(color: AppColors.textTertiary)),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: Text(tr('common.cancel'))),
          ElevatedButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: ElevatedButton.styleFrom(
                backgroundColor: AppColors.primary, foregroundColor: AppColors.surface),
            child: Text(tr('drama.detail.t19')),
          ),
        ],
      ),
    );
    if (go != true) { from.dispose(); to.dispose(); budget.dispose(); return; }
    try {
      final resp = await _api.dio.post('/dramas/${widget.uuid}/batches', data: {
        'fromEp': int.tryParse(from.text) ?? next,
        'toEp': int.tryParse(to.text) ?? next + 2,
        'policy': {'budgetCredits': int.tryParse(budget.text) ?? 0},
      });
      final data = resp.data is Map ? Map<String, dynamic>.from(resp.data as Map) : const {};
      final inner = data['data'] is Map
          ? Map<String, dynamic>.from(data['data'] as Map)
          : data;
      if (inner['enqueued'] == false) {
        // Redis 没起时批次仍会落库,但不会自动跑 —— 必须说清楚,
        // 否则用户会盯着一个永远不动的进度条。
        widget.toast(tr('drama.enqueue_failed', args: {'reason': inner['reason'] ?? tr('novel_drama.queue_unavailable')}), bad: true);
      } else {
        widget.toast('已入队,后台开始连集');
      }
      widget.onChanged();
    } catch (e) {
      widget.toast('失败:${e is DioException ? ApiClient.describeError(e) : e}', bad: true);
    }
    from.dispose(); to.dispose(); budget.dispose();
  }

  Widget _num(TextEditingController c, String label) => TextField(
        controller: c, keyboardType: TextInputType.number,
        style: AppTextStyles.bodySmall,
        decoration: InputDecoration(labelText: label, labelStyle: const TextStyle(), isDense: true),
      );

  @override
  Widget build(BuildContext context) {
    final batches = ((widget.drama['batches'] as List?) ?? const [])
        .whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList();
    return ListView(
      padding: const EdgeInsets.fromLTRB(AppSpacing.lg, AppSpacing.md, AppSpacing.lg, AppSpacing.jumbo),
      children: [
        Row(
          children: [
            Expanded(
              child: ElevatedButton.icon(
                onPressed: _openBatch,
                icon: const Icon(Icons.play_circle_outline, size: 17),
                label: Text(tr('drama.detail.t20')),
                style: ElevatedButton.styleFrom(
                  backgroundColor: AppColors.primary, foregroundColor: AppColors.surface,
                  padding: const EdgeInsets.symmetric(vertical: AppSpacing.md),
                ),
              ),
            ),
            const SizedBox(width: AppSpacing.md),
            Expanded(
              child: OutlinedButton.icon(
                onPressed: _createEpisode,
                icon: const Icon(Icons.add, size: 17),
                label: Text(tr('drama.detail.t21')),
                style: OutlinedButton.styleFrom(
                  foregroundColor: AppColors.primary,
                  padding: const EdgeInsets.symmetric(vertical: AppSpacing.md),
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: AppSpacing.md),
        ...batches.take(3).map((b) => _BatchCard(
              batch: b,
              onResume: (budget) => _resume(b['uuid'].toString(), budget),
              onControl: (status) async {
                try {
                  await _api.dio.post('/dramas/batches/${b['uuid']}/status', data: {'status': status});
                  widget.toast(status == 'paused' ? '已暂停,断点已记录' : '状态已更新');
                  widget.onChanged();
                } catch (e) {
                  widget.toast('$e', bad: true);
                }
              },
            )),
        if (_eps.isEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 60),
            child: Column(
              children: [
                Icon(Icons.video_library_outlined, size: 44,
                    color: AppColors.textTertiary.withValues(alpha: 0.5)),
                const SizedBox(height: AppSpacing.md),
                Text(tr('drama.detail.t22'),
                    style: AppTextStyles.bodyMedium.copyWith(color: AppColors.textSecondary)),
                const SizedBox(height: AppSpacing.xs),
                Text(tr('drama.detail.t23'),
                    style: AppTextStyles.labelSmall.copyWith(color: AppColors.textTertiary)),
              ],
            ),
          )
        else
          ..._eps.map((e) => _EpisodeCard(
                ep: e,
                onOpen: () async {
                  await Navigator.pushNamed(
                    context, AppRoute.dramaEpisode,
                    arguments: {
                      'dramaUuid': widget.uuid,
                      'epNo': e['epNo'],
                      'dramaTitle': (widget.drama['title'] ?? '').toString(),
                    },
                  );
                  widget.onChanged();
                },
                onPlay: () {
                  final url = e['finalUrl']?.toString() ?? '';
                  if (url.isEmpty) { widget.toast('本集还没有成片', bad: true); return; }
                  webOpenInNewTab(Uri.parse(ApiClient.resolveUrl(url)));
                },
              )),
      ],
    );
  }
}

class _BatchCard extends StatelessWidget {
  final Map<String, dynamic> batch;
  final Future<void> Function(String status) onControl;
  final Future<void> Function(int budget) onResume;
  const _BatchCard({
    required this.batch, required this.onControl, required this.onResume,
  });

  /// 暂停时问一句新预算:预算耗尽是最常见的暂停原因,
  /// 不给提额入口用户就只能回列表重新建批,断点也就白记了。
  Future<void> _askResume(BuildContext context) async {
    final policy = (batch['policy'] as Map?)?.cast<String, dynamic>() ?? const {};
    final ctrl = TextEditingController(
        text: '${(policy['budgetCredits'] as num?)?.toInt() ?? 0}');
    final yes = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppColors.surface,
        title: Text(tr('drama.detail.t24')),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              tr('drama.detail.t25', args: {
                'ep': "${batch['cursorEp']}",
                'step': "${(batch['cursorStep'] as num?)?.toInt() ?? 0}",
              }),
              style: AppTextStyles.labelSmall,
            ),
            const SizedBox(height: AppSpacing.md),
            TextField(
              controller: ctrl,
              keyboardType: TextInputType.number,
              style: AppTextStyles.bodySmall,
              decoration: InputDecoration(
                  labelText: tr('drama.detail.t26'), isDense: true),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: Text(tr('common.cancel'))),
          ElevatedButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: ElevatedButton.styleFrom(
                backgroundColor: AppColors.primary, foregroundColor: AppColors.surface),
            child: Text(tr('drama.detail.t27')),
          ),
        ],
      ),
    );
    final budget = int.tryParse(ctrl.text.trim()) ?? 0;
    ctrl.dispose();
    if (yes == true && budget > 0) await onResume(budget);
  }

  @override
  Widget build(BuildContext context) {
    final policy = (batch['policy'] as Map?)?.cast<String, dynamic>() ?? const {};
    final entries = ((batch['log'] as List?) ?? const []).whereType<Map>();
    // 心跳条目(kind=backoff)是"正在等上游"的瞬时状态,不是进度:
    // 计入条数会让「时间线 N 条」在限流期间变成噪声计数,单独取出来渲染。
    // 2026-09-15:改为**每个 ep/step 各一条**(集间流水线让上一集的视频段与
    // 下一集的步骤 0-3 同时在飞,整批共用一个槽位会互相覆盖,两个都读不成句)。
    // 视频段的那条还带 done/total —— 那是用户唯一能看到的单调递增进度,
    // 只有分钟数时他无法判断是"快完了"还是"才开头"(实测误判成卡死)。
    final real = entries.where((e) => e['kind'] != 'backoff').toList();
    final used = real.fold<int>(
        0, (s, e) => s + ((e['credits'] as num?)?.toInt() ?? 0));
    final beats = entries
        .where((e) => e['kind'] == 'backoff')
        .where((e) => (e['msg'] ?? '').toString().isNotEmpty)
        .toList();
    final budget = (policy['budgetCredits'] as num?)?.toInt() ?? 0;
    final pct = budget <= 0 ? 0.0 : (used / budget).clamp(0.0, 1.0);
    final status = (batch['status'] ?? 'queued').toString();

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
          Row(
            children: [
              Text(tr('drama.detail.t28', args: {'a': "${batch['fromEp']}", 'b': "${batch['toEp']}"}),
                  style: AppTextStyles.bodyMedium.copyWith(fontWeight: FontWeight.w700)),
              const SizedBox(width: AppSpacing.sm),
              Expanded(child: Text(status, style: AppTextStyles.labelSmall.copyWith(color: AppColors.primary), maxLines: 1, overflow: TextOverflow.ellipsis)),
              const Spacer(),
              if (status == 'running' || status == 'queued')
                InkWell(
                  onTap: () => onControl('paused'),
                  child: const Icon(Icons.pause_circle_outline, size: 19),
                ),
              if (status == 'paused')
                InkWell(
                  onTap: () => _askResume(context),
                  // AppColors.* 是 static late 非 const,不能进 const 构造(仓库已知坑 #2)
                  child: Icon(Icons.play_circle_outline, size: 19,
                      color: AppColors.primary),
                ),
              if (status == 'running' || status == 'queued' || status == 'paused')
                Padding(
                  padding: const EdgeInsets.only(left: AppSpacing.sm),
                  child: InkWell(
                    onTap: () => onControl('cancelled'),
                    child: Icon(Icons.close_rounded, size: 17,
                        color: AppColors.textTertiary),
                  ),
                ),
            ],
          ),
          const SizedBox(height: AppSpacing.sm),
          Text(tr('drama.detail.t29', args: {'ep': "${batch['cursorEp']}", 'label': "${batch['cursorStepLabel'] ?? ''}"}),
              style: AppTextStyles.labelSmall.copyWith(color: AppColors.textTertiary)),
          const SizedBox(height: AppSpacing.sm),
          ClipRRect(
            borderRadius: BorderRadius.circular(AppColors.thumbRadius),
            child: LinearProgressIndicator(
              value: pct, minHeight: 5,
              backgroundColor: AppColors.border,
              valueColor: AlwaysStoppedAnimation<Color>(
                  pct >= 1 ? AppColors.danger : AppColors.primary),
            ),
          ),
          const SizedBox(height: AppSpacing.xs),
          Text(tr('drama.detail.t30', args: {'used': '$used', 'budget': '$budget', 'n': '${real.length}'}),
              style: AppTextStyles.labelSmall.copyWith(color: AppColors.textTertiary)),
          // 上游限流退避期间步骤日志不会追加,没有这几行用户就只能对着
          // 一个不动的进度条判断"是不是卡死了"(2026-09-15 实测误判)。
          // 多条是因为两集可能在同时等不同的上游(视频限流 / 图像 503)。
          if ((status == 'running' || status == 'queued') && beats.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: AppSpacing.sm),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  for (final b in beats) _buildBeatRow(b),
                ],
              ),
            ),
        ],
      ),
    );
  }

  /// 一条"正在等待"心跳。带 done/total 的(视频段)额外画一根细进度条 ——
  /// 分子每涨一格都是真实产出,这是用户判断"还要多久"的唯一依据。
  Widget _buildBeatRow(Map b) {
    final msg = (b['msg'] ?? '').toString();
    final ep = (b['ep'] as num?)?.toInt();
    final done = (b['done'] as num?)?.toInt();
    final total = (b['total'] as num?)?.toInt();
    final hasProgress = done != null && total != null && total > 0;
    final shotPct =
        hasProgress ? (done / total).clamp(0.0, 1.0).toDouble() : 0.0;

    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.xs),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: AppSpacing.xxs, right: AppSpacing.sm),
            child: SizedBox(
              width: AppSpacing.md, height: AppSpacing.md,
              child: CircularProgressIndicator(
                strokeWidth: 1.6, color: AppColors.warning,
              ),
            ),
          ),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(ep != null ? 'EP$ep · $msg' : msg,
                    style: AppTextStyles.labelSmall
                        .copyWith(color: AppColors.warning),
                    maxLines: 2, overflow: TextOverflow.ellipsis),
                if (hasProgress) ...[
                  const SizedBox(height: AppSpacing.xs),
                  ClipRRect(
                    borderRadius: BorderRadius.circular(AppColors.thumbRadius),
                    child: LinearProgressIndicator(
                      value: shotPct, minHeight: 3,
                      backgroundColor: AppColors.border,
                      // AppColors.* 是 static late 非 const,不能进 const 构造(仓库已知坑 #2)
                      valueColor: AlwaysStoppedAnimation<Color>(AppColors.warning),
                    ),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _EpisodeCard extends StatelessWidget {
  final Map<String, dynamic> ep;
  final VoidCallback onPlay;
  final VoidCallback onOpen;
  const _EpisodeCard({required this.ep, required this.onPlay, required this.onOpen});

  Color get _statusColor {
    switch ((ep['status'] ?? 'pending').toString()) {
      case 'done': return AppColors.success;
      case 'failed': return AppColors.danger;
      case 'degraded': return AppColors.warning;
      case 'pending': return AppColors.textTertiary;
      default: return AppColors.primary;
    }
  }

  @override
  Widget build(BuildContext context) {
    final used = ((ep['usedAssets'] as List?) ?? const []).whereType<Map>().toList();
    final newIds = ((ep['newAssets'] as List?) ?? const []).length;
    final hasFinal = (ep['finalUrl'] ?? '').toString().isNotEmpty;

    return Container(
      margin: const EdgeInsets.only(bottom: AppSpacing.md),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(AppColors.cardRadius),
        border: Border.all(color: AppColors.border.withValues(alpha: 0.6)),
      ),
      child: InkWell(
        onTap: onOpen,
        borderRadius: BorderRadius.circular(AppColors.cardRadius),
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.md),
          child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm, vertical: AppSpacing.xs),
                decoration: BoxDecoration(
                  color: _statusColor.withValues(alpha: 0.13),
                  borderRadius: BorderRadius.circular(AppColors.tagRadius),
                ),
                child: Text('EP${ep['epNo']}', style: AppTextStyles.labelSmall.copyWith(
                    color: _statusColor, fontWeight: FontWeight.w700)),
              ),
              const SizedBox(width: AppSpacing.sm),
              Expanded(
                child: Text('${ep['title'] ?? ''}',
                    maxLines: 1, overflow: TextOverflow.ellipsis,
                    style: AppTextStyles.bodyMedium.copyWith(fontWeight: FontWeight.w600)),
              ),
              if (hasFinal)
                InkWell(
                  onTap: onPlay,
                  child: Icon(Icons.play_circle_outline, size: 20, color: AppColors.primary),
                ),
              const SizedBox(width: AppSpacing.xs),
              Icon(Icons.chevron_right, size: 17, color: AppColors.textTertiary),
            ],
          ),
          const SizedBox(height: AppSpacing.xs),
          Text(tr('drama.detail.auto_004', args: {'ep': "${ep['stepLabel'] ?? ''}", 'n': "${((ep['step'] as num?)?.toInt() ?? 0) + 1}", 'shot': (ep['shotCount'] != null ? tr('drama.shot_count_suffix', args: {'n': "${ep['shotCount']}"}) : ''), 'ep_2': ep['durationSec'] != null ? ' · ${(ep['durationSec'] as num).toInt() ~/ 60}:${((ep['durationSec'] as num).toInt() % 60).toString().padLeft(2, '0')}' : '', 'credits': ((ep['credits'] as num?)?.toInt() != null && (ep['credits'] as num).toInt() > 0 ? tr('drama.credit_suffix', args: {'n': "${ep['credits']}"}) : '')}),
              style: AppTextStyles.labelSmall.copyWith(color: AppColors.textTertiary)),
          if ((ep['hookIn'] ?? '').toString().isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: AppSpacing.sm),
              child: Text(tr('drama.detail.t31', args: {'hook': "${ep['hookIn']}"}),
                  style: AppTextStyles.labelSmall.copyWith(color: AppColors.textSecondary)),
            ),
          if ((ep['hookOut'] ?? '').toString().isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: AppSpacing.xxs),
              child: Text(tr('drama.detail.t32', args: {'hook': "${ep['hookOut']}"}),
                  style: AppTextStyles.labelSmall.copyWith(color: AppColors.warning)),
            ),
          if (used.isNotEmpty) ...[
            const SizedBox(height: AppSpacing.sm),
            Wrap(
              spacing: 5, runSpacing: 5,
              children: [
                ...used.take(6).map((u) => Container(
                      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm, vertical: AppSpacing.xxs),
                      decoration: BoxDecoration(
                        color: AppColors.background,
                        borderRadius: BorderRadius.circular(AppColors.tagRadius),
                      ),
                      child: Text(
                        '${u['name'] ?? u['slug'] ?? ''}'
                        '${(u['variant'] ?? '').toString().isEmpty ? '' : '·${u['variant']}'}',
                        style: AppTextStyles.labelSmall.copyWith(fontSize: 10),
                      ),
                    )),
                if (newIds > 0)
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm, vertical: AppSpacing.xxs),
                    decoration: BoxDecoration(
                      color: AppColors.warning.withValues(alpha: 0.14),
                      borderRadius: BorderRadius.circular(AppColors.tagRadius),
                    ),
                    child: Text(tr('drama.detail.t33', args: {'n': '$newIds'}), style: AppTextStyles.labelSmall.copyWith(
                        fontSize: 10, color: AppColors.warning, fontWeight: FontWeight.w600)),
                  ),
              ],
            ),
          ],
          if ((ep['error'] ?? '').toString().isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: AppSpacing.sm),
              child: Text('${ep['error']}',
                  maxLines: 3, overflow: TextOverflow.ellipsis,
                  style: AppTextStyles.labelSmall.copyWith(color: AppColors.danger)),
            ),
        ],
          ),
        ),
      ),
    );
  }
}
