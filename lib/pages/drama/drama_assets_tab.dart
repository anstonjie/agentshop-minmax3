// ============================================================================
// DramaAssetsTab —— 剧集资产库(角色 / 场景 / 道具一等公民)
// ----------------------------------------------------------------------------
// 后端:GET/POST/PATCH/DELETE /api/dramas/:uuid/assets[...]
// 交互要点:
//   · 卡片直接暴露「待确认」「EPn 新增」「已锁定」「风格已变需重制」四种状态
//   · 详情抽屉里能改锚定描述、切 canonical 视图、加变体、锁定、查引用、停用
//   · 有引用的资产后端会拒绝删除(409),前端原样把原因显示出来
//   · 2026-09-15:定妆入口从「只有抽屉里那颗按钮」升级为两处 ——
//     顶部横幅「一键定妆剩余 N 项」(跑批 + 进度 + 失败原因可看),
//     以及未定妆卡片上的单颗「定妆」。背景:此前用户从工作台点「去资产库生成
//     定妆图」跳过来,看到的只有卡片网格,找不到任何生成按钮,于是整剧带着
//     空参考图进生产 → 关键帧退化成纯文生图、主角跨镜换脸。
// ============================================================================

import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';

import '../../services/api_client.dart';
import '../../theme/app_colors.dart';
import '../../theme/app_text_styles.dart';
import '../../widgets/optimized_network_image.dart';
import '../../theme/app_dimens.dart';
import '../../utils/poll_timer.dart';
import '../../utils/app_toast.dart';
import '../../i18n/i18n.dart';

class DramaAssetsTab extends StatefulWidget {
  final String uuid;
  const DramaAssetsTab({super.key, required this.uuid});

  @override
  State<DramaAssetsTab> createState() => _DramaAssetsTabState();
}

class _DramaAssetsTabState extends State<DramaAssetsTab> {
  final ApiClient _api = ApiClient();
  final _search = TextEditingController();

  List<Map<String, dynamic>> _assets = [];
  bool _loading = true;
  String? _error;
  String? _kind; // null = 全部
  /// 2026-09-16:各分类计数(chip badge)。之前 chip 切换既不重新请求也不过滤,
  /// 用户点"角色"看到什么全凭运气;有计数后空类别直接灰显"本书未涉及"。
  Map<String, int> _counts = {};

  static const _kinds = <String, String>{
    'character': '角色',
    'location': '场景',
    'prop': '道具',
    'vehicle': '载具',
    'wardrobe': '服装',
  };

  // ── 批量定妆(2026-09-15)──────────────────────────────────────────────
  // 跑批状态来自 GET /dramas/:uuid/assets/portrait-batch,后端每个状态迁移都落库,
  // 所以刷新页面 / 换端都能接着看到 x/N,而不是只剩一个转圈。
  Map<String, dynamic> _batch = const {'status': 'idle'};
  bool _batchBusy = false;
  /// 正在单颗定妆的资产 id(卡片上的「定妆」按钮各自转圈,不互相干扰)
  final Set<String> _portraitBusy = {};
  Timer? _poll;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  @override
  void dispose() {
    _poll?.cancel();
    _search.dispose();
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
      final resp = await _api.dio.get('/dramas/${widget.uuid}/assets', queryParameters: {
        if (_kind != null) 'kind': _kind,
        if (_search.text.trim().isNotEmpty) 'q': _search.text.trim(),
      });
      final data = _unwrap(resp);
      setState(() {
        _assets = (data is List ? data : const [])
            .whereType<Map>()
            .map((e) => Map<String, dynamic>.from(e))
            .toList();
        _loading = false;
      });
    } catch (e) {
      setState(() {
        _error = e is DioException ? ApiClient.describeError(e) : e.toString();
        _loading = false;
      });
    }
    _loadBatch();
    _loadCounts();
  }

  /// 拉各分类计数(chip badge)。失败静默 —— badge 是装饰,不该把整页变错误页。
  Future<void> _loadCounts() async {
    try {
      final r = _unwrap(
          await _api.dio.get('/dramas/${widget.uuid}/assets/kind-counts'));
      if (!mounted) return;
      setState(() {
        _counts = r is Map
            ? r.map((k, v) => MapEntry(k.toString(), int.tryParse('$v') ?? 0))
            : <String, int>{};
      });
    } catch (_) {
      if (!mounted) return;
      // 拿不到计数就退化成无 badge 的旧样子,不影响筛选本身
    }
  }

  // ── 批量定妆 ────────────────────────────────────────────────────────────

  /// 资产是否已定妆(refs 里有落地图或远端图,且没被标死)。
  /// 判据与后端 portrait-batch.service.assetHasPortrait、工作台 _hasRefImage
  /// 逐字对齐 —— 三处不一致就会出现「前端说没定妆、后端说不用跑」的死按钮。
  static bool _hasPortrait(Map<String, dynamic> a) {
    final refs = a['refs'];
    if (refs is! List) return false;
    for (final r in refs.whereType<Map>()) {
      final url = (r['url'] ?? '').toString();
      final remote = (r['remoteUrl'] ?? '').toString();
      if ((url.isNotEmpty || remote.isNotEmpty) && r['alive'] != false) {
        return true;
      }
    }
    return false;
  }

  /// 待定妆 = 非软删且没有可用参考图
  List<Map<String, dynamic>> get _undressed => _assets
      .where((a) => a['status']?.toString() != 'deprecated')
      .where((a) => !_hasPortrait(a))
      .toList();

  bool get _batchRunning => _batch['status'] == 'running';

  int _batchInt(String key) {
    final v = _batch[key];
    return v is num ? v.toInt() : (int.tryParse('$v') ?? 0);
  }

  /// 拉批次状态。失败静默 —— 横幅退化成手动逐颗定妆,不该把整页变成错误页。
  Future<void> _loadBatch() async {
    final wasRunning = _batchRunning;
    try {
      final r = _unwrap(
          await _api.dio.get('/dramas/${widget.uuid}/assets/portrait-batch'));
      if (!mounted) return;
      setState(() => _batch = r is Map ? Map<String, dynamic>.from(r) : const {'status': 'idle'});
    } catch (_) {
      if (!mounted) return;
      setState(() => _batch = const {'status': 'idle'});
    }
    _syncPolling();
    // 跑批刚结束:刷一次列表,新出的定妆图要立刻看得见(用户验收口径)
    if (wasRunning && !_batchRunning) _load();
  }

  /// running 就 3s 轮一次,终态就停 —— 轮询不停是今天门③ producing 那类假活的成因
  void _syncPolling() {
    if (_batchRunning) {
      // 2026-09-20:改用 PollTimer —— 退后台/切标签页时暂停 tick,回前台补一次;底层仍是 Timer.periodic,取消写法不变。
      _poll ??= PollTimer(const Duration(seconds: 3), (_) => _loadBatch());
    } else {
      _poll?.cancel();
      _poll = null;
    }
  }

  /// 一键定妆:POST 立即返回,图在后台逐张落,进度靠轮询
  Future<void> _startBatch() async {
    setState(() => _batchBusy = true);
    try {
      final r = _unwrap(await _api.dio
          .post('/dramas/${widget.uuid}/assets/portrait-batch'));
      if (!mounted) return;
      final data = r is Map ? Map<String, dynamic>.from(r) : const <String, dynamic>{};
      final state = data['state'];
      setState(() {
        _batchBusy = false;
        if (state is Map) _batch = Map<String, dynamic>.from(state);
      });
      _syncPolling();
      final total = _batchInt('total');
      AppToast.success(context, total == 0
            ? tr('drama.assets.auto_001')
            : tr('drama.assets.auto_002', args: {'total': '$total'}));
      if (total > 0) _loadBatch();
    } catch (e) {
      if (mounted) setState(() => _batchBusy = false);
      AppToast.error(context, tr('drama.assets_tab.t01', args: {'err': '${e is DioException ? ApiClient.describeError(e) : e}'}));
    }
  }

  /// 单颗定妆(卡片上的按钮,不用开抽屉)
  Future<void> _portraitOne(Map<String, dynamic> a) async {
    final id = '${a['id']}';
    final name = '${a['name'] ?? ''}';
    // 2026-09-16(批4):QC suspect 的资产点「定妆」= force 整套重画 —— 增量复用
    //   会原样保留同一张坏图,按钮等于空转(坏图重生成入口,七问题之问题4)。
    final refs = (a['refs'] as List?) ?? const [];
    final suspect = refs.whereType<Map>().any(
        (r) => (r['qc'] is Map) && (r['qc'] as Map)['ok'] == false);
    setState(() => _portraitBusy.add(id));
    try {
      await _api.dio.post(
        '/dramas/${widget.uuid}/assets/$id/portrait',
        data: {'force': suspect},
        options: Options(receiveTimeout: const Duration(minutes: 15)),
      );
      if (!mounted) return;
      AppToast.success(context, tr('drama.assets_tab.t02', args: {'name': name}));
    } catch (e) {
      // 失败原因必须读得到(上游 503 / 落地失败 / 已锁定),不能只给"操作失败"
      if (!mounted) return;
      AppToast.error(context, tr('drama.assets_tab.t03', args: {'name': name, 'err': '${e is DioException ? ApiClient.describeError(e) : e}'}));
    } finally {
      if (mounted) setState(() => _portraitBusy.remove(id));
      await _load();
    }
  }

  Future<void> _act(String label, Future<Response> Function() fn) async {
    try {
      await fn();
      await _load();
      if (!mounted) return;
      AppToast.success(context, tr('drama.assets_tab.t04', args: {'label': label}));
    } catch (e) {
      // 失败原因必须可读到(例如"有引用不能删"),不能只给一个"操作失败"
      if (!mounted) return;
      AppToast.error(context, tr('drama.assets_tab.t05', args: {'label': label, 'err': '${e is DioException ? ApiClient.describeError(e) : e}'}));
    }
  }

  void _openAssetSheet(Map<String, dynamic> a) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.background,
      shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(AppColors.cardRadius))),
      builder: (_) => _AssetSheet(uuid: widget.uuid, asset: a, onChanged: _load),
    );
  }

  void _openCreateDialog() {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.background,
      shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(AppColors.cardRadius))),
      builder: (_) => _AssetCreateSheet(uuid: widget.uuid, onCreated: _load),
    );
  }

  /// 批量定妆横幅。两种形态:
  ///   · 跑批中 —— 进度条 + 当前项 + 已完成/失败计数,失败原因直接摊开
  ///   · 空闲且还有待定妆 —— 一颗「一键定妆剩余 N 项」主按钮
  /// 全部定妆完且没在跑批时整条隐藏,不给已完成的项目留噪音。
  Widget _portraitBanner() {
    final running = _batchRunning;
    final undressed = _undressed.length;
    if (!running && undressed == 0) return const SizedBox.shrink();

    final items =
        (_batch['items'] as List?)?.whereType<Map>().toList() ?? const [];
    final total = _batchInt('total');
    final done = _batchInt('done');
    final failed = items.where((i) => i['state'] == 'failed').toList();
    final skipped = items.where((i) => i['state'] == 'skipped').toList();
    final current = items.firstWhere(
      (i) => i['state'] == 'running',
      orElse: () => const {},
    );
    final settled =
        total > 0 ? ((done + failed.length + skipped.length) / total) : 0.0;
    final accent = running ? AppColors.primary : AppColors.warning;

    return Container(
      margin: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.xs, AppSpacing.md, AppSpacing.sm),
      padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.md, AppSpacing.md, AppSpacing.md),
      decoration: BoxDecoration(
        color: accent.withValues(alpha: 0.07),
        borderRadius: BorderRadius.circular(AppColors.cardRadius),
        border: Border.all(color: accent.withValues(alpha: 0.35)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(running ? Icons.auto_awesome : Icons.warning_amber_rounded,
                  size: 18, color: accent),
              const SizedBox(width: AppSpacing.sm),
              Expanded(
                child: Text(
                  running ? tr('drama.assets.auto_003', args: {'done': '$done', 'total': '$total'}) : tr('drama.assets.auto_004', args: {'undressed': '$undressed'}),
                  style: AppTextStyles.bodyMedium
                      .copyWith(color: accent, fontWeight: FontWeight.w800),
                ),
              ),
              if (running)
                Text('${(settled * 100).clamp(0, 100).toStringAsFixed(0)}%',
                    style: AppTextStyles.labelSmall
                        .copyWith(color: AppColors.textTertiary)),
            ],
          ),
          if (running) ...[
            const SizedBox(height: AppSpacing.sm),
            ClipRRect(
              borderRadius: BorderRadius.circular(AppColors.thumbRadius),
              child: LinearProgressIndicator(
                value: total > 0 ? settled : null,
                minHeight: 6,
                backgroundColor: AppColors.border.withValues(alpha: 0.4),
                color: AppColors.primary,
              ),
            ),
            const SizedBox(height: AppSpacing.sm),
            Text(
              current.isEmpty
                  ? tr('drama.assets.auto_005')
                  : tr('drama.assets.auto_006', args: {'current': "${current['name'] ?? ''}"}),
              style: AppTextStyles.labelSmall
                  .copyWith(color: AppColors.textSecondary, height: 1.5),
            ),
          ] else ...[
            const SizedBox(height: AppSpacing.sm),
            Text(
              tr('drama.assets.auto_007'),
              style: AppTextStyles.bodySmall
                  .copyWith(color: AppColors.textSecondary, height: 1.55),
            ),
            const SizedBox(height: AppSpacing.md),
            Row(
              children: [
                FilledButton.icon(
                  onPressed: _batchBusy ? null : _startBatch,
                  icon: _batchBusy
                      ? const SizedBox(
                          width: AppSpacing.lg, height: AppSpacing.lg,
                          child: CircularProgressIndicator(
                              strokeWidth: 2, color: Colors.white))
                      : const Icon(Icons.auto_awesome, size: 16),
                  label: Text(
                      _batchBusy ? tr('drama.assets.auto_008') : tr('drama.assets.auto_009', args: {'undressed': '$undressed'})),
                  style: FilledButton.styleFrom(
                    backgroundColor: AppColors.primary,
                    foregroundColor: Colors.white,
                    padding:
                        const EdgeInsets.symmetric(horizontal: AppSpacing.lg, vertical: AppSpacing.md),
                  ),
                ),
                const SizedBox(width: AppSpacing.md),
                Expanded(
                  child: Text(tr('drama.assets_tab.t06'),
                      style: AppTextStyles.labelSmall
                          .copyWith(color: AppColors.textTertiary)),
                ),
              ],
            ),
          ],
          if (failed.isNotEmpty) ...[
            const SizedBox(height: AppSpacing.sm),
            for (final f in failed.take(4))
              Padding(
                padding: const EdgeInsets.only(bottom: AppSpacing.xxs),
                child: Text(
                  tr('drama.assets.auto_010', args: {'f': "${f['name'] ?? ''}", 'error': "${f['error'] ?? tr('novel_drama.unknown_reason')}"}),
                  style: AppTextStyles.labelSmall
                      .copyWith(color: AppColors.danger, height: 1.5),
                ),
              ),
            if (!running)
              Text(tr('drama.assets_tab.t07'),
                  style: AppTextStyles.labelSmall
                      .copyWith(color: AppColors.textTertiary)),
          ],
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        // 筛选 + 搜索 + 新增
        Padding(
          padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.md, AppSpacing.md, AppSpacing.sm),
          child: Column(
            children: [
              Row(
                children: [
                  Expanded(
                    child: SizedBox(
                      height: AppSpacing.jumbo,
                      child: TextField(
                        controller: _search,
                        style: AppTextStyles.bodySmall,
                        decoration: InputDecoration(
                          hintText: tr('drama.assets_tab.t08'),
                          hintStyle: AppTextStyles.labelSmall.copyWith(color: AppColors.textTertiary),
                          prefixIcon: const Icon(Icons.search, size: 17),
                          isDense: true,
                          contentPadding: const EdgeInsets.symmetric(vertical: AppSpacing.sm),
                          border: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(AppColors.buttonRadius),
                            borderSide: BorderSide(color: AppColors.border),
                          ),
                        ),
                        onSubmitted: (_) => _load(),
                      ),
                    ),
                  ),
                  const SizedBox(width: AppSpacing.sm),
                  IconButton.filled(
                    onPressed: _openCreateDialog,
                    style: IconButton.styleFrom(backgroundColor: AppColors.primary),
                    icon: const Icon(Icons.add, color: Colors.white, size: 20),
                    tooltip: tr('drama.assets_tab.t09'),
                  ),
                ],
              ),
              const SizedBox(height: AppSpacing.sm),
              SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: Row(
                  children: [
                    // 2026-09-16:chip 切换必须重新请求 —— 旧实现只 setState 不 _load,
                    // 分类视图显示什么全取决于"上一次 _load 带的 kind",用户看到
                    // "全部有货、其他全空"的错乱现象(七问题之问题5)。
                    _chip(label: tr('common.all'), on: _kind == null,
                        onTap: () { setState(() => _kind = null); _load(); }),
                    ..._kinds.entries.map((e) {
                      final n = _counts[e.key];
                      return _chip(
                        label: n == null ? e.value : '${e.value} $n',
                        on: _kind == e.key,
                        muted: n == 0,
                        tooltip: n == 0 ? tr('drama.assets.auto_011') : null,
                        onTap: () { setState(() => _kind = e.key); _load(); },
                      );
                    }),
                  ],
                ),
              ),
            ],
          ),
        ),
        _portraitBanner(),
        Expanded(
          child: _loading
              ? const Center(child: CircularProgressIndicator())
              : _error != null
                  ? Center(
                      child: Padding(
                        padding: const EdgeInsets.all(AppSpacing.xxl),
                        child: Text(_error!, textAlign: TextAlign.center,
                            style: AppTextStyles.bodySmall.copyWith(color: AppColors.danger)),
                      ),
                    )
                  : _assets.isEmpty
                      ? _buildEmpty()
                      : RefreshIndicator(
                          onRefresh: _load,
                          child: GridView.builder(
                            padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.xs, AppSpacing.md, 90),
                            gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                              crossAxisCount: 2,
                              childAspectRatio: 0.78,
                              crossAxisSpacing: 10,
                              mainAxisSpacing: 10,
                            ),
                            itemCount: _assets.length,
                            itemBuilder: (_, i) => _AssetCard(
                              asset: _assets[i],
                              kinds: _kinds,
                              dressed: _hasPortrait(_assets[i]),
                              portraitBusy: _portraitBusy.contains('${_assets[i]['id']}'),
                              onPortrait: () => _portraitOne(_assets[i]),
                              onTap: () => _openAssetSheet(_assets[i]),
                              onLock: () => _act(
                                _assets[i]['locked'] == true ? '解锁' : '锁定',
                                () => _api.dio.post(
                                  '/dramas/${widget.uuid}/assets/${_assets[i]['id']}/lock',
                                  data: {'locked': _assets[i]['locked'] != true},
                                ),
                              ),
                            ),
                          ),
                        ),
        ),
      ],
    );
  }

  Widget _buildEmpty() {
    return ListView(
      children: [
        const SizedBox(height: 110),
        Icon(Icons.inventory_2_rounded, size: 48,
            color: AppColors.textTertiary.withValues(alpha: 0.5)),
        const SizedBox(height: AppSpacing.md),
        Center(
          child: Text(
              _kind == null
                  ? tr('drama.assets.auto_012')
                  : ((_counts[_kind] ?? 1) == 0 ? tr('drama.assets.auto_013') : tr('drama.assets.auto_014')),
              style: AppTextStyles.bodyMedium.copyWith(color: AppColors.textSecondary)),
        ),
        const SizedBox(height: AppSpacing.sm),
        Center(
          child: Text(tr('drama.assets.auto_015'),
              textAlign: TextAlign.center,
              style: AppTextStyles.labelSmall.copyWith(color: AppColors.textTertiary)),
        ),
      ],
    );
  }

  Widget _chip({
    required String label,
    required bool on,
    required VoidCallback onTap,
    bool muted = false,
    String? tooltip,
  }) {
    final chip = Padding(
      padding: const EdgeInsets.only(right: AppSpacing.sm),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(AppColors.cardRadius),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md, vertical: AppSpacing.sm),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(AppColors.cardRadius),
            color: on ? AppColors.primary : AppColors.surface,
            border: Border.all(color: on ? AppColors.primary : AppColors.border),
          ),
          child: Text(label,
              style: AppTextStyles.labelSmall.copyWith(
                  color: on
                      ? Colors.white
                      : (muted ? AppColors.textTertiary : AppColors.textSecondary))),
        ),
      ),
    );
    return tooltip == null ? chip : Tooltip(message: tooltip, child: chip);
  }
}

class _AssetCard extends StatelessWidget {
  final Map<String, dynamic> asset;
  final Map<String, String> kinds;
  final VoidCallback onTap;
  final VoidCallback onLock;
  /// 是否已有可用定妆图 —— 决定卡片上要不要出现「定妆」按钮
  final bool dressed;
  final bool portraitBusy;
  final VoidCallback onPortrait;
  const _AssetCard({
    required this.asset, required this.kinds, required this.onTap, required this.onLock,
    this.dressed = true, this.portraitBusy = false, this.onPortrait = _noop,
  });

  static void _noop() {}

  @override
  Widget build(BuildContext context) {
    final refs = (asset['refs'] as List?)?.cast<Map>() ?? const [];
    final canonical = asset['canonicalRef'];
    final url = canonical is Map ? canonical['url']?.toString() : null;
    final hasAlive = url != null && url.isNotEmpty;
    final locked = asset['locked'] == true;
    final pending = (asset['status'] ?? '') == 'pending';
    final kindLabel = kinds[asset['kind']] ?? (asset['kind'] ?? '').toString();
    final variants = (asset['variants'] as List?)?.length ?? 0;
    // 2026-09-16(批4):视觉质检结果露出 —— suspect = 自动重画 ≤2 次后仍有硬伤,
    //   原因直接写卡上;点「定妆」即 force 重画(坏图重生成入口)。
    Map<String, dynamic>? qc;
    for (final r in refs.whereType<Map>()) {
      final q = r['qc'];
      if (q is Map) { qc = Map<String, dynamic>.from(q); break; }
    }
    final qcBad = qc != null && qc['ok'] == false;

    return Material(
      color: AppColors.surface,
      borderRadius: BorderRadius.circular(AppColors.cardRadius),
      child: InkWell(
        borderRadius: BorderRadius.circular(AppColors.cardRadius),
        onTap: onTap,
        child: Container(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(AppColors.cardRadius),
            border: Border.all(
              color: pending ? AppColors.warning.withValues(alpha: 0.6) : AppColors.border.withValues(alpha: 0.6),
            ),
          ),
          padding: const EdgeInsets.all(AppSpacing.sm),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(AppColors.thumbRadius),
                  child: SizedBox(
                    width: double.infinity,
                    child: hasAlive
                        ? OptimizedNetworkImage(
                            url: ApiClient.resolveUrl(url), fit: BoxFit.cover, cacheWidth: 320)
                        : Container(
                            color: AppColors.background,
                            child: Center(
                              child: Column(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  Icon(refs.isEmpty ? Icons.add_a_photo_outlined : Icons.broken_image_rounded,
                                      size: 22, color: AppColors.textTertiary),
                                  const SizedBox(height: AppSpacing.xs),
                                  Text(refs.isEmpty ? tr('drama.assets.auto_016') : tr('drama.assets.auto_017'),
                                      style: AppTextStyles.labelSmall.copyWith(
                                          fontSize: 10, color: AppColors.textTertiary)),
                                ],
                              ),
                            ),
                          ),
                  ),
                ),
              ),
              const SizedBox(height: AppSpacing.sm),
              Row(
                children: [
                  Expanded(
                    child: Text('${asset['name'] ?? ''}',
                        maxLines: 1, overflow: TextOverflow.ellipsis,
                        style: AppTextStyles.bodySmall.copyWith(fontWeight: FontWeight.w700, fontSize: 13)),
                  ),
                  InkWell(onTap: onLock, child: Icon(
                      locked ? Icons.lock_rounded : Icons.lock_open_rounded,
                      size: 15, color: locked ? AppColors.success : AppColors.textTertiary)),
                ],
              ),
              Text('$kindLabel · ${asset['slug'] ?? ''}',
                  maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: AppTextStyles.labelSmall.copyWith(fontSize: 10, color: AppColors.textTertiary)),
              if (qcBad)
                Container(
                  margin: const EdgeInsets.only(top: AppSpacing.xs),
                  padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm, vertical: AppSpacing.xxs),
                  decoration: BoxDecoration(
                    color: AppColors.danger.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(AppColors.tagRadius),
                  ),
                  child: Text(
                      tr('drama.assets.auto_018', args: {'issues': ((qc['issues'] as List?) ?? const []).join('; ')}),
                      maxLines: 2, overflow: TextOverflow.ellipsis,
                      style: AppTextStyles.labelSmall.copyWith(
                          fontSize: 10, color: AppColors.danger)),
                ),
              const SizedBox(height: AppSpacing.xs),
              Row(
                children: [
                  // 标签组整体吃掉剩余宽度;原来是「裸标签 + Spacer」,
                  // 三个标签同时出现时在窄屏会撑破卡片。
                  Expanded(
                    child: Row(
                      children: [
                        if (pending)
                          Flexible(child: _badge('待确认', AppColors.warning)),
                        if (asset['sourceEp'] != null && (asset['source'] ?? '') == 'ep_new')
                          Flexible(child: _badge('EP${asset['sourceEp']} 新增', AppColors.accent)),
                        if (variants > 0)
                          Flexible(child: _badge('$variants 变体', AppColors.textTertiary)),
                      ],
                    ),
                  ),
                  Text(tr('drama.assets_tab.t10', args: {'n': "${(asset['useCount'] as num?)?.toInt() ?? 0}"}),
                      maxLines: 1, overflow: TextOverflow.ellipsis,
                      style: AppTextStyles.labelSmall.copyWith(
                          fontSize: 10, color: AppColors.textSecondary)),
                ],
              ),
              // 未定妆 → 卡片上直接给一颗按钮。以前只有详情抽屉最底部那一颗,
              // 用户从工作台「去资产库生成定妆图」跳过来根本找不到入口。
              if (!dressed) ...[
                const SizedBox(height: AppSpacing.sm),
                SizedBox(
                  height: AppSpacing.xxxl,
                  width: double.infinity,
                  child: FilledButton.icon(
                    onPressed: portraitBusy ? null : onPortrait,
                    icon: portraitBusy
                        ? const SizedBox(
                            width: AppSpacing.md, height: AppSpacing.md,
                            child: CircularProgressIndicator(
                                strokeWidth: 2, color: Colors.white))
                        : const Icon(Icons.auto_awesome, size: 13),
                    label: Text(portraitBusy ? tr('drama.assets.auto_019') : tr('drama.assets.auto_020'),
                        style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w700)),
                    style: FilledButton.styleFrom(
                      backgroundColor: AppColors.warning.withValues(alpha: 0.9),
                      foregroundColor: Colors.white,
                      padding: const EdgeInsets.symmetric(vertical: AppSpacing.xxs),
                      shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(AppColors.slotRadius)),
                    ),
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Widget _badge(String t, Color color) {
    return Padding(
      padding: const EdgeInsets.only(right: AppSpacing.xs),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.xs, vertical: AppSpacing.xxs),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.12),
          borderRadius: BorderRadius.circular(AppColors.tagRadius),
        ),
        child: Text(t,
            maxLines: 1, overflow: TextOverflow.ellipsis,
            style: AppTextStyles.labelSmall.copyWith(
                fontSize: 10, color: color, fontWeight: FontWeight.w600)),
      ),
    );
  }
}

class _AssetSheet extends StatefulWidget {
  final String uuid;
  final Map<String, dynamic> asset;
  final VoidCallback onChanged;
  const _AssetSheet({required this.uuid, required this.asset, required this.onChanged});

  @override
  State<_AssetSheet> createState() => _AssetSheetState();
}

class _AssetSheetState extends State<_AssetSheet> {
  final ApiClient _api = ApiClient();
  late final TextEditingController _desc;
  late final TextEditingController _variant;
  List<Map<String, dynamic>> _usage = [];
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _desc = TextEditingController(text: (widget.asset['descVisual'] ?? '').toString());
    _variant = TextEditingController();
    WidgetsBinding.instance.addPostFrameCallback((_) => _loadUsage());
  }

  @override
  void dispose() {
    _desc.dispose(); _variant.dispose();
    super.dispose();
  }

  dynamic _unwrap(Response r) {
    final d = r.data;
    if (d is Map && d.containsKey('data')) return d['data'];
    return d;
  }

  Future<void> _loadUsage() async {
    try {
      final resp = await _api.dio.get('/dramas/${widget.uuid}/assets/${widget.asset['id']}/usage');
      final data = _unwrap(resp);
      if (mounted && data is List) {
        setState(() => _usage = data.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList());
      }
    } catch (_) {/* 引用查不到不影响主用途,静默 */}
  }

  Future<void> _run(String label, Future<void> Function() fn) async {
    setState(() => _busy = true);
    try {
      await fn();
      if (!mounted) return;
      AppToast.success(context, tr('drama.assets_tab.t11', args: {'label': label}));
      widget.onChanged();
      if (mounted) Navigator.pop(context);
    } catch (e) {
      if (!mounted) return;
      AppToast.error(context, tr('drama.assets_tab.t12', args: {'label': label, 'err': '${e is DioException ? ApiClient.describeError(e) : e}'}));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _portrait(bool force) async {
    await _api.dio.post(
      '/dramas/${widget.uuid}/assets/${widget.asset['id']}/portrait',
      data: {'force': force},
      options: Options(receiveTimeout: const Duration(minutes: 15)),
    );
  }

  /// 整套重画会重新生成全部视图(含已经成功的),要如实告诉用户这会重烧配额
  Future<void> _confirmFullRepaint() async {
    final n = ((widget.asset['refs'] as List?)?.length) ?? 0;
    final yes = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppColors.surface,
        title: Text(tr('drama.assets_tab.t13')),
        content: Text(tr('drama.assets_tab.t14', args: {'n': '$n'})),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: Text(tr('common.cancel'))),
          ElevatedButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: ElevatedButton.styleFrom(
                backgroundColor: AppColors.danger, foregroundColor: Colors.white),
            child: Text(tr('drama.assets_tab.t15')),
          ),
        ],
      ),
    );
    if (yes != true || !mounted) return;
    await _run('已整套重画', () => _portrait(true));
  }

  @override
  Widget build(BuildContext context) {
    final a = widget.asset;
    final refs = (a['refs'] as List?)?.cast<Map>() ?? const [];
    final variants = (a['variants'] as List?)?.cast<Map>() ?? const [];
    final locked = a['locked'] == true;

    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: SizedBox(
        height: MediaQuery.of(context).size.height * 0.82,
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(AppSpacing.lg, AppSpacing.lg, AppSpacing.sm, AppSpacing.sm),
              child: Row(
                children: [
                  Expanded(
                    child: Text('${a['name'] ?? ''}',
                        style: AppTextStyles.titleMedium.copyWith(fontWeight: FontWeight.w700)),
                  ),
                  Text('${a['slug'] ?? ''}',
                      style: AppTextStyles.labelSmall.copyWith(color: AppColors.textTertiary)),
                  IconButton(tooltip: tr('common.close'), onPressed: () => Navigator.pop(context), icon: const Icon(Icons.close)),
                ],
              ),
            ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(AppSpacing.lg, 0, AppSpacing.lg, AppSpacing.xl),
                children: [
                  if (refs.isNotEmpty) ...[
                    Text(tr('drama.assets_tab.t16', args: {'n': '${refs.length}'}), style: AppTextStyles.labelSmall.copyWith(
                        color: AppColors.textSecondary, fontWeight: FontWeight.w600)),
                    const SizedBox(height: AppSpacing.sm),
                    SizedBox(
                      height: 148,
                      child: ListView.separated(
                        scrollDirection: Axis.horizontal,
                        itemCount: refs.length,
                        separatorBuilder: (_, __) => const SizedBox(width: AppSpacing.sm),
                        itemBuilder: (_, i) {
                          final r = refs[i];
                          final isCanon = r['canonical'] == true;
                          return SizedBox(
                            width: 108,
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                InkWell(
                                  onTap: locked || isCanon
                                      ? null
                                      : () => _run('已设为 canonical', () async {
                                            await _api.dio.post(
                                              '/dramas/${widget.uuid}/assets/${a['id']}/canonical',
                                              data: {'angle': r['angle']},
                                            );
                                          }),
                                  child: ClipRRect(
                                    borderRadius: BorderRadius.circular(AppColors.thumbRadius),
                                    child: SizedBox(
                                      height: 118, width: 108,
                                      child: (r['url']?.toString().isNotEmpty ?? false)
                                          ? OptimizedNetworkImage(
                                              url: ApiClient.resolveUrl(r['url'].toString()),
                                              fit: BoxFit.cover, cacheWidth: 260)
                                          : Container(
                                              color: AppColors.surface,
                                              child: Center(
                                                child: Icon(Icons.broken_image_rounded,
                                                    size: 20, color: AppColors.danger),
                                              ),
                                            ),
                                    ),
                                  ),
                                ),
                                const SizedBox(height: AppSpacing.xs),
                                Text(isCanon ? tr('drama.assets.auto_021', args: {'r': "${r['angle']}"}) : '${r['angle']}',
                                    maxLines: 1, overflow: TextOverflow.ellipsis,
                                    style: AppTextStyles.labelSmall.copyWith(
                                        fontSize: 10,
                                        color: isCanon ? AppColors.primary : AppColors.textTertiary)),
                              ],
                            ),
                          );
                        },
                      ),
                    ),
                    const SizedBox(height: AppSpacing.sm),
                    Text(tr('drama.assets_tab.t17'),
                        style: AppTextStyles.labelSmall.copyWith(
                             color: AppColors.textTertiary)),
                  ],
                  const SizedBox(height: AppSpacing.lg),
                  Text(tr('drama.assets_tab.t18'),
                      style: AppTextStyles.labelSmall.copyWith(
                          color: AppColors.textSecondary, fontWeight: FontWeight.w600)),
                  const SizedBox(height: AppSpacing.xs),
                  TextField(
                    controller: _desc,
                    maxLines: 3,
                    style: AppTextStyles.bodySmall,
                    decoration: InputDecoration(
                      isDense: true,
                      contentPadding: const EdgeInsets.all(AppSpacing.md),
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(AppColors.buttonRadius),
                        borderSide: BorderSide(color: AppColors.border),
                      ),
                    ),
                  ),
                  if ((a['descPersona'] ?? '').toString().isNotEmpty) ...[
                    const SizedBox(height: AppSpacing.md),
                    Text(tr('drama.assets_tab.t19'), style: AppTextStyles.labelSmall.copyWith(
                        color: AppColors.textSecondary, fontWeight: FontWeight.w600)),
                    Text('${a['descPersona']}', style: AppTextStyles.bodySmall),
                  ],
                  const SizedBox(height: AppSpacing.md),
                  Row(
                    children: [
                      Flexible(child: Text(tr('drama.assets_tab.t20'), style: AppTextStyles.labelSmall.copyWith(color: AppColors.textTertiary), maxLines: 1, overflow: TextOverflow.ellipsis)),
                      Flexible(child: Text('${a['source'] ?? ''}', style: AppTextStyles.labelSmall, maxLines: 1, overflow: TextOverflow.ellipsis)),
                      if (a['sourceEp'] != null) ...[
                        Text(' · EP${a['sourceEp']}', style: AppTextStyles.labelSmall),
                      ],
                      Flexible(child: Text(tr('drama.assets_tab.t21', args: {'n': "${a['useCount'] ?? 0}"}), style: AppTextStyles.labelSmall, maxLines: 1, overflow: TextOverflow.ellipsis)),
                    ],
                  ),
                  if ((a['aliases'] as List?)?.isNotEmpty ?? false) ...[
                    const SizedBox(height: AppSpacing.sm),
                    Text(tr('drama.assets_tab.t22', args: {'names': (a['aliases'] as List).join(' / ')}),
                        style: AppTextStyles.labelSmall.copyWith(color: AppColors.textTertiary)),
                  ],
                  if (variants.isNotEmpty) ...[
                    const SizedBox(height: AppSpacing.md),
                    Text(tr('drama.assets_tab.t23', args: {'n': '${variants.length}'}), style: AppTextStyles.labelSmall.copyWith(
                        color: AppColors.textSecondary, fontWeight: FontWeight.w600)),
                    ...variants.map((v) => Padding(
                          padding: const EdgeInsets.only(top: AppSpacing.xs),
                          child: Text('· ${v['label']}'
                              '${(v['descDelta'] ?? '').toString().isEmpty ? '' : ' — ${v['descDelta']}'}'
                              '${v['fromEp'] != null ? ' (EP${v['fromEp']})' : ''}',
                              style: AppTextStyles.bodySmall),
                        )),
                  ],
                  if (_usage.isNotEmpty) ...[
                    const SizedBox(height: AppSpacing.md),
                    Text(tr('drama.assets_tab.t24'), style: AppTextStyles.labelSmall.copyWith(
                        color: AppColors.textSecondary, fontWeight: FontWeight.w600)),
                    ..._usage.map((u) => Padding(
                          padding: const EdgeInsets.only(top: AppSpacing.xs),
                          child: Text(
                              tr('drama.assets.auto_022', args: {'u': "${u['epNo']}", 'u_2': "${u['title'] ?? ''}", 'shots': ((u['shotIdxs'] as List?)?.isNotEmpty ?? false ? tr('drama.shots_suffix', args: {'list': (u['shotIdxs'] as List).join(',')}) : ''), 'variant': ((u['variant'] ?? '').toString().isEmpty ? '' : tr('drama.variant_suffix', args: {'variant': "${u['variant']}"}))}),
                              style: AppTextStyles.bodySmall),
                        )),
                  ],
                  const SizedBox(height: AppSpacing.lg),
                  // 定妆:角色四视图 / 场景道具单图。逐资产单独触发,
                  // 一是避免整剧一把梭把请求吊在 HTTP 里十几分钟,
                  // 二是单个失败不该拖垮其余资产。
                  // 后端默认增量(只补缺口/失败角度),整套重画要显式 force。
                  ElevatedButton.icon(
                    onPressed: _busy ? null : () => _run(
                      refs.isEmpty ? '定妆图已生成' : '已补齐缺失视图',
                      () => _portrait(false),
                    ),
                    icon: _busy
                        ? const SizedBox(width: AppSpacing.lg, height: AppSpacing.lg,
                            child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                        : const Icon(Icons.auto_awesome, size: 16),
                    label: Text(refs.isEmpty ? tr('drama.assets.auto_023') : tr('drama.assets.auto_024')),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: AppColors.primary,
                      foregroundColor: AppColors.surface,
                      padding: const EdgeInsets.symmetric(vertical: AppSpacing.md),
                    ),
                  ),
                  if (refs.isNotEmpty) ...[
                    const SizedBox(height: AppSpacing.sm),
                    TextButton.icon(
                      onPressed: _busy ? null : _confirmFullRepaint,
                      icon: const Icon(Icons.refresh_rounded, size: 15),
                      label: Text(tr('drama.assets_tab.t25', args: {'n': '${refs.length}'}),
                          style: AppTextStyles.bodySmall.copyWith(
                               color: AppColors.textSecondary)),
                    ),
                  ],
                  if (a['locked'] == true)
                    Padding(
                      padding: const EdgeInsets.only(top: AppSpacing.xxs),
                      child: Text(tr('drama.assets_tab.t26'),
                          style: AppTextStyles.labelSmall.copyWith(color: AppColors.warning)),
                    ),
                  const SizedBox(height: AppSpacing.sm),
                  OutlinedButton.icon(
                    onPressed: _busy ? null : () {
                      setState(() => _variant.clear());
                      showDialog<String>(
                        context: context,
                        builder: (ctx) => AlertDialog(
                          backgroundColor: AppColors.surface,
                          title: Text(tr('drama.assets_tab.t27')),
                          content: TextField(
                            controller: _variant,
                            autofocus: true,
                            style: AppTextStyles.bodySmall,
                            decoration: InputDecoration(hintText: tr('drama.assets_tab.t28')),
                          ),
                          actions: [
                            TextButton(onPressed: () => Navigator.pop(ctx), child: Text(tr('common.cancel'))),
                            ElevatedButton(
                              onPressed: () => Navigator.pop(ctx, _variant.text.trim()),
                              child: Text(tr('common.ok')),
                            ),
                          ],
                        ),
                      ).then((label) {
                        if (label == null || label.isEmpty) return;
                        _run('变体已添加', () async {
                          await _api.dio.post(
                            '/dramas/${widget.uuid}/assets/${a['id']}/variants',
                            data: {'label': label},
                          );
                        });
                      });
                    },
                    icon: const Icon(Icons.style_outlined, size: 16),
                    label: Text(tr('drama.assets_tab.t29')),
                    style: OutlinedButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: AppSpacing.md)),
                  ),
                  const SizedBox(height: AppSpacing.sm),
                  Row(
                    children: [
                      Expanded(
                        child: OutlinedButton.icon(
                          onPressed: _busy ? null : () => _run(
                            locked ? '已解锁' : '已锁定',
                            () async {
                              await _api.dio.post(
                                '/dramas/${widget.uuid}/assets/${a['id']}/lock',
                                data: {'locked': !locked},
                              );
                            },
                          ),
                          icon: Icon(locked ? Icons.lock_open : Icons.lock_outline, size: 16),
                          label: Text(locked ? tr('drama.assets.auto_025') : tr('drama.assets.auto_026')),
                          style: OutlinedButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: AppSpacing.md)),
                        ),
                      ),
                      const SizedBox(width: AppSpacing.sm),
                      Expanded(
                        child: OutlinedButton.icon(
                          onPressed: _busy || (a['status'] ?? '') != 'pending'
                              ? null
                              : () => _run('已确认入库', () async {
                                    await _api.dio.post(
                                        '/dramas/${widget.uuid}/assets/${a['id']}/confirm');
                                  }),
                          icon: const Icon(Icons.check_circle_outline, size: 16),
                          label: Text(tr('drama.assets_tab.t30')),
                          style: OutlinedButton.styleFrom(
                            foregroundColor: AppColors.success,
                            padding: const EdgeInsets.symmetric(vertical: AppSpacing.md),
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: AppSpacing.sm),
                  Row(
                    children: [
                      Expanded(
                        child: ElevatedButton.icon(
                          onPressed: _busy ? null : () => _run('描述已保存', () async {
                            await _api.dio.patch('/dramas/${widget.uuid}/assets/${a['id']}',
                                data: {'descVisual': _desc.text.trim()});
                          }),
                          icon: const Icon(Icons.save_outlined, size: 16),
                          label: Text(tr('common.save')),
                          style: ElevatedButton.styleFrom(
                            backgroundColor: AppColors.primary, foregroundColor: AppColors.surface,
                            padding: const EdgeInsets.symmetric(vertical: AppSpacing.md),
                          ),
                        ),
                      ),
                      const SizedBox(width: AppSpacing.sm),
                      IconButton.outlined(
                        onPressed: _busy ? null : () => _run('已停用', () async {
                          await _api.dio.delete('/dramas/${widget.uuid}/assets/${a['id']}');
                        }),
                        icon: Icon(Icons.delete_outline, color: AppColors.danger),
                        tooltip: tr('drama.assets_tab.t31'),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 手工新增资产:上传/文字定妆之前的兜底入口,
/// 也让用户能把外部画好的角色图直接当资产用。
class _AssetCreateSheet extends StatefulWidget {
  final String uuid;
  final VoidCallback onCreated;
  const _AssetCreateSheet({required this.uuid, required this.onCreated});

  @override
  State<_AssetCreateSheet> createState() => _AssetCreateSheetState();
}

class _AssetCreateSheetState extends State<_AssetCreateSheet> {
  final ApiClient _api = ApiClient();
  final _name = TextEditingController();
  final _slug = TextEditingController();
  final _desc = TextEditingController();
  final _persona = TextEditingController();
  String _kind = 'character';
  bool _busy = false;

  static const _kinds = {'character': '角色', 'location': '场景', 'prop': '道具'};

  @override
  void dispose() {
    _name.dispose(); _slug.dispose(); _desc.dispose(); _persona.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_name.text.trim().isEmpty || _desc.text.trim().isEmpty) {
      AppToast.error(context, tr('drama.assets_tab.t32'));
      return;
    }
    setState(() => _busy = true);
    try {
      await _api.dio.post('/dramas/${widget.uuid}/assets', data: {
        'kind': _kind,
        'name': _name.text.trim(),
        if (_slug.text.trim().isNotEmpty) 'slug': _slug.text.trim(),
        'descVisual': _desc.text.trim(),
        'descPersona': _persona.text.trim(),
        'source': 'manual',
      });
      if (mounted) Navigator.pop(context);
      widget.onCreated();
      if (!mounted) return;
      AppToast.success(context, tr('drama.assets_tab.t33'));
    } catch (e) {
      if (!mounted) return;
      AppToast.error(context, tr('drama.assets_tab.t34', args: {'err': '${e is DioException ? ApiClient.describeError(e) : e}'}));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(AppSpacing.lg, AppSpacing.lg, AppSpacing.lg, AppSpacing.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Expanded(child: Text(tr('drama.assets_tab.t35'),
                    style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16))),
                IconButton(tooltip: tr('common.close'), onPressed: () => Navigator.pop(context), icon: const Icon(Icons.close)),
              ],
            ),
            Wrap(
              spacing: 8,
              children: _kinds.entries.map((e) => ChoiceChip(
                label: Text(e.value),
                selected: _kind == e.key,
                showCheckmark: false,
                labelStyle: AppTextStyles.labelSmall.copyWith(
                    color: _kind == e.key ? Colors.white : AppColors.textSecondary),
                backgroundColor: AppColors.surface,
                selectedColor: AppColors.primary,
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppColors.slotRadius)),
                onSelected: (_) => setState(() => _kind = e.key),
              )).toList(),
            ),
            const SizedBox(height: AppSpacing.md),
            _f(_name, '名称,如 林越'),
            _f(_slug, 'slug(英文标识,可留空自动生成),如 char_linyue'),
            _f(_desc, '锚定描述:外貌/服装/材质/光线 —— 决定跨集像不像', maxLines: 3),
            _f(_persona, '人设 / 用途(可选)', maxLines: 2),
            const SizedBox(height: AppSpacing.md),
            ElevatedButton(
              onPressed: _busy ? null : _submit,
              style: ElevatedButton.styleFrom(
                backgroundColor: AppColors.primary, foregroundColor: AppColors.surface,
                padding: const EdgeInsets.symmetric(vertical: AppSpacing.md),
              ),
              child: _busy
                  ? const SizedBox(width: AppSpacing.lg, height: AppSpacing.lg,
                      child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                  : Text(tr('drama.assets_tab.t36')),
            ),
          ],
        ),
      ),
    );
  }

  Widget _f(TextEditingController c, String hint, {int maxLines = 1}) => Padding(
        padding: const EdgeInsets.only(bottom: AppSpacing.sm),
        child: TextField(
          controller: c,
          maxLines: maxLines,
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
        ),
      );
}
