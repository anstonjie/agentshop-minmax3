// ============================================================================
// NovelDramaWorkbenchPage —— 全新短视频一键生成 工作台(Novel2Drama)
// ----------------------------------------------------------------------------
// 双入口(最终方案 v6.0 §1:两路汇合于对齐引擎):
//   入口 A「AI 生成小说」:标题 → POST /api/dramas/novel-gen/start
//     → 轮询 GET /api/dramas/novel-gen/tasks/:uuid(五级瀑布 L1-L5 逐章推进)
//     → 完成后自动 建剧 + ingest(source='generated')进对齐链路
//   入口 B「我有小说」:粘贴/上传 .txt → 建剧 + ingest(source='uploaded')
//
// 汇合后的共用链路:
//   POST /api/dramas                          建剧 { agentId, title }
//   POST /api/dramas/:uuid/novel/ingest       入库+建账本+建三道门
//   GET  /api/dramas/:uuid/novel/ledger       读账本(含 gates)
//   POST /api/dramas/:uuid/novel/gates/:gate/decide  审批门决策
//   POST /api/dramas/:uuid/novel/gates/:gate/retry   重拉设定/剧本/生产阶段
//
// 门状态机:waiting → passed/rejected(不通过不烧钱)
//   gate1_budget 报价门 | gate2_design 设定门 | gate3_script 剧本门
//
// 2026-09-14(Stage 2 接线):门决策驱动后端 NovelPipelineService 流水线 ——
//   ①过 → 自动生成角色/场景/画风设定(产物进 gate2.payload,本页轮询展示)
//   ②过 → 自动逐集生成承接大纲(剧本)
//   ③过 → 自动入队连集批次(分镜/关键帧/视频/成片),进度看
//         GET /api/dramas/batches/:uuid,精细管理走剧集详情页。
//   payload 状态机:{} → generating → ready/failed;③过成功后 producing。
// ============================================================================

import 'dart:async';
import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';

import '../main.dart' show AppRoute;
import '../services/api_client.dart';
import '../theme/app_colors.dart';
import '../widgets/workbench_icons.dart';
import '../theme/app_text_styles.dart';
import '../utils/web_file_picker.dart';
import '../utils/web_download.dart';
import '../widgets/agent_cost_banner.dart';
import '../widgets/workbench_form.dart';
import '../theme/app_dimens.dart';
import '../utils/poll_timer.dart';
import '../utils/app_toast.dart';
import '../i18n/i18n.dart';

class NovelDramaWorkbenchPage extends StatefulWidget {
  /// 发起新生成 / 新建剧时用得到;按 dramaUuid 恢复旧项目时可以为 0。
  final int agentId;
  final String? agentName;

  /// 非空 = 一进页面直接恢复到这部剧的账本视图(报价门 / 三道门 / 生产进度)。
  /// 2026-09-15:此前本页所有进度态都是纯内存字段,离开页面即全丢,
  /// 而 gates / batches 的续跑接口早就有 —— 缺的只是把 dramaUuid 交回前端。
  final String? dramaUuid;

  const NovelDramaWorkbenchPage({
    super.key,
    this.agentId = 0,
    this.agentName,
    this.dramaUuid,
  });

  @override
  State<NovelDramaWorkbenchPage> createState() =>
      _NovelDramaWorkbenchPageState();
}

class _NovelDramaWorkbenchPageState extends State<NovelDramaWorkbenchPage>
    with SingleTickerProviderStateMixin {
  final ApiClient _api = ApiClient();

  late final TabController _tabs;
  final _genTitleCtrl = TextEditingController();
  final _titleCtrl = TextEditingController();
  final _novelCtrl = TextEditingController();
  String _epTarget = '120';
  String _tier = 'demo'; // demo 2万 / novella 20万 / full 80万
  String _genGenre = '';

  // 生成任务态(入口 A)
  Map<String, dynamic>? _genTask;
  Timer? _pollTimer;
  bool _genStarting = false;

  // 账本态(两入口汇合)
  bool _submitting = false;
  bool _deciding = false;
  bool _ingesting = false;
  Map<String, dynamic>? _ledger;
  String? _dramaUuid;
  String? _error;

  // 断点续跑态(2026-09-15):进页面时从 GET /dramas/novel/active 认领的现场
  List<Map<String, dynamic>> _activeProjects = [];
  bool _restoring = true;

  /// 失败/中断的小说生成任务。进页面**不自动显示**(否则一进来就糊一张
  /// 「生成失败」红卡,用户还没操作就被甩一脸错误),只列进「未完成的项目」
  /// 成可点行;用户点哪条才把哪条设成 _genTask 显示失败卡 + 「从断点重试」。
  List<Map<String, dynamic>> _pausedGenTasks = [];

  // Stage 2 流水线态(2026-09-14):设定/剧本生成与连集生产进度轮询
  Timer? _stageTimer;
  Map<String, dynamic>? _batch; // /dramas/batches/:uuid 最新一次响应
  int _idlePolls = 0; // payload 迟迟未落 generating 的容错轮询计数

  // 工作台就地控制(2026-09-15):以前「暂停/取消/看成片/删项目」只能跳去
  // 剧集详情页或剧集列表页做,而工作台正是用户盯着进度的那一屏 —— 想暂停
  // 得先离开正在看的进度。这里把最常用的四个动作拉回来。
  bool _playing = false; // 拉剧集列表找成片 URL 的过程中
  bool _projectBusy = false; // 暂停/取消/删除这类会改状态的操作

  // 门② 定妆情况(2026-09-14):资产 `refs` 里没有可用图 = 还没定妆。
  // 没定妆就放行进剧本 → 每集关键帧全部 degraded(退化纯文生图),主角跨镜换脸。
  List<Map<String, dynamic>> _assets = [];
  bool _assetsLoaded = false;
  bool _assetsLoading = false;

  // 批量定妆(2026-09-15):门②通过后后端自动开跑,这里只负责把进度如实显示出来。
  // 状态源 GET /dramas/:uuid/assets/portrait-batch,后端每迁移一次就落库一次,
  // 所以刷新页面、换端、从资产库回来都能看到同一个 x/N,不会只剩一个转圈。
  Map<String, dynamic> _portrait = const {'status': 'idle'};
  bool _wasPortraitRunning = false;
  /// 一次性自重排(不用 Timer.periodic):跑批到终态后自然就不再排下一次
  Timer? _portraitTimer;

  // 连集分集与分镜可视化(2026-09-20 优化):
  // 让用户在主工作台就能看清每集的分镜、台词、关键帧、缺镜情况,并直接行内微调重烧字幕或补做缺镜。
  List<Map<String, dynamic>> _episodes = [];
  bool _episodesLoading = false;
  bool _episodesExpanded = true;
  int? _supplementingEp;
  int? _reburningEp;
  int? _expandedEpNo;

  // 分集时长计划(GET /dramas/:uuid/novel/plan):后端按原著逐集折算的内容估时,
  // 报价门里据此罗列"能出几集 / 每集大概多长"。拿不到不影响其余渲染。
  Map<String, dynamic>? _plan;

  @override
  void initState() {
    super.initState();
    _tabs = TabController(length: 2, vsync: this);
    _tabs.addListener(() {
      // 切 Tab 清错误,保留各自表单与进行中状态
      if (!_tabs.indexIsChanging) setState(() => _error = null);
    });
    // 2026-09-15:进页面先认领现场。以前这里什么都没有 —— 所有进度态是纯内存字段,
    // 离开页面或刷新浏览器就回到空白表单,而库里正有任务在跑、项目正卡在门上。
    WidgetsBinding.instance.addPostFrameCallback((_) => _restore());
  }

  /// 恢复现场:① 入参带 dramaUuid → 直接打开那部剧的账本;
  /// ② 否则拉未完成清单,进行中的小说生成任务直接接管轮询,项目列成可点卡片。
  ///
  /// 任何失败都只记日志不拦人 —— 恢复不出来也得让人能正常新建,
  /// 所以 finally 里一定把 _restoring 关掉。
  Future<void> _restore() async {
    final seed = widget.dramaUuid;
    try {
      if (seed != null && seed.isNotEmpty) {
        _dramaUuid = seed;
        await _refreshLedger();
        if (_ledger == null) {
          _dramaUuid = null; // 账本不存在/不属于我 → 回空白表单
        } else {
          // 恢复出来若正停在「设定生成中 / 剧本生成中 / 连集生产中」,
          // 不开轮询就会看着一个不动的进度条 —— 与 _openProject 同一套收尾。
          _syncStagePolling();
        }
        return;
      }
      final r = _unwrap(await _api.dio
          .get('/dramas/novel/active', options: _fresh));
      if (r is! Map) return;
      _activeProjects = ((r['projects'] as List?) ?? const [])
          .whereType<Map>()
          .map((e) => Map<String, dynamic>.from(e))
          .toList();
      final tasks = ((r['genTasks'] as List?) ?? const [])
          .whereType<Map>()
          .map((e) => Map<String, dynamic>.from(e))
          .toList();
      if (tasks.isEmpty) return;
      // 2026-09-15:进页面**只接管正在跑的**任务(开轮询看实时进度)。
      //   失败/中断的任务不再自动认领 —— 旧逻辑 `running.isNotEmpty ? … : tasks.first`
      //   会在没有 running 时把最近一个 failed 任务直接设成 _genTask,导致用户一进
      //   页面就看到一张「生成失败 99%」红卡(实测投诉:还没做任何操作就被甩错误)。
      //   现在它们进 _pausedGenTasks,列在「未完成的项目」里等用户点。
      final running = tasks.where((t) => t['status'] == 'running').toList();
      _pausedGenTasks =
          tasks.where((t) => t['status'] != 'running').toList();
      if (running.isNotEmpty) {
        _genTask = running.first;
        _startPolling();
      }
    } catch (_) {
      // 静默:恢复失败退回空白表单,不影响新建
    } finally {
      if (mounted) setState(() => _restoring = false);
    }
  }

  /// 打开某个未完成项目(清单 / 书架「继续做剧」共用)
  Future<void> _openProject(String dramaUuid) async {
    if (dramaUuid.isEmpty) return;
    _pollTimer?.cancel();
    _stageTimer?.cancel();
    setState(() {
      _dramaUuid = dramaUuid;
      _ledger = null;
      _batch = null;
      _genTask = null;
      _error = null;
      _assets = [];
      _assetsLoaded = false;
      _episodes = [];
      _expandedEpNo = null;
      _resetPortraitView();
    });
    await _refreshLedger();
    if (!mounted) return;
    if (_ledger == null) {
      setState(() => _dramaUuid = null);
      _toast(tr('novel_drama.toast_no_ledger'), error: true);
      return;
    }
    _syncStagePolling();
  }

  /// 只刷「未完成的项目」清单(不动当前打开的剧)。
  ///
  /// 回到起点后要调一次:不然刚选择「保留」的项目得等下次进页面才出现在清单里,
  /// 用户会以为它被顺手删了。
  Future<void> _refreshActiveProjects() async {
    try {
      final r = _unwrap(
          await _api.dio.get('/dramas/novel/active', options: _fresh));
      if (r is! Map) return;
      final list = ((r['projects'] as List?) ?? const [])
          .whereType<Map>()
          .map((e) => Map<String, dynamic>.from(e))
          .toList();
      if (mounted) setState(() => _activeProjects = list);
    } catch (_) {
      // 静默:清单拉不到不影响新建
    }
  }

  /// 清掉批量定妆态(换剧 / 回到起点共用)。轮询不停就会拿着上一部剧的进度
  /// 继续往新剧的卡片上写 —— 与今天门③ producing 假活是同一类事故。
  void _resetPortraitView() {
    _portraitTimer?.cancel();
    _portraitTimer = null;
    _portrait = const {'status': 'idle'};
    _wasPortraitRunning = false;
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    _stageTimer?.cancel();
    _portraitTimer?.cancel();
    _tabs.dispose();
    _genTitleCtrl.dispose();
    _titleCtrl.dispose();
    _novelCtrl.dispose();
    super.dispose();
  }

  dynamic _unwrap(Response r) {
    final d = r.data;
    if (d is Map && d.containsKey('data')) return d['data'];
    return d;
  }

  /// 轮询 / 写后回读专用:绕开 ApiClient 的 GET 15s 响应缓存 + in-flight 去重。
  ///
  /// ⚠ 不加这个会踩「点两下才生效」:
  /// 账本每 4s 轮询一次 GET,响应被 ApiClient 缓存 15s;
  /// 用户点「确认设定,生成剧本」→ POST 成功 → 紧接着 `_refreshLedger()`
  /// 命中 15 秒前的旧缓存 → 旧账本(gate 仍 waiting)盖回内存 →
  /// UI 退化回「待确认」+ 按钮还在,看起来像没点;
  /// 等到缓存过期(15s)后再点一次,才看到真实状态。
  /// 进度轮询同理会被缓存拖慢最多 ~20s。
  Options get _fresh =>
      Options(extra: {'cache': false, 'dedup': false});

  String _errMsg(dynamic e) =>
      e is DioException ? ApiClient.describeError(e) : e.toString();

  // ── 入口 A:标题 → 生成小说 → 自动 ingest ────────────────────────────
  Future<void> _startGen() async {
    final title = _genTitleCtrl.text.trim();
    if (title.length < 2) {
      _toast(tr('novel_drama.toast_title_too_short'), error: true);
      return;
    }
    setState(() { _genStarting = true; _error = null; });
    try {
      final r = _unwrap(await _api.dio.post('/dramas/novel-gen/start', data: {
        'agentId': widget.agentId,
        'title': title,
        'tier': _tier,
        if (_genGenre.isNotEmpty) 'genre': _genGenre,
      }));
      if (!mounted) return;
      setState(() {
        _genTask = (r is Map) ? Map<String, dynamic>.from(r) : null;
      });
      _startPolling();
      _toast(tr('novel_drama.toast_gen_started'));
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = _errMsg(e));
    } finally {
      if (mounted) setState(() => _genStarting = false);
    }
  }

  void _startPolling() {
    _pollTimer?.cancel();
    // 2026-09-20:改用 PollTimer —— 退后台/切标签页时暂停 tick,回前台补一次;底层仍是 Timer.periodic,取消写法不变。
    _pollTimer = PollTimer(const Duration(seconds: 5), (_) => _pollGen());
  }

  Future<void> _pollGen() async {
    final uuid = _genTask?['uuid']?.toString();
    if (uuid == null || uuid.isEmpty) return;
    try {
      final r = _unwrap(
          await _api.dio.get('/dramas/novel-gen/tasks/$uuid', options: _fresh));
      if (!mounted || r is! Map) return;
      final status = r['status']?.toString();
      setState(() => _genTask = Map<String, dynamic>.from(r));
      if (status == 'completed') {
        _pollTimer?.cancel();
        _toast(tr('novel_drama.toast_gen_done'));
        await _ingestGenerated(Map<String, dynamic>.from(r));
      } else if (status == 'failed') {
        _pollTimer?.cancel();
        setState(() => _error =
            tr('novel_drama.error_gen_failed', args: {'reason': '${r['error'] ?? tr('novel_drama.unknown_reason')}'}));
      }
    } catch (_) {
      // 轮询失败不打断,下个周期重试
    }
  }

  /// 小说完成 → 建剧 → ingest(source='generated' + novelGenTaskUuid,服务端按 key 读产物)
  ///
  /// ⚠ 必须防重入:_pollGen 是 Timer.periodic(5s) 且不挡重叠,两次轮询都读到
  /// status=completed 就会连发两次「建剧 + ingest」。实测代价就写在库里 ——
  /// 同名剧被重复建出 6~7 份(2026-09-14 22:51:11 同一秒 4 条)。
  Future<void> _ingestGenerated(Map<String, dynamic> task) async {
    if (_ingesting) return;
    _ingesting = true;
    try {
      final created = _unwrap(await _api.dio.post('/dramas', data: {
        'agentId': widget.agentId,
        'title': task['title'],
        'topic': 'novel-to-drama',
      }));
      final uuid = (created is Map) ? created['uuid']?.toString() : null;
      if (uuid == null) throw Exception(tr('novel_drama.build_drama_no_uuid'));
      final ingest = _unwrap(await _api.dio.post(
        '/dramas/$uuid/novel/ingest',
        data: {
          'title': task['title'],
          'source': 'generated',
          'epTargetSec': int.tryParse(_epTarget) ?? 120,
          'novelGenTaskUuid': task['uuid'],
        },
      ));
      if (!mounted) return;
      setState(() {
        _dramaUuid = uuid;
        _ledger = (ingest is Map) ? Map<String, dynamic>.from(ingest) : null;
      });
      _toast(tr('novel_drama.toast_ledger_ready'));
      // ingest 成功 → 后台 beats/重排可能正在跑(payload.repacking):开轮询,
      // 标志一清就恢复门①双钮(见 _stageActive / _buildActionsBar)。
      _syncStagePolling();
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = _errMsg(e));
    } finally {
      // 失败也必须放闸,否则一次报错就把「建剧 + ingest」永久锁死
      _ingesting = false;
    }
  }

  // ── 入口 B:粘贴/上传 → ingest ────────────────────────────────────────
  Future<void> _submit() async {
    final novel = _novelCtrl.text.trim();
    final title = _titleCtrl.text.trim();
    if (title.isEmpty) {
      _toast(tr('novel_drama.toast_need_title'), error: true);
      return;
    }
    if (novel.length < 50) {
      _toast(tr('novel_drama.toast_text_too_short'), error: true);
      return;
    }
    setState(() { _submitting = true; _error = null; });
    try {
      final created = _unwrap(await _api.dio.post('/dramas', data: {
        'agentId': widget.agentId,
        'title': title,
        'topic': 'novel-to-drama',
      }));
      final uuid = (created is Map) ? created['uuid']?.toString() : null;
      if (uuid == null || uuid.isEmpty) {
        throw Exception(tr('novel_drama.build_drama_no_uuid'));
      }
      final ledger = _unwrap(await _api.dio.post(
        '/dramas/$uuid/novel/ingest',
        data: {
          'novelText': novel,
          'title': title,
          'source': 'uploaded',
          'epTargetSec': int.tryParse(_epTarget) ?? 120,
        },
      ));
      if (!mounted) return;
      setState(() {
        _dramaUuid = uuid;
        _ledger = (ledger is Map) ? Map<String, dynamic>.from(ledger) : null;
      });
      AgentCostBanner.refreshAllFor(widget.agentId);
      _toast(tr('novel_drama.toast_ledger_ready'));
      // ingest 成功 → 后台 beats/重排可能正在跑(payload.repacking):开轮询,
      // 标志一清就恢复门①双钮(见 _stageActive / _buildActionsBar)。
      _syncStagePolling();
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = _errMsg(e));
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  // ── 门决策(共用) ─────────────────────────────────────────────────────
  Future<void> _decideGate(String gate, bool pass) async {
    if (_dramaUuid == null) return;
    setState(() => _deciding = true);
    try {
      final r = _unwrap(await _api.dio.post(
        '/dramas/$_dramaUuid/novel/gates/$gate/decide',
        data: {'decision': pass ? 'passed' : 'rejected'},
      ));
      // 写后失效:否则紧随其后的 _refreshLedger 会命中「写之前」的缓存,
      // 把刚落库的 gate 状态盖回 waiting(前端表现为"点了没反应")。
      _api.invalidate('/dramas/$_dramaUuid/novel/ledger');
      if (!mounted) return;
      setState(() {
        _ledger = (r is Map) ? Map<String, dynamic>.from(r) : _ledger;
      });
      _toast(pass ? tr('novel_drama.gate_passed') : tr('novel_drama.gate_rejected_adjust'));
    } catch (e) {
      if (!mounted) return;
      _toast(_errMsg(e), error: true);
    } finally {
      if (mounted) setState(() => _deciding = false);
    }
    await _refreshLedger();
    _syncStagePolling();
  }

  /// 重拉门②/③对应的生成阶段(失败重试;或后端升级前已过门的历史剧恢复)
  Future<void> _retryGate(String gate) async {
    if (_dramaUuid == null) return;
    setState(() => _deciding = true);
    try {
      await _api.dio.post('/dramas/$_dramaUuid/novel/gates/$gate/retry');
      _api.invalidate('/dramas/$_dramaUuid/novel/ledger');
      await _refreshLedger();
      _toast(tr('novel_drama.toast_regen_ok'));
    } catch (e) {
      if (!mounted) return;
      _toast(_errMsg(e), error: true);
    } finally {
      if (mounted) setState(() => _deciding = false);
    }
    _syncStagePolling();
  }

  /// 把「已驳回」的门改回「待确认」—— 解除驳回。
  ///
  /// 为什么必须有它(2026-09-15):后端 decideGate 对非 waiting 状态直接抛
  /// ConflictException,而全链路没有任何 un-reject 入口,于是「驳回」实际是
  /// **终态** —— 用户手滑点一次,整部剧连同账本、已生成的角色/场景资产一起废掉,
  /// 唯一出路是删掉项目从零重来。实测剧 42 停在 gate2_design=rejected,救不回来。
  /// 而"驳回"的本意只是"这次不满意,我调一下再来"。
  ///
  /// 与 [_retryGate] 正交,别混:
  ///   retry  = 门的状态不动,把**生成阶段**重跑一遍(失败重试)
  ///   reopen = 门退回 waiting,让用户可以**重新决策**(驳回后悔)
  /// 驳回后想重新生成,顺序是先 reopen 再 retry。
  Future<void> _reopenGate(String gate) async {
    if (_dramaUuid == null) return;
    setState(() => _deciding = true);
    try {
      final r = _unwrap(await _api.dio.post(
        '/dramas/$_dramaUuid/novel/gates/$gate/reopen',
        data: const <String, dynamic>{},
      ));
      // 与 _decideGate 同理:不失效缓存的话紧随的 _refreshLedger 会把
      // "写之前"的旧账本(rejected)盖回内存,界面看起来像没点。
      _api.invalidate('/dramas/$_dramaUuid/novel/ledger');
      if (!mounted) return;
      setState(() {
        _ledger = (r is Map) ? Map<String, dynamic>.from(r) : _ledger;
      });
      _toast(tr('novel_drama.toast_gate_reopened'));
    } catch (e) {
      if (!mounted) return;
      _toast(_errMsg(e), error: true);
    } finally {
      if (mounted) setState(() => _deciding = false);
    }
    await _refreshLedger();
    _syncStagePolling();
  }

  /// 当前批次号。优先用批次详情的 uuid;轮询还没回来时退回账本 payload 上的
  /// batchUuid,否则用户第一次点会误报"没找到批次号"。
  String? get _batchUuid {
    final bu = _batch?['uuid']?.toString() ??
        _gatePayload('gate3_script')?['batchUuid']?.toString();
    return (bu == null || bu.isEmpty) ? null : bu;
  }

  /// 暂停 / 取消连集批次。
  ///
  /// 后端 worker 在**每集、每一步开始前**读一次 DB 状态,所以这两个动作都是
  /// 优雅的:在跑的那一步会跑完并落库,不会留下半成品。
  ///   paused    —— 可续跑,断点就是批次自己的 cursorEp/cursorStep
  ///   cancelled —— 终态,不再续跑;已生成的集与成片都保留
  Future<void> _setBatchStatus(String status, String okMsg) async {
    final bu = _batchUuid;
    if (bu == null) {
      _toast(tr('novel_drama.toast_no_batch'), error: true);
      return;
    }
    setState(() => _projectBusy = true);
    try {
      final r = _unwrap(await _api.dio.post(
        '/dramas/batches/$bu/status',
        data: {'status': status},
        options: _fresh,
      ));
      if (r is Map) setState(() => _batch = Map<String, dynamic>.from(r));
      _toast(okMsg);
    } catch (e) {
      if (!mounted) return;
      _toast(_errMsg(e), error: true);
    } finally {
      if (mounted) setState(() => _projectBusy = false);
    }
    await _pollStage();
  }

  /// 打开成片播放(从最后一集往回找第一个已产出的 finalUrl)。
  ///
  /// 懒加载:只有用户真点了才去拉剧集列表 —— 工作台主循环本来每 4 秒轮询一次
  /// 账本,再挂一份剧集列表轮询纯属浪费。最后一集最可能是刚跑完的那一集,
  /// 所以从尾部往前找。
  Future<void> _playFinal() async {
    final uuid = _dramaUuid;
    if (uuid == null) return;
    setState(() => _playing = true);
    try {
      final r = await _api.dio.get('/dramas/$uuid/episodes', options: _fresh);
      final list = (_unwrap(r) as List?)?.whereType<Map>().toList() ?? const [];
      Map? hit;
      for (final e in list.reversed) {
        if ((e['finalUrl'] ?? '').toString().isNotEmpty) {
          hit = e;
          break;
        }
      }
      final url = (hit?['finalUrl'] ?? '').toString();
      if (url.isEmpty) {
        _toast(tr('novel_drama.toast_no_film'), error: true);
        return;
      }
      await webOpenInNewTab(Uri.parse(ApiClient.resolveUrl(url)));
      if (!mounted) return;
      _toast(tr('novel_drama.toast_opened_film', args: {'ep': '${hit?['epNo'] ?? ''}'}));
    } catch (e) {
      if (!mounted) return;
      _toast(_errMsg(e), error: true);
    } finally {
      if (mounted) setState(() => _playing = false);
    }
  }

  /// 删除整个项目(剧 + 账本 + 资产 + 已生成成片),不可恢复。
  ///
  /// 此前唯一的删除入口在剧集列表页 —— 用户在工作台发现"这部剧彻底废了"
  /// (比如门被驳回、剧本完全跑偏),却要先退出去、在列表里找到它、再删。
  /// 这里补一个就地入口,但**必须二次确认**:删除会连带 OSS 上的成片,
  /// 没有任何回收站。
  Future<void> _deleteProject() async {
    final uuid = _dramaUuid;
    if (uuid == null) return;
    final title = _ledger?['novelTitle']?.toString() ?? tr('novel_drama.fallback_this_project');
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(tr('novel_drama.delete_project')),
        content: Text(tr('novel_drama.dialog_delete_body', args: {'title': title})),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text(tr('common.cancel')),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: TextButton.styleFrom(foregroundColor: AppColors.danger),
            child: Text(tr('novel_drama.delete_forever')),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    setState(() => _projectBusy = true);
    try {
      await _api.dio.delete('/dramas/$uuid', options: _fresh);
      _api.invalidate('/dramas/novel/active');
      if (!mounted) return;
      _toast(tr('novel_drama.toast_project_deleted'));
      _backToStart();
    } catch (e) {
      if (!mounted) return;
      _toast(_errMsg(e), error: true);
    } finally {
      if (mounted) setState(() => _projectBusy = false);
    }
  }

  /// 重新拉起连集批次(与剧集详情页「续跑」同一个接口)。
  ///
  /// 批次执行者活在**后端进程内存**里:进程一重启,正在跑的那一轮就没了,
  /// 而 DB 里状态还写着 running —— 用户看到进度条一动不动。
  /// 更坑的是队列里残留的旧任务(jobId = batchUuid)会占着 active 锁最长 90 分钟,
  /// 这期间连"续跑"都会被 BullMQ 静默忽略。后端已改为 force 入队,这里直接调即可。
  Future<void> _resumeBatch() async {
    final bu = _batchUuid;
    if (bu == null) {
      _toast(tr('novel_drama.toast_no_batch_resume'), error: true);
      return;
    }
    setState(() => _deciding = true);
    try {
      final r = _unwrap(await _api.dio.post(
        '/dramas/batches/$bu/resume',
        data: const <String, dynamic>{},
        options: _fresh,
      ));
      if (r is Map && r['enqueued'] == false) {
        _toast(tr('novel_drama.toast_resume_failed', args: {'reason': '${r['reason'] ?? tr('novel_drama.queue_unavailable')}'}), error: true);
      } else {
        _toast(tr('novel_drama.toast_requeued'));
      }
      if (r is Map) setState(() => _batch = Map<String, dynamic>.from(r));
    } catch (e) {
      if (!mounted) return;
      _toast(_errMsg(e), error: true);
    } finally {
      if (mounted) setState(() => _deciding = false);
    }
    await _pollStage();
  }

  // ── 门② 定妆守门(2026-09-14) ─────────────────────────────────────────
  // 背景:门②「确认设定,生成剧本」通过后会自动连跑剧本 + 连集生产,但定妆图
  // 必须由用户在资产库逐项手动生成(设定阶段只建 pending、refs 为空的资产)。
  // 一旦没定妆就冲过去,后端 keyframe-plan 会把每一镜降级成纯文生图
  // (degraded=true),十几张图各画各的 → 主角跨镜换脸、场景漂移。
  // 所以在放行前拦一道,并把「去资产库定妆」的入口放在用户真正看得见的地方。

  /// 资产是否已有可用定妆图(refs 里有落地图或远端图,且没被标死)
  static bool _hasRefImage(Map<String, dynamic> a) {
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

  /// 「待定妆」= 非软删(deprecated)且 refs 里没有可用图的资产。
  /// 判据与后端 `refAssetIndex` 逐字对齐:alive !== false 且 url/remoteUrl 非空。
  List<Map<String, dynamic>> get _undressedAssets => _assets
      .where((a) => a['status']?.toString() != 'deprecated')
      .where((a) => !_hasRefImage(a))
      .toList();

  /// 需不需要关心定妆进度。门② 通过后更要看 —— 后端自动批量定妆正是在
  /// 「确认设定」之后才开跑的,与剧本阶段并行;只盯 waiting 就会在最关键的
  /// 那几分钟里什么进度都不显示(用户上一轮投诉的「看不到进度」)。
  bool get _portraitRelevant {
    if (_dramaUuid == null) return false;
    final g2 = _gateOf('gate2_design')?['status']?.toString();
    if (g2 == 'passed') return true;
    return g2 == 'waiting' &&
        _gatePayload('gate2_design')?['state'] == 'ready';
  }

  /// 按需拉一次资产 + 批量定妆进度(从资产库回来会重置 _assetsLoaded 再拉)
  void _maybeLoadAssets() {
    if (_portraitRelevant && !_assetsLoaded && !_assetsLoading) {
      _loadAssets();
      _loadPortrait();
    }
  }

  Future<void> _loadAssets() async {
    final uuid = _dramaUuid;
    if (uuid == null) return;
    setState(() => _assetsLoading = true);
    try {
      final r = _unwrap(
          await _api.dio.get('/dramas/$uuid/assets', options: _fresh));
      if (!mounted) return;
      setState(() {
        _assets = (r is List ? r : const [])
            .whereType<Map>()
            .map((e) => Map<String, dynamic>.from(e))
            .toList();
        _assetsLoading = false;
        _assetsLoaded = true;
      });
    } catch (_) {
      // 拉失败不锁死流程,但标记「已尝试」,避免每轮轮询都重拉;
      // 此时 _assets 为空 → 守门按"无待定妆"处理,不会误拦。
      if (mounted) {
        setState(() {
          _assetsLoading = false;
          _assetsLoaded = true;
        });
      }
    }
  }

  /// 拉批量定妆进度。running 时用**一次性 Timer 自重排**(不是 periodic):
  /// 到终态自然不再排下一次,不会留下一个永远停不下来的轮询。
  Future<void> _loadPortrait() async {
    final uuid = _dramaUuid;
    if (uuid == null) return;
    Map<String, dynamic> next = const {'status': 'idle'};
    try {
      final r = _unwrap(
          await _api.dio.get('/dramas/$uuid/assets/portrait-batch', options: _fresh));
      if (r is Map) next = Map<String, dynamic>.from(r);
    } catch (_) {
      // 拉不到就退回 idle:提示条会退化成「确认设定后自动定妆」的说明文案,
      // 不该因为一个进度接口挂掉就把整张门② 卡片变成错误态。
    }
    if (!mounted) return;
    final wasRunning = _wasPortraitRunning;
    final running = next['status'] == 'running';
    setState(() {
      _portrait = next;
      _wasPortraitRunning = running;
    });
    _portraitTimer?.cancel();
    _portraitTimer = null;
    if (running) {
      _portraitTimer = Timer(const Duration(seconds: 4), _loadPortrait);
    } else if (wasRunning) {
      // 刚跑完:重拉资产,让卡片上的「已定妆」与守门判据立刻对上
      _assetsLoaded = false;
      await _loadAssets();
    }
  }

  /// 跳资产库 Tab(0 概览 / 1 资产库 / 2 分集);回来重算定妆情况
  Future<void> _openAssetsTab() async {
    final uuid = _dramaUuid;
    if (uuid == null) return;
    await Navigator.pushNamed(context, AppRoute.dramaDetail, arguments: {
      'uuid': uuid,
      'agentName': widget.agentName,
      'initialTab': 1,
    });
    if (!mounted) return;
    _assetsLoaded = false;
    await _loadAssets();
  }

  /// 门②「确认设定,生成剧本」。
  ///
  /// 2026-09-15:以前这里会弹「先去定妆 / 仍然继续」的拦截框 —— 因为定妆只能在
  /// 资产库逐项手动点,而那颗按钮藏在卡片详情抽屉最底部,多数人找不到入口。
  /// 现在门② 通过 = 后端自动开跑批量定妆(与剧本阶段并行),拦截已无意义:
  /// 拦下来反而让用户以为还得自己去找那颗按钮。进度与失败项由门② 卡片的
  /// 提示条如实显示,想单独补某一项的人仍可从提示条上的入口进资产库。
  Future<void> _confirmGate2() async {
    await _decideGate('gate2_design', true);
  }

  /// 跳剧集详情页(分集 Tab):连集生产的精细管理(暂停/续跑/预算/单集重做)
  void _openDramaDetail() {
    if (_dramaUuid == null) return;
    Navigator.pushNamed(context, AppRoute.dramaDetail, arguments: {
      'uuid': _dramaUuid,
      'agentName': widget.agentName,
      'initialTab': 2,
    });
  }

  Future<void> _refreshLedger() async {
    if (_dramaUuid == null) return;
    try {
      final r = _unwrap(await _api.dio.get('/dramas/$_dramaUuid/novel/ledger',
          options: _fresh));
      if (mounted && r is Map) {
        setState(() => _ledger = Map<String, dynamic>.from(r));
        // 门② 出设定后,顺手把资产定妆情况拉一次(用于守门提示)
        _maybeLoadAssets();
      }
    } catch (_) {}
    // 分集时长计划:独立拉一次,失败就保留上一次(或空),不影响报价门其余渲染
    try {
      final p = _unwrap(await _api.dio.get('/dramas/$_dramaUuid/novel/plan',
          options: _fresh));
      if (mounted && p is Map) {
        setState(() => _plan = Map<String, dynamic>.from(p));
      }
    } catch (_) {}
  }

  // ── Stage 2 流水线轮询 ────────────────────────────────────────────────

  Map<String, dynamic>? _gatePayload(String gate) {
    final p = _gateOf(gate)?['payload'];
    return (p is Map) ? Map<String, dynamic>.from(p) : null;
  }

  int? _asInt(dynamic v) => v is num ? v.toInt() : int.tryParse('$v');

  /// 某条记录最后落库到现在过了多少分钟。
  ///
  /// ⚠ 只能喂**后端用 JS 写的**时间戳(payload 里的 progressAt/startedAt、
  /// 批次日志的 at)—— 它们是真 UTC。**不要喂 DB 的 updatedAt**:那些列是
  /// MySQL `NOW(3)` 写的本地时间(GMT+8),经 Prisma/JSON 出来却带 `Z`,
  /// 前端按 UTC 解析会得到"8 小时后"的时间,相减恒为负,判断全部失效。
  int? _minutesSince(dynamic iso) {
    final raw = iso?.toString();
    if (raw == null || raw.isEmpty) return null;
    final t = DateTime.tryParse(raw);
    if (t == null) return null;
    final mins = DateTime.now().difference(t.toLocal()).inMinutes;
    return mins < 0 ? null : mins; // 未来时间 = 时钟/时区有问题,宁可不显示
  }

  /// 生成态的逃生口:显示"已 N 分钟无进展"+ 重新拉起按钮。
  /// 以前这个按钮只在 payload 为空的分支里出现,一旦阶段死在中途(状态是
  /// generating 而不是 failed),用户就只能看着转圈、没有任何可点的东西。
  Widget _stageEscapeHatch(String gateKey, Map<String, dynamic>? gate) {
    // progressAt 每写完一集刷新一次,最能代表"最后有进展的时刻";
    // 老 payload 没有它时退回 startedAt(阶段启动时刻,只会更悲观,不会误报)。
    final mins = _minutesSince(gate?['progressAt'] ?? gate?['startedAt']);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (mins != null && mins >= 2) ...[
          Text(
            tr('novel_drama.auto_001', args: {'mins': '$mins'}),
            style: AppTextStyles.labelSmall.copyWith(color: AppColors.warning),
          ),
          const SizedBox(height: AppSpacing.sm),
        ],
        _GateMiniButton(
          label: tr('novel_drama.toast_unresponsive_btn'),
          icon: Icons.refresh_rounded,
          color: AppColors.textSecondary,
          busy: _deciding,
          onTap: () => _retryGate(gateKey),
        ),
      ],
    );
  }

  /// 是否有需要持续轮询的阶段(设定/剧本生成中、生产未终态、或门已过但
  /// payload 还没落 generating 的短暂空窗)
  bool get _stageActive {
    if (_ledger == null) return false;
    // 门①后台 beats/重排进行中(payload.repacking):这期间 decideGate 会被后端
    // 409 拦下,前端把双钮禁用。必须轮询刷 payload —— 否则后台清标志后按钮
    // 仍是禁用态,用户得手动刷新页面才能确认报价(2026-09-21 实测卡死事故)。
    if (_gatePayload('gate1_budget')?['repacking'] == true) return true;
    if (_gateOf('gate1_budget')?['status'] != 'passed') return false;
    final g2 = _gateOf('gate2_design')?['status']?.toString();
    final g3 = _gateOf('gate3_script')?['status']?.toString();
    final p2 = _gatePayload('gate2_design');
    final p3 = _gatePayload('gate3_script');
    if (p2?['state'] == 'generating' || p3?['state'] == 'generating') {
      return true;
    }
    if (p3?['state'] == 'producing') {
      // 批次到终态就停轮询(卡片保留终态展示)。
      // 后端在批次收尾时会把 batchStatus 写回门 payload,所以刷新页面后
      // 不必先拉一次批次详情才知道该不该继续轮询。
      final bs = _batch?['status']?.toString() ??
          p3?['batchStatus']?.toString();
      return bs == null || !['done', 'failed', 'cancelled'].contains(bs);
    }
    // 空窗容错:决策刚落地、后台还没写 payload,允许有限次轮询
    if (_idlePolls < 15) {
      if (g2 == 'waiting' && p2?['state'] == null) return true;
      if (g2 == 'passed' && g3 == 'waiting' && p3?['state'] == null) return true;
    }
    return false;
  }

  void _syncStagePolling() {
    if (!mounted) return;
    if (_stageActive) {
      if (_payloadEmpty) _idlePolls++;
      _stageTimer?.cancel();
      _stageTimer = PollTimer(const Duration(seconds: 4), (_) => _pollStage());
    } else {
      _idlePolls = 0;
      _stageTimer?.cancel();
      _stageTimer = null;
    }
  }

  bool get _payloadEmpty {
    final p2 = _gatePayload('gate2_design');
    final p3 = _gatePayload('gate3_script');
    return (p2?['state'] == null) && (p3?['state'] == null);
  }

  Future<void> _pollStage() async {
    await _refreshLedger();
    final p3 = _gatePayload('gate3_script');
    final bu = p3?['batchUuid']?.toString();
    if ((p3?['state'] == 'producing' || _batch != null) && bu != null && bu.isNotEmpty) {
      try {
        final r = _unwrap(
            await _api.dio.get('/dramas/batches/$bu', options: _fresh));
        if (mounted && r is Map) {
          setState(() => _batch = Map<String, dynamic>.from(r));
        }
      } catch (_) {}
      // 生产中顺便拉取各集分镜明细
      await _loadEpisodes();
    }
    _syncStagePolling();
  }

  // ── 上传 .txt(入口 B) ────────────────────────────────────────────────
  Future<void> _pickNovelFile() async {
    final picked = await pickKnowledgeFileViaWebInput();
    if (picked == null) return;
    final bytes = picked['bytes'] as List<int>;
    final name = picked['name']?.toString() ?? 'novel.txt';
    var text = utf8.decode(bytes, allowMalformed: true);
    if (text.startsWith('﻿')) text = text.substring(1);
    if (!mounted) return;
    setState(() {
      _novelCtrl.text = text;
      if (_titleCtrl.text.trim().isEmpty) {
        _titleCtrl.text =
            name.replaceAll(RegExp(r'\.txt$', caseSensitive: false), '');
      }
    });
    _toast(tr('novel_drama.toast_file_loaded', args: {'name': name, 'chars': '${text.length}'}));
  }

  void _toast(String msg, {bool error = false}) {
    if (!mounted) return;
    // error:true 必须走 error 样式(危险色)。以前恒走 success,409/失败提示和
    // 成功反馈同一个色,用户根本分不出好坏(2026-09-21 截图事故:后端 409 的
    // 「正在重算报价」弹成了深色"成功"条)。msg 是最终文本,raw: true 不再过 tr()。
    if (error) {
      AppToast.show(context, msg, type: AppToastType.error, raw: true);
    } else {
      AppToast.success(context, msg);
    }
  }

  // ── UI ────────────────────────────────────────────────────────────────
  @override
  Widget build(BuildContext context) {
    final hasLedger = _ledger != null;
    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        backgroundColor: AppColors.surface,
        title: Text(
          widget.agentName ?? tr('novel_drama.default_agent_name'),
          style: AppTextStyles.titleMedium,
        ),
        actions: [
          // 2026-09-14:全部小说书架入口(含历史生成,不依赖当前页状态)
          IconButton(
            tooltip: tr('mine.my_novels'),
            onPressed: () =>
                Navigator.pushNamed(context, AppRoute.novelLibrary),
            icon: const Icon(Icons.local_library_rounded),
          ),
          // 2026-09-15:账本之后的整条链路(三道门 → 连集生产)以前在全 App 内
          // 没有任何入口能回到某部剧,库里 20+ 个项目因此卡在门上打不开。
          // 这里补「我的剧集」,与「我的小说」一前一后覆盖两个阶段。
          IconButton(
            tooltip: tr('novel_drama.my_dramas'),
            onPressed: () => Navigator.pushNamed(context, AppRoute.dramaList,
                arguments: {
                  'agentId': widget.agentId,
                  'agentName': widget.agentName,
                }),
            icon: const Icon(Icons.movie_filter_rounded),
          ),
        ],
        bottom: hasLedger
            ? null
            : TabBar(
                controller: _tabs,
                labelColor: AppColors.primary,
                unselectedLabelColor: AppColors.textSecondary,
                indicatorColor: AppColors.primary,
                tabs: [
                  Tab(icon: const Icon(Icons.auto_awesome_rounded, size: 18),
                      text: tr('novel_drama.tab_ai_novel')),
                  Tab(icon: const Icon(Icons.menu_book_rounded, size: 18),
                      text: tr('novel_drama.tab_my_novel')),
                ],
              ),
      ),
      body: _restoring
          ? const Center(child: CircularProgressIndicator())
          : hasLedger
              ? _buildLedgerView()
              : Column(
                  children: [
                    const SizedBox(height: AppSpacing.md),
                    WbInfoCard(
                      icon: Icons.auto_stories_rounded,
                      text:
                          tr('novel_drama.hero_body'),
                    ),
                    const SizedBox(height: AppSpacing.sm),
                    // 2026-09-15:未完成项目清单。放在 TabBarView 之外,
                    // 两个 Tab 都能看到 —— 断点续跑不该取决于你停在哪个入口。
                    // (不能塞进 SingleChildScrollView:TabBarView 要的是有界高度)
                    _buildActiveProjectsCard(),
                    Expanded(
                      child: TabBarView(
                        controller: _tabs,
                        children: [
                          _buildGenTab(),
                          _buildUploadTab(),
                        ],
                      ),
                    ),
                  ],
                ),
    );
  }

  // ── 未完成项目清单(2026-09-15 断点续跑) ───────────────────────────────

  static const _gateNames = {
    'gate1_budget': '① 报价单',
    'gate2_design': '② 角色场景设定',
    'gate3_script': '③ 分集剧本',
  };

  String _gateNameOf(String? gate) => _gateNames[gate] ?? tr('novel_drama.gate_name_producing');

  /// 后端 listActiveProjects 的 reason → 一句人话(说清卡在哪、能干什么)
  String _reasonOf(Map<String, dynamic> p) {
    final gate = _gateNameOf(p['currentGate']?.toString());
    switch (p['reason']?.toString()) {
      case 'generating':
        return tr('novel_drama.reason_generating', args: {'gate': gate});
      case 'failed':
        return tr('novel_drama.reason_failed', args: {'gate': gate});
      case 'producing':
        final b = p['batch'];
        final cur = b is Map ? _asInt(b['cursorEp']) : null;
        final to = b is Map ? _asInt(b['toEp']) : null;
        return cur != null && to != null && to > 0
            ? tr('novel_drama.reason_producing', args: {'cur': '$cur', 'to': '$to'})
            : tr('novel_drama.reason_producing_plain');
      case 'rejected':
        // 别说"可重做":retry 只重跑生成阶段,不会把门从 rejected 拉回来
        // (后端 decideGate 对非 waiting 直接抛 Conflict)。真正要做的是
        // 「重新打开此门」,所以文案必须指那一个动作,否则用户点进去只会碰壁。
        return tr('novel_drama.reason_rejected', args: {'gate': gate});
      case 'stopped':
        return tr('novel_drama.reason_stopped');
      case 'not_started':
        return tr('novel_drama.reason_not_started');
      default:
        return p['currentGate']?.toString() == 'gate1_budget'
            ? tr('novel_drama.reason_waiting', args: {'gate': gate})
            : tr('novel_drama.reason_ready', args: {'gate': gate});
    }
  }

  Widget _buildActiveProjectsCard() {
    final currentUuid = _genTask?['uuid']?.toString();
    final paused = _pausedGenTasks
        .where((t) => t['uuid']?.toString() != currentUuid)
        .toList();
    if (_activeProjects.isEmpty && paused.isEmpty) {
      return const SizedBox.shrink();
    }
    final shown = _activeProjects.take(3).toList();
    final totalCount = _activeProjects.length + paused.length;
    return Container(
      margin: const EdgeInsets.fromLTRB(AppSpacing.lg, 0, AppSpacing.lg, AppSpacing.sm),
      padding: const EdgeInsets.fromLTRB(AppSpacing.lg, AppSpacing.lg, AppSpacing.lg, AppSpacing.sm),
      decoration: BoxDecoration(
        color: AppColors.cardBg,
        borderRadius: BorderRadius.circular(AppColors.cardRadius),
        border: Border.all(color: AppColors.primary.withValues(alpha: 0.3)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Icon(Icons.history_rounded, size: 18, color: AppColors.primary),
              const SizedBox(width: AppSpacing.sm),
              Expanded(
                child: Text(tr('novel_drama.active_projects_title', args: {'n': '$totalCount'}),
                    style: AppTextStyles.titleSmall),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.xs),
          Text(
            tr('novel_drama.active_projects_subtitle'),
            style: AppTextStyles.caption
                .copyWith(color: AppColors.textSecondary),
          ),
          const SizedBox(height: AppSpacing.sm),
          for (final p in shown) _activeProjectRow(p),
          for (final t in paused) _pausedGenRow(t),
          if (_activeProjects.length > shown.length)
            Padding(
              padding: const EdgeInsets.fromLTRB(AppSpacing.xxs, AppSpacing.xxs, 0, AppSpacing.sm),
              child: Text(
                tr('novel_drama.active_projects_more', args: {'n': '${_activeProjects.length - shown.length}'}),
                style: AppTextStyles.caption
                    .copyWith(color: AppColors.textTertiary),
              ),
            ),
        ],
      ),
    );
  }

  /// 「未完成的项目」里的失败/中断小说生成任务行。
  /// 点击才把该任务设成 _genTask(显示失败卡 + 「从断点重试」/「换个标题重来」),
  /// 进页面时不自动显示 —— 与 _restore 的「只接管 running」配套。
  Widget _pausedGenRow(Map<String, dynamic> t) {
    final title = t['title']?.toString() ?? tr('novel_drama.untitled_novel');
    final failed = t['status'] == 'failed';
    final chDone = t['chaptersDone'] ?? 0;
    final chTotal = t['chaptersTotal'] ?? 0;
    return InkWell(
      borderRadius: BorderRadius.circular(AppColors.slotRadius),
      onTap: () => setState(() => _genTask = Map<String, dynamic>.from(t)),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(AppSpacing.xxs, AppSpacing.sm, AppSpacing.xxs, AppSpacing.sm),
        child: Row(
          children: [
            Icon(
              failed ? Icons.error_outline_rounded : Icons.pause_circle_outline_rounded,
              size: 18,
              color: failed ? AppColors.danger : AppColors.textSecondary,
            ),
            const SizedBox(width: AppSpacing.sm),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AppTextStyles.bodySmall
                        .copyWith(fontWeight: FontWeight.w700),
                  ),
                  const SizedBox(height: AppSpacing.xxs),
                  Text(
                    tr('novel_drama.novel_status_line', args: {'state': failed ? tr('novel_drama.gen_failed') : tr('novel_drama.interrupted'), 'done': '$chDone', 'total': '$chTotal'}),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AppTextStyles.caption
                        .copyWith(color: AppColors.textSecondary),
                  ),
                ],
              ),
            ),
            Icon(Icons.chevron_right_rounded, color: AppColors.textTertiary),
          ],
        ),
      ),
    );
  }

  Widget _activeProjectRow(Map<String, dynamic> p) {
    final dramaUuid = p['dramaUuid']?.toString() ?? '';
    final chars = _asInt(p['totalChars']) ?? 0;
    final eps = _asInt(p['episodeCount']) ?? 0;
    return InkWell(
      borderRadius: BorderRadius.circular(AppColors.slotRadius),
      onTap: () => _openProject(dramaUuid),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(AppSpacing.xxs, AppSpacing.sm, AppSpacing.xxs, AppSpacing.sm),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    p['title']?.toString() ?? tr('novel_drama.untitled_project'),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AppTextStyles.bodySmall
                        .copyWith(fontWeight: FontWeight.w700),
                  ),
                  const SizedBox(height: AppSpacing.xs),
                  Text(
                    '${_reasonOf(p)}'
                    '${chars > 0 ? tr('novel_drama.project_meta_chars', args: {'n': '$chars'}) : ''}'
                    '${eps > 0 ? tr('novel_drama.project_meta_eps', args: {'n': '$eps'}) : ''}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AppTextStyles.caption
                        .copyWith(color: AppColors.textTertiary),
                  ),
                ],
              ),
            ),
            const SizedBox(width: AppSpacing.sm),
            Text(tr('novel_drama.continue_btn'),
                style: AppTextStyles.caption.copyWith(
                    color: AppColors.primary, fontWeight: FontWeight.w800)),
            const SizedBox(width: AppSpacing.xxs),
            Icon(Icons.arrow_forward_ios,
                size: 10, color: AppColors.primary),
          ],
        ),
      ),
    );
  }

  // ── 入口 A:AI 生成小说 Tab ────────────────────────────────────────────
  Widget _buildGenTab() {
    final task = _genTask;
    final running = task != null && task['status'] == 'running';
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(AppSpacing.lg, AppSpacing.sm, AppSpacing.lg, AppSpacing.xxl),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (task == null || !running) ...[
            WbTextField(
              label: tr('novel_drama.novel_title_label'),
              hint: tr('novel_drama.novel_title_hint'),
              controller: _genTitleCtrl,
              icon: Icons.drive_file_rename_outline_rounded,
              required: true,
            ),
            const SizedBox(height: AppSpacing.md),
            WbTextField(
              label: tr('novel_drama.genre_label'),
              hint: tr('novel_drama.genre_hint'),
              controller: TextEditingController(text: _genGenre),
              icon: Icons.category_rounded,
              onChanged: (v) => _genGenre = v.trim(),
            ),
            const SizedBox(height: AppSpacing.md),
            WbDropdown<String>(
              label: tr('novel_drama.scale_label'),
              value: _tier,
              items: [
                WbDropdownItem(
                    value: 'demo', label: tr('novel_drama.scale_demo')),
                WbDropdownItem(
                    value: 'novella', label: tr('novel_drama.scale_novella')),
                WbDropdownItem(
                    value: 'full', label: tr('novel_drama.scale_full')),
              ],
              onChanged: (v) => setState(() => _tier = v),
              icon: Icons.library_books_rounded,
            ),
            const SizedBox(height: AppSpacing.md),
            WbDropdown<String>(
              label: tr('novel_drama.ep_target_label'),
              value: _epTarget,
              items: [
                WbDropdownItem(value: '60', label: tr('novel_drama.ep_60')),
                WbDropdownItem(value: '90', label: tr('novel_drama.ep_90')),
                WbDropdownItem(value: '120', label: tr('novel_drama.ep_120')),
                WbDropdownItem(value: '180', label: tr('novel_drama.ep_180')),
              ],
              onChanged: (v) => setState(() => _epTarget = v),
              icon: Icons.timer_outlined,
            ),
            const SizedBox(height: AppSpacing.md),
            // 入口 A 的字数是档位目标值(小说还没生成,拿不到实数)
            _buildEstimateCard(_tierChars[_tier] ?? 20000, _epTarget),
            const SizedBox(height: AppSpacing.md),
            if (_error != null) ...[
              WbInfoCard(
                icon: Icons.error_outline_rounded,
                text: _error!,
                accent: AppColors.danger,
              ),
              const SizedBox(height: AppSpacing.md),
            ],
            AgentCostBanner.compact(agentId: widget.agentId),
            const SizedBox(height: AppSpacing.md),
            WbSubmitButton(
              label: tr('novel_drama.gen_btn'),
              loadingLabel: tr('novel_drama.gen_btn_loading'),
              icon: Icons.auto_awesome_rounded,
              loading: _genStarting,
              disabled: _genStarting,
              onTap: _startGen,
            ),
            const SizedBox(height: AppSpacing.sm),
            Text(
              tr('novel_drama.gen_hint'),
              style: AppTextStyles.labelSmall
                  .copyWith(color: AppColors.textTertiary),
            ),
          ],
          if (task != null) _buildGenProgress(task),
        ],
      ),
    );
  }

  Widget _buildGenProgress(Map<String, dynamic> task) {
    final stage =
        task['stageLabel']?.toString() ?? task['stage']?.toString() ?? '';
    final percent = (task['percent'] as num?)?.toInt() ?? 0;
    final chDone = task['chaptersDone'] ?? 0;
    final chTotal = task['chaptersTotal'] ?? 0;
    final chars = task['charsDone'] ?? 0;
    final preview = task['preview']?.toString();
    final failed = task['status'] == 'failed';

    return Container(
      margin: const EdgeInsets.only(top: AppSpacing.md),
      padding: const EdgeInsets.all(AppSpacing.xl),
      decoration: BoxDecoration(
        color: AppColors.cardBg,
        borderRadius: BorderRadius.circular(AppColors.cardRadius),
        border: Border.all(
            color: failed
                ? AppColors.danger.withValues(alpha: 0.4)
                : AppColors.primary.withValues(alpha: 0.25)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                  failed
                      ? Icons.error_outline_rounded
                      : Icons.auto_awesome_rounded,
                  size: 20,
                  color: failed ? AppColors.danger : AppColors.primary),
              const SizedBox(width: AppSpacing.sm),
              Expanded(
                child: Text(
                  failed ? tr('novel_drama.gen_failed') : tr('novel_drama.gen_running', args: {'title': '${task['title']}'}),
                  style: AppTextStyles.titleSmall,
                ),
              ),
              Text('$percent%',
                  style: AppTextStyles.titleSmall.copyWith(
                      color: AppColors.primary,
                      fontWeight: FontWeight.w900)),
            ],
          ),
          const SizedBox(height: AppSpacing.md),
          ClipRRect(
            borderRadius: BorderRadius.circular(AppColors.thumbRadius),
            child: LinearProgressIndicator(
              value: percent / 100,
              minHeight: 8,
              backgroundColor: AppColors.surfaceLight,
              color: failed ? AppColors.danger : AppColors.primary,
            ),
          ),
          const SizedBox(height: AppSpacing.md),
          Text(
            tr('novel_drama.gen_progress', args: {'stage': stage, 'done': '$chDone', 'total': '$chTotal', 'chars': '$chars'}),
            style: AppTextStyles.bodySmall
                .copyWith(color: AppColors.textSecondary),
          ),
          if (task['bible']?['logline'] != null) ...[
            const SizedBox(height: AppSpacing.sm),
            Text(
              '${task['bible']['logline']}',
              style: AppTextStyles.bodySmall
                  .copyWith(color: AppColors.textPrimary),
            ),
          ],
          if (preview != null && preview.isNotEmpty) ...[
            const SizedBox(height: AppSpacing.md),
            Container(
              padding: const EdgeInsets.all(AppSpacing.md),
              decoration: BoxDecoration(
                color: AppColors.surfaceLight,
                borderRadius: BorderRadius.circular(AppColors.slotRadius),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(tr('novel_drama.preview_btn'),
                      style: AppTextStyles.labelSmall
                          .copyWith(color: AppColors.textTertiary)),
                  const SizedBox(height: AppSpacing.sm),
                  Text(preview,
                      maxLines: 6,
                      overflow: TextOverflow.ellipsis,
                      style:
                          AppTextStyles.bodySmall.copyWith(height: 1.6)),
                ],
              ),
            ),
          ],
          // 2026-09-14:全文入口 —— 生成中/失败/完成都能读(正文逐章 append,
          //   不用等 100%)。阅读器里可切 Markdown 排版 / TXT 原文、改正文、下载。
          if (task['uuid'] != null) ...[
            const SizedBox(height: AppSpacing.md),
            WbSubmitButton(
              label: tr('novel_drama.read_full_btn'),
              icon: Icons.menu_book_rounded,
              onTap: _openReader,
            ),
          ],
          if (failed) ...[
            const SizedBox(height: AppSpacing.lg),
            if (task['error'] != null && task['error'].toString().isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(bottom: AppSpacing.md),
                child: Text(
                  tr('novel_drama.fail_reason', args: {'reason': '${task['error']}'}),
                  style: AppTextStyles.bodySmall
                      .copyWith(color: AppColors.danger),
                ),
              ),
            Row(
              children: [
                Expanded(
                  child: WbSubmitButton(
                    label: tr('novel_drama.retry_new_title'),
                    icon: Icons.refresh_rounded,
                    disabled: _genStarting,
                    onTap: () => setState(() {
                      _genTask = null;
                      _error = null;
                    }),
                  ),
                ),
                const SizedBox(width: AppSpacing.md),
                Expanded(
                  flex: 2,
                  child: WbSubmitButton(
                    label: tr('novel_drama.retry_from_checkpoint', args: {'n': '$chDone'}),
                    loadingLabel: tr('novel_drama.retry_loading'),
                    icon: Icons.play_arrow_rounded,
                    loading: _genStarting,
                    disabled: _genStarting,
                    onTap: _resumeGen,
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }

  /// 打开阅读器(当前生成任务的全文;生成中也能读已写完部分)
  void _openReader() {
    final uuid = _genTask?['uuid']?.toString();
    if (uuid == null || uuid.isEmpty) return;
    Navigator.pushNamed(context, AppRoute.novelReader, arguments: {
      'uuid': uuid,
      'title': _genTask?['title']?.toString(),
    });
  }

  /// 失败任务从断点重拉(已完成章保留,失败章重写)
  Future<void> _resumeGen() async {
    final uuid = _genTask?['uuid']?.toString();
    if (uuid == null || uuid.isEmpty) return;
    setState(() => _genStarting = true);
    try {
      final r = _unwrap(
          await _api.dio.post('/dramas/novel-gen/tasks/$uuid/resume'));
      if (!mounted) return;
      if (r is Map) {
        setState(() => _genTask = Map<String, dynamic>.from(r));
        _startPolling();
        _toast(tr('novel_drama.toast_gen_resumed'));
      }
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = _errMsg(e));
    } finally {
      if (mounted) setState(() => _genStarting = false);
    }
  }

  // ── 入口 B:粘贴/上传 Tab ─────────────────────────────────────────────
  Widget _buildUploadTab() {
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(AppSpacing.lg, AppSpacing.sm, AppSpacing.lg, AppSpacing.xxl),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          WbTextField(
            label: tr('novel_drama.work_name_label'),
            hint: tr('novel_drama.novel_title_hint'),
            controller: _titleCtrl,
            icon: Icons.drive_file_rename_outline_rounded,
            required: true,
          ),
          const SizedBox(height: AppSpacing.md),
          WbTextArea(
            label: tr('novel_drama.novel_text_label'),
            hint: tr('novel_drama.novel_text_hint'),
            controller: _novelCtrl,
            maxLines: 8,
            required: true,
            // 让「N 字」计数与下面的开跑前预估随输入实时更新
            onChanged: (_) => setState(() {}),
          ),
          const SizedBox(height: AppSpacing.sm),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              // Flexible(loose) + spaceBetween 与原来的「按钮 + Spacer + 计数」
              // 完全等价(按钮贴左、计数贴右),但窄屏时计数会省略而不是撑破。
              Flexible(
                child: TextButton.icon(
                  onPressed: _pickNovelFile,
                  icon: const Icon(Icons.upload_file_rounded, size: 18),
                  label: Text(tr('novel_drama.upload_txt')),
                ),
              ),
              Text(
                tr('novel_drama.chars_unit', args: {'n': '${_novelCtrl.text.length}'}),
                maxLines: 1, overflow: TextOverflow.ellipsis,
                style: AppTextStyles.labelSmall
                    .copyWith(color: AppColors.textTertiary),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.md),
          WbDropdown<String>(
            label: tr('novel_drama.ep_target_label'),
            value: _epTarget,
            items: [
              WbDropdownItem(value: '60', label: tr('novel_drama.ep_60')),
              WbDropdownItem(value: '90', label: tr('novel_drama.ep_90')),
              WbDropdownItem(value: '120', label: tr('novel_drama.ep_120')),
              WbDropdownItem(value: '180', label: tr('novel_drama.ep_180')),
            ],
            onChanged: (v) => setState(() => _epTarget = v),
            icon: Icons.timer_outlined,
          ),
          const SizedBox(height: AppSpacing.md),
          // 入口 B 的字数是粘贴框里的真实字数,预估直接用它
          _buildEstimateCard(_novelCtrl.text.length, _epTarget),
          const SizedBox(height: AppSpacing.md),
          if (_error != null) ...[
            WbInfoCard(
              icon: Icons.error_outline_rounded,
              text: _error!,
              accent: AppColors.danger,
            ),
            const SizedBox(height: AppSpacing.md),
          ],
          AgentCostBanner.compact(agentId: widget.agentId),
          const SizedBox(height: AppSpacing.md),
          WbSubmitButton(
            label: tr('novel_drama.ingest_btn'),
            loadingLabel: tr('novel_drama.ingest_loading'),
            icon: Icons.auto_awesome_rounded,
            loading: _submitting,
            disabled: _submitting,
            onTap: _submit,
          ),
        ],
      ),
    );
  }

  // ── 账本视图(两入口汇合后共用) ────────────────────────────────────────
  Widget _buildLedgerView() {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(AppSpacing.lg),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // 2026-09-15:能恢复就得能退出。以前「离开页面再重进」是回到起始表单的
          // 唯一途径,现在重进会被自动恢复抢掉 —— 必须给一个显式重置入口。
          _buildBackToStartRow(),
          const SizedBox(height: AppSpacing.md),
          // 2026-09-14:小说原文入口 —— 页面切到账本/报价单视图后,生成卡片连同
          //   它的「阅读全文」按钮一起消失,完本的小说就再也读不到了。这里补一个
          //   常驻入口,走账本快照接口(只读),入口 A(生成)和入口 B(上传)都覆盖。
          _buildNovelSourceCard(),
          const SizedBox(height: AppSpacing.lg),
          _buildQuoteCard(),
          const SizedBox(height: AppSpacing.lg),
          _buildGatesPanel(),
          const SizedBox(height: AppSpacing.lg),
          _buildActionsBar(),
        ],
      ),
    );
  }

  /// 重置回起始表单(清空 dramaUuid / 账本 / 批次,并停掉所有轮询)
  void _backToStart() {
    _pollTimer?.cancel();
    _stageTimer?.cancel();
    _resetPortraitView();
    setState(() {
      _dramaUuid = null;
      _ledger = null;
      _batch = null;
      _genTask = null;
      _error = null;
      _assets = [];
      _assetsLoaded = false;
      _episodes = [];
      _expandedEpNo = null;
      _idlePolls = 0;
    });
    // 清单要重拉:否则刚选择「保留」的项目不会出现在「未完成的项目」里
    unawaited(_refreshActiveProjects());
  }

  /// 「回到起点」:开始新项目 —— 有进行中的项目时先问一句怎么处理它。
  ///
  /// 为什么必须问:这个按钮以前只清内存字段,剧本身还留在库里。用户以为
  /// "清掉了,重新开始",实际是留下一个**再也不会被打开的半成品** ——
  /// 而项目清单只列最近 3 个,它很快就被挤到看不见的地方,白烧的配额
  /// 连个交代都没有。反过来,直接删也不对:用户可能只是想换个小说试试。
  Future<void> _backToStartWithChoice() async {
    final uuid = _dramaUuid;
    if (uuid == null || uuid.isEmpty) {
      _backToStart();
      return;
    }
    final title = _ledger?['novelTitle']?.toString() ?? tr('novel_drama.fallback_current_project');
    final choice = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(tr('novel_drama.new_project_title')),
        content: Text(tr('novel_drama.dialog_new_project_body', args: {'title': title})),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, 'cancel'),
            child: Text(tr('common.cancel')),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, 'keep'),
            child: Text(tr('novel_drama.keep_and_new')),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, 'delete'),
            style: TextButton.styleFrom(foregroundColor: AppColors.danger),
            child: Text(tr('novel_drama.delete_and_new')),
          ),
        ],
      ),
    );
    if (!mounted || choice == 'cancel' || choice == null) return;
    if (choice == 'delete') {
      try {
        await _api.dio.delete('/dramas/$uuid', options: _fresh);
        _api.invalidate('/dramas/novel/active');
        if (!mounted) return;
        _toast(tr('novel_drama.toast_project_deleted'));
      } catch (e) {
        // 删失败就**别清界面** —— 清了用户会以为删掉了,实际还留在库里
        if (mounted) _toast(_errMsg(e), error: true);
        return;
      }
    }
    _backToStart();
  }

  Widget _buildBackToStartRow() {
    return Align(
      alignment: Alignment.centerLeft,
      child: InkWell(
        borderRadius: BorderRadius.circular(AppColors.cardRadius),
        onTap: _backToStartWithChoice,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm, vertical: AppSpacing.xs),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.add_circle_outline_rounded,
                  size: 15, color: AppColors.textTertiary),
              const SizedBox(width: AppSpacing.xs),
              Text(
                tr('novel_drama.new_project_cta'),
                style: AppTextStyles.caption
                    .copyWith(color: AppColors.textTertiary),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// 小说原文卡片:标题 / 字数 / 来源(生成 or 上传) + 阅读全文
  Widget _buildNovelSourceCard() {
    final title = _ledger?['novelTitle']?.toString();
    final source = _ledger?['novelSource']?.toString();
    // totalChars 是 Prisma BigInt 列 → 后端序列化成**字符串**("14329"),
    // `as num?` 会抛 TypeError 把整页打成空白,必须走已兼容字符串的 _asInt。
    final chars = _asInt(_ledger?['totalChars']);
    final uploaded = source == 'uploaded';
    final hasText = (_ledger?['novelStorageKey']?.toString() ?? '').isNotEmpty;

    return Container(
      padding: const EdgeInsets.all(AppSpacing.xl),
      decoration: BoxDecoration(
        color: AppColors.cardBg,
        borderRadius: BorderRadius.circular(AppColors.cardRadius),
        border: Border.all(color: AppColors.info.withValues(alpha: 0.25)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.menu_book_rounded, color: AppColors.info, size: 20),
              const SizedBox(width: AppSpacing.sm),
              Expanded(
                child: Text(
                  title == null || title.isEmpty ? tr('novel_drama.novel_original') : title,
                  style: AppTextStyles.titleSmall,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: AppSpacing.sm, vertical: AppSpacing.xs),
                decoration: BoxDecoration(
                  color: AppColors.info.withValues(alpha: 0.10),
                  borderRadius: BorderRadius.circular(AppColors.cardRadius),
                ),
                child: Text(
                  uploaded ? tr('novel_drama.source_uploaded') : tr('novel_drama.source_ai'),
                  style: AppTextStyles.labelSmall
                      .copyWith(color: AppColors.info),
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.md),
          Text(
            tr('novel_drama.novel_meta', args: {'chars': chars == null ? '—' : chars.toString()}),
            style: AppTextStyles.bodySmall
                .copyWith(color: AppColors.textSecondary),
          ),
          const SizedBox(height: AppSpacing.lg),
          WbSubmitButton(
            label: tr('novel_drama.read_full_btn'),
            icon: Icons.auto_stories_rounded,
            disabled: !hasText,
            onTap: _openLedgerReader,
          ),
        ],
      ),
    );
  }

  /// 打开账本原文阅读器(只读通路 —— 传 dramaUuid 而非任务 uuid)
  void _openLedgerReader() {
    final uuid = _dramaUuid;
    if (uuid == null || uuid.isEmpty) return;
    Navigator.pushNamed(context, AppRoute.novelReader, arguments: {
      'dramaUuid': uuid,
      'title': _ledger?['novelTitle']?.toString(),
    });
  }

  // ── 开跑前预估(两个入口共用) ─────────────────────────────────────────
  //
  // 为什么要做:用户点「一键生成」时能看到的只有一句模糊的"数小时",而这一步
  // 实际会烧掉几千积分、跑几十小时。报价单那侧已经在补价格(见 _buildQuoteCard),
  // 但报价单是**小说写完、账本建好之后**才出现的 —— 用户在按下按钮之前同样
  // 需要知道自己在选什么。实测 33 份真实账本:demo 档 5-8 集,novella 档按同一
  // 口径会到 80 集以上,量级差一个数量级,不说清就是在赌。
  //
  // 公式与后端 drama-pricing.ts 同源(集数 ÷ 单集时长 = 总时长):
  //   总时长(分) = 字数 ÷ 10000 × k_eff        k_eff = 8.35
  //   集数       = 总时长 × 60 ÷ 单集目标秒数
  //   镜头数     = 集数 × ceil(单集秒数 ÷ 10)   每镜 8-12 秒的新策略
  //   积分       = 镜头 × (图 8 + 视频 40) + 集数 × 2 次 LLM × 2
  //
  // ⚠ 这是**量级估计**,不是承诺。真实数字在确认报价单时给出(那时账本已建,
  // 集数与字数都是实数,而且失败镜头不计费,实际通常低于预估值)。

  /// 每万字折算多少分钟(k_eff)。取自 33 份真实账本的中位数(8.35,均值 8.04),
  /// 口径见 `tool/n2d-core/dist/budget.js` 的 `applyBudget`。
  static const _kEffPerWanChars = 8.35;

  /// 三个小说规模档位的目标字数(与入口 A 的 WbDropdown 文案一一对应)
  static const _tierChars = <String, int>{
    'demo': 20000,
    'novella': 200000,
    'full': 800000,
  };

  /// 千分位:积分动辄四位数,不加分隔符读不出量级
  String _grouped(int n) {
    final s = n.abs().toString();
    final buf = StringBuffer();
    for (var i = 0; i < s.length; i++) {
      if (i > 0 && (s.length - i) % 3 == 0) buf.write(',');
      buf.write(s[i]);
    }
    return '${n < 0 ? '-' : ''}$buf';
  }

  Widget _buildEstimateCard(int chars, String epTarget) {
    if (chars <= 0) return const SizedBox.shrink();
    final epSec = int.tryParse(epTarget) ?? 120;
    final totalMin = chars / 10000 * _kEffPerWanChars;
    final eps = (totalMin * 60 / epSec).ceil().clamp(1, 9999).toInt();
    final shotsPerEp = (epSec / 10).ceil().clamp(2, 999).toInt();
    final shots = eps * shotsPerEp;
    // 单价与后端 DEFAULT_UNIT_PRICES 一致(图 8 / 视频 40 / 文本 2)
    final credits = shots * 8 + shots * 40 + eps * 2 * 2;
    return Container(
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: AppColors.surfaceLight,
        borderRadius: BorderRadius.circular(AppColors.slotRadius),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.calculate_outlined,
                  size: 16, color: AppColors.primary),
              const SizedBox(width: AppSpacing.sm),
              Expanded(
                child: Text(tr('novel_drama.estimate_title'),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AppTextStyles.labelSmall.copyWith(
                        color: AppColors.textSecondary,
                        fontWeight: FontWeight.w700)),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.sm),
          Row(
            children: [
              Expanded(child: _StatCell(label: tr('novel_drama.est_eps_label'), value: tr('novel_drama.eps_unit', args: {'n': '$eps'}))),
              Expanded(child: _StatCell(label: tr('novel_drama.est_shots_label'), value: tr('novel_drama.shots_unit', args: {'n': '$shots'}))),
              Expanded(
                  child:
                      _StatCell(label: tr('novel_drama.est_credits_label'), value: _grouped(credits))),
            ],
          ),
          const SizedBox(height: AppSpacing.sm),
          Text(
            tr('novel_drama.estimate_note', args: {'rate': _kEffPerWanChars.toStringAsFixed(1), 'shots': '$shotsPerEp'}),
            style: AppTextStyles.labelSmall
                .copyWith(color: AppColors.textTertiary),
          ),
        ],
      ),
    );
  }

  Widget _buildQuoteCard() {
    final budget = (_ledger!['gates'] as List?)?.firstWhere(
      (g) => (g as Map)['gate'] == 'gate1_budget',
      orElse: () => null,
    );
    final payload = (budget is Map) ? (budget['payload'] as Map?) : null;
    final minutes = payload?['totalMinutes'];
    final eps = payload?['episodeCount'];
    final chars = payload?['novelChars'];
    final status = (budget is Map) ? budget['status']?.toString() : null;

    // ── 真实价格(2026-09-15 补) ───────────────────────────────────────
    // 之前这张卡只有「时长/集数/字数」—— 用户点「确认报价」时根本不知道要花
    // 多少积分、等多久。实测 gate1 有 25 个卡在 waiting、只有 9 个 passed,
    // 一部分原因就是这张卡没给出决策需要的信息。
    // 数字全部来自后端 drama-pricing.ts 的同一套公式(报价单与批次实际扣费
    // 同源),不是前端另算的,所以不会出现"报价说 800、实际扣 2000"。
    final credits = _asInt(payload?['estimatedCredits']);
    final shots = _asInt(payload?['estimatedShots']);
    final shotsPerEp = _asInt(payload?['shotsPerEpisode']);
    final wallMin = _asInt(payload?['estimatedWallMinutes']);
    final epSec = _asInt(payload?['epTargetSec']);
    final keys = _asInt(payload?['keyCount']);
    final unit = (payload?['unitPrices'] is Map)
        ? Map<String, dynamic>.from(payload!['unitPrices'] as Map)
        : null;
    // 老报价单是补算的(读时回填,没落库),标出来免得用户以为当初就是这么报的
    final estimated = payload?['quoteEstimated'] == true;

    final wallText = wallMin == null
        ? null
        : (wallMin >= 60
            ? tr('novel_drama.hours_unit', args: {'n': (wallMin / 60).toStringAsFixed(1)})
            : tr('novel_drama.minutes_unit', args: {'n': '$wallMin'}));

    return Container(
      padding: const EdgeInsets.all(AppSpacing.xl),
      decoration: BoxDecoration(
        color: AppColors.cardBg,
        borderRadius: BorderRadius.circular(AppColors.cardRadius),
        border: Border.all(color: AppColors.primary.withValues(alpha: 0.25)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.fact_check_outlined,
                  color: AppColors.primary, size: 20),
              const SizedBox(width: AppSpacing.sm),
              Expanded(child: Text(tr('novel_drama.gate1_title'), style: AppTextStyles.titleSmall, maxLines: 1, overflow: TextOverflow.ellipsis)),
              const Spacer(),
              if (status != null) _GateStatusChip(status: status),
            ],
          ),
          const SizedBox(height: AppSpacing.lg),
          if (payload != null && minutes != null) ...[
            Row(
              children: [
                Expanded(
                    child: _StatCell(label: tr('novel_drama.est_total_duration'), value: tr('novel_drama.minutes_unit', args: {'n': '$minutes'}))),
                Expanded(child: _StatCell(label: tr('novel_drama.eps_label'), value: tr('novel_drama.eps_unit', args: {'n': '$eps'}))),
                Expanded(
                    child: _StatCell(label: tr('novel_drama.novel_chars_label'), value: tr('novel_drama.chars_unit', args: {'n': '$chars'}))),
              ],
            ),
            if (credits != null || shots != null || wallText != null) ...[
              const SizedBox(height: AppSpacing.lg),
              Row(
                children: [
                  Expanded(
                      child: _StatCell(
                          label: tr('novel_drama.est_credits_label'),
                          value: credits == null ? '—' : '$credits')),
                  Expanded(
                      child: _StatCell(
                          label: tr('novel_drama.est_shots_label'),
                          value: shots == null ? '—' : tr('novel_drama.shots_unit', args: {'n': '$shots'}))),
                  Expanded(
                      child: _StatCell(
                          label: tr('novel_drama.est_wall_label'),
                          value: wallText ?? '—')),
                ],
              ),
            ],
            if (epSec != null || unit != null) ...[
              const SizedBox(height: AppSpacing.md),
              Container(
                padding: const EdgeInsets.all(AppSpacing.md),
                decoration: BoxDecoration(
                  color: AppColors.surfaceLight,
                  borderRadius: BorderRadius.circular(AppColors.slotRadius),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (epSec != null && shotsPerEp != null)
                      Text(
                        tr('novel_drama.ep_spec', args: {'sec': '$epSec', 'shots': '$shotsPerEp'}),
                        style: AppTextStyles.labelSmall
                            .copyWith(color: AppColors.textSecondary),
                      ),
                    if (unit != null) ...[
                      const SizedBox(height: AppSpacing.xs),
                      Text(
                        '${tr('novel_drama.pricing_units', args: {'image': '${unit['image']}', 'video': '${unit['video']}', 'llm': '${unit['llm']}'})}${keys != null ? tr('novel_drama.video_channels', args: {'n': '$keys'}) : ''}',
                        style: AppTextStyles.labelSmall
                            .copyWith(color: AppColors.textTertiary),
                      ),
                    ],
                    const SizedBox(height: AppSpacing.xs),
                    Text(
                      tr('novel_drama.credits_note'),
                      style: AppTextStyles.labelSmall
                          .copyWith(color: AppColors.textTertiary),
                    ),
                  ],
                ),
              ),
            ],
            _buildEpisodePlan(),
            if (estimated) ...[
              const SizedBox(height: AppSpacing.sm),
              Text(
                tr('novel_drama.estimate_note_legacy'),
                style: AppTextStyles.labelSmall
                    .copyWith(color: AppColors.warning),
              ),
            ],
            const SizedBox(height: AppSpacing.md),
            Text(
              tr('novel_drama.confirm_note'),
              style: AppTextStyles.bodySmall
                  .copyWith(color: AppColors.textSecondary),
            ),
          ] else
            Text(tr('novel_drama.quote_loading'),
                style: AppTextStyles.bodySmall
                    .copyWith(color: AppColors.textTertiary)),
        ],
      ),
    );
  }

  /// 报价门里的「分集时长计划」:罗列后端按原著逐集折算出的集数与每集时长。
  /// `_plan` 为空(没建账本 / 拉取失败)时返回 0 高,不影响报价卡其余部分。
  Widget _buildEpisodePlan() {
    final eps =
        (_plan?['episodes'] as List?)?.whereType<Map>().toList() ??
            const <Map>[];
    if (eps.isEmpty) return const SizedBox.shrink();
    final count = _asInt(_plan?['episodeCount']) ?? eps.length;
    final genSec = _asInt(_plan?['totalGenSec']) ?? 0;
    final minSec = _asInt(_plan?['minSec']) ?? 45;
    final maxSec = _asInt(_plan?['maxSec']) ?? 240;
    final minLabel = tr('novel_drama.minutes_unit',
        args: {'n': (genSec / 60).toStringAsFixed(genSec >= 600 ? 0 : 1)});
    const maxShow = 8;
    final shown = eps.take(maxShow).toList();

    return Container(
      margin: const EdgeInsets.only(top: AppSpacing.md),
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: AppColors.surfaceLight,
        borderRadius: BorderRadius.circular(AppColors.slotRadius),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.schedule_rounded, color: AppColors.primary, size: 16),
              const SizedBox(width: AppSpacing.xs),
              Expanded(
                child: Text(
                  tr('novel_drama.plan_summary',
                      args: {'eps': '$count', 'min': minLabel}),
                  style: AppTextStyles.labelSmall.copyWith(
                      color: AppColors.textSecondary,
                      fontWeight: FontWeight.w700),
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.xxs),
          Text(
            tr('novel_drama.plan_note',
                args: {'min_sec': '$minSec', 'max_sec': '$maxSec'}),
            style: AppTextStyles.labelSmall
                .copyWith(color: AppColors.textTertiary, height: 1.4),
          ),
          const SizedBox(height: AppSpacing.sm),
          ...shown.map((e) {
            final n = _asInt(e['epNo']) ?? 0;
            final content = _asInt(e['contentSec']) ?? 0;
            final gen = _asInt(e['genTargetSec']) ?? 0;
            final shots = _asInt(e['plannedShots']) ?? 0;
            final raised = e['raised'] == true;
            final capped = e['capped'] == true;
            return Padding(
              padding: const EdgeInsets.only(bottom: AppSpacing.xxs),
              child: Row(
                children: [
                  SizedBox(
                    width: 46,
                    child: Text(tr('novel_drama.plan_ep', args: {'n': '$n'}),
                        style: AppTextStyles.labelSmall.copyWith(
                            color: AppColors.textSecondary,
                            fontWeight: FontWeight.w600)),
                  ),
                  Expanded(
                    child: Text(
                      tr('novel_drama.plan_ep_line',
                          args: {'content': '$content', 'gen': '$gen', 'shots': '$shots'}),
                      style: AppTextStyles.labelSmall
                          .copyWith(color: AppColors.textSecondary),
                    ),
                  ),
                  if (raised || capped)
                    Text(
                      raised
                          ? tr('novel_drama.plan_raised')
                          : tr('novel_drama.plan_capped'),
                      style: AppTextStyles.labelSmall.copyWith(
                          fontSize: 10,
                          color: raised ? AppColors.warning : AppColors.accent),
                    ),
                ],
              ),
            );
          }),
          if (eps.length > shown.length)
            Text(
              tr('novel_drama.plan_more_eps',
                  args: {'n': '${eps.length - shown.length}'}),
              style: AppTextStyles.labelSmall
                  .copyWith(color: AppColors.textTertiary),
            ),
        ],
      ),
    );
  }

  Widget _buildGatesPanel() {
    final gates = (_ledger!['gates'] as List?)
            ?.whereType<Map>()
            .map((g) => Map<String, dynamic>.from(g))
            .toList() ??
        const <Map<String, dynamic>>[];
    return Container(
      padding: const EdgeInsets.all(AppSpacing.xl),
      decoration: BoxDecoration(
        color: AppColors.cardBg,
        borderRadius: BorderRadius.circular(AppColors.cardRadius),
        border: Border.all(color: AppColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.account_tree_rounded,
                  color: AppColors.primary, size: 20),
              const SizedBox(width: AppSpacing.sm),
              Flexible(child: Text(tr('novel_drama.pipeline_title'), style: AppTextStyles.titleSmall, maxLines: 1, overflow: TextOverflow.ellipsis)),
            ],
          ),
          const SizedBox(height: AppSpacing.md),
          ...gates.map((g) {
            final gate = g['gate']?.toString() ?? '';
            final status = g['status']?.toString() ?? 'waiting';
            final label = switch (gate) {
              'gate1_budget' => tr('novel_drama.pipeline_gate1'),
              'gate2_design' => tr('novel_drama.pipeline_gate2'),
              'gate3_script' => tr('novel_drama.pipeline_gate3'),
              _ => gate,
            };
            return Padding(
              padding: const EdgeInsets.only(bottom: AppSpacing.sm),
              child: Row(
                children: [
                  _GateStatusDot(status: status),
                  const SizedBox(width: AppSpacing.md),
                  Expanded(
                      child: Text(label, style: AppTextStyles.bodyMedium)),
                  _GateStatusChip(status: status),
                ],
              ),
            );
          }),
          const SizedBox(height: AppSpacing.sm),
          Text(
            tr('novel_drama.pipeline_desc'),
            style: AppTextStyles.labelSmall
                .copyWith(color: AppColors.textTertiary),
          ),
        ],
      ),
    );
  }

  Widget _buildActionsBar() {
    final gate1 = _gateOf('gate1_budget');
    final g1 = gate1?['status']?.toString();
    final waiting = g1 == 'waiting';
    // 后台 beats 抽取/按节拍重排进行中:后端会对 decide 抛 409(见
    // novel-ledger.service.ts 的 repacking 分支)。与其让用户转圈→吃报错→再点,
    // 不如直接禁用双钮 + 给真实等待时长;轮询(_stageActive)会在标志清除后自动恢复。
    final g1Payload = _gatePayload('gate1_budget');
    final repacking = g1Payload?['repacking'] == true;
    final repackWaitedMin =
        repacking ? _minutesSince(g1Payload?['repackingAt']) : null;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (_error != null) ...[
          WbInfoCard(
            icon: Icons.error_outline_rounded,
            text: _error!,
            accent: AppColors.danger,
          ),
          const SizedBox(height: AppSpacing.md),
        ],
        if (waiting) ...[
          if (repacking) ...[
            _stageHint(
              Icons.autorenew_rounded,
              AppColors.warning,
              tr('novel_drama.repacking_hint',
                  args: {'waited': '${repackWaitedMin ?? 0}'}),
            ),
            const SizedBox(height: AppSpacing.md),
          ],
          Row(
            children: [
              Expanded(
                child: WbSubmitButton(
                  label: tr('novel_drama.reject_quote'),
                  loadingLabel: tr('novel_drama.submitting'),
                  icon: Icons.close_rounded,
                  loading: _deciding,
                  disabled: _deciding || repacking,
                  onTap: () => _decideGate('gate1_budget', false),
                ),
              ),
              const SizedBox(width: AppSpacing.md),
              Expanded(
                flex: 2,
                child: WbSubmitButton(
                  label: tr('novel_drama.confirm_quote_btn'),
                  loadingLabel: tr('novel_drama.submitting'),
                  icon: Icons.check_rounded,
                  loading: _deciding,
                  disabled: _deciding || repacking,
                  onTap: () => _decideGate('gate1_budget', true),
                ),
              ),
            ],
          ),
        ] else if (g1 == 'rejected') ...[
          // AppColors.danger 非 const,不能包 const
          _rejectedBlock('gate1_budget',
              tr('novel_drama.quote_rejected_note')),
        ] else ...[
          // 门①已过 → Stage 2 流水线:设定门 → 剧本门 → 连集生产
          _buildGate2Card(),
          const SizedBox(height: AppSpacing.md),
          _buildGate3Card(),
        ],
      ],
    );
  }

  // ── 门②:设定(角色/场景/画风) ────────────────────────────────────────
  Widget _buildGate2Card() {
    final g = _gateOf('gate2_design');
    final status = g?['status']?.toString() ?? 'waiting';
    final p = _gatePayload('gate2_design');
    final state = p?['state']?.toString();

    final List<Widget> body = [];
    if (status == 'passed') {
      body.add(_stageHint(Icons.check_circle_outline_rounded, AppColors.success,
          tr('novel_drama.settings_passed', args: {'detail': _asInt(p?['createdCount']) != null ? tr('novel_drama.assets_created_suffix', args: {'n': "${p?['createdCount']}"}) : ''})));
      if (state == 'ready') body.add(_assetSummary(p!));
      // 自动定妆正是在这一步之后才跑,进度必须显示在同一张卡片上
      body.add(const SizedBox(height: AppSpacing.md));
      body.add(_portraitNotice());
    } else if (status == 'rejected') {
      body.add(_rejectedBlock('gate2_design',
          tr('novel_drama.design_rejected_note')));
    } else if (state == 'generating') {
      body.add(_stageSpinner(tr('novel_drama.design_running')));
      body.add(const SizedBox(height: AppSpacing.md));
      body.add(_stageEscapeHatch('gate2_design', g));
    } else if (state == 'ready') {
      body.add(_assetSummary(p!));
      body.add(const SizedBox(height: AppSpacing.md));
      body.add(_portraitNotice());
      body.add(const SizedBox(height: AppSpacing.md));
      body.add(Row(
        children: [
          Expanded(
            child: _GateMiniButton(
              label: tr('novel_drama.reject_btn'),
              icon: Icons.close_rounded,
              color: AppColors.danger,
              busy: _deciding,
              onTap: () => _decideGate('gate2_design', false),
            ),
          ),
          const SizedBox(width: AppSpacing.md),
          Expanded(
            flex: 2,
            child: WbSubmitButton(
              label: tr('novel_drama.confirm_design_btn'),
              loadingLabel: tr('novel_drama.submitting'),
              icon: Icons.check_rounded,
              loading: _deciding,
              disabled: _deciding,
              onTap: _confirmGate2,
            ),
          ),
        ],
      ));
    } else if (state == 'failed') {
      body.add(_stageHint(Icons.error_outline_rounded, AppColors.danger,
          tr('novel_drama.design_failed', args: {'reason': '${p?['error'] ?? tr('novel_drama.unknown_reason')}'})));
      body.add(const SizedBox(height: AppSpacing.md));
      body.add(WbSubmitButton(
        label: tr('novel_drama.retry_design_btn'),
        loadingLabel: tr('novel_drama.pulling_up'),
        icon: Icons.refresh_rounded,
        loading: _deciding,
        disabled: _deciding,
        onTap: () => _retryGate('gate2_design'),
      ));
    } else {
      body.add(_stageHint(Icons.hourglass_top_rounded, AppColors.warning,
          tr('novel_drama.queued_design')));
      body.add(const SizedBox(height: AppSpacing.md));
      body.add(_GateMiniButton(
        label: tr('novel_drama.toast_unresponsive_btn'),
        icon: Icons.refresh_rounded,
        color: AppColors.textSecondary,
        busy: _deciding,
        onTap: () => _retryGate('gate2_design'),
      ));
    }
    return _stageCard(
      icon: Icons.palette_outlined,
      title: tr('novel_drama.gate2_title'),
      gateStatus: status,
      body: body,
    );
  }

  // ── 门③:剧本(逐集大纲/分镜)+ 连集生产 ───────────────────────────────
  Widget _buildGate3Card() {
    final g = _gateOf('gate3_script');
    final status = g?['status']?.toString() ?? 'waiting';
    final p = _gatePayload('gate3_script');
    final state = p?['state']?.toString();
    final gate2Passed = _gateOf('gate2_design')?['status'] == 'passed';

    final List<Widget> body = [];
    if (status == 'passed' && (state == 'producing' || _batch != null)) {
      body.add(_buildProductionCard(p));
    } else if (status == 'rejected') {
      body.add(_rejectedBlock('gate3_script',
          tr('novel_drama.script_rejected_note')));
    } else if (!gate2Passed) {
      body.add(_stageHint(Icons.lock_outline_rounded, AppColors.textTertiary,
          tr('novel_drama.gate2_desc')));
    } else if (state == 'generating') {
      final done = _asInt(p?['episodesDone']) ?? 0;
      final total = _asInt(p?['episodesTotal']) ?? 0;
      body.add(_stageSpinner(total > 0
          ? tr('novel_drama.script_running', args: {'done': '$done', 'total': '$total'})
          : tr('novel_drama.script_running_plain')));
      if (total > 0) {
        body.addAll([
          const SizedBox(height: AppSpacing.md),
          ClipRRect(
            borderRadius: BorderRadius.circular(AppColors.thumbRadius),
            child: LinearProgressIndicator(
              value: (done / total).clamp(0.0, 1.0),
              minHeight: 6,
              backgroundColor: AppColors.surfaceLight,
              color: AppColors.primary,
            ),
          ),
        ]);
      }
      body.add(const SizedBox(height: AppSpacing.md));
      body.add(_stageEscapeHatch('gate3_script', g));
    } else if (state == 'ready') {
      body.add(_episodeSummary(p!));
      body.add(const SizedBox(height: AppSpacing.md));
      body.add(Row(
        children: [
          Expanded(
            child: _GateMiniButton(
              label: tr('novel_drama.reject_btn'),
              icon: Icons.close_rounded,
              color: AppColors.danger,
              busy: _deciding,
              onTap: () => _decideGate('gate3_script', false),
            ),
          ),
          const SizedBox(width: AppSpacing.md),
          Expanded(
            flex: 2,
            child: WbSubmitButton(
              label: tr('novel_drama.confirm_script_btn'),
              loadingLabel: tr('novel_drama.submitting'),
              icon: Icons.movie_filter_outlined,
              loading: _deciding,
              disabled: _deciding,
              onTap: () => _decideGate('gate3_script', true),
            ),
          ),
        ],
      ));
    } else if (state == 'failed') {
      body.add(_stageHint(Icons.error_outline_rounded, AppColors.danger,
          tr('novel_drama.stage_failed', args: {'reason': '${p?['error'] ?? tr('novel_drama.unknown_reason')}'})));
      body.add(const SizedBox(height: AppSpacing.md));
      body.add(WbSubmitButton(
        label: tr('novel_drama.retry_stage_btn'),
        loadingLabel: tr('novel_drama.pulling_up'),
        icon: Icons.refresh_rounded,
        loading: _deciding,
        disabled: _deciding,
        onTap: () => _retryGate('gate3_script'),
      ));
    } else {
      body.add(_stageHint(Icons.hourglass_top_rounded, AppColors.warning,
          tr('novel_drama.queued_script')));
      body.add(const SizedBox(height: AppSpacing.md));
      body.add(_GateMiniButton(
        label: tr('novel_drama.toast_unresponsive_btn'),
        icon: Icons.refresh_rounded,
        color: AppColors.textSecondary,
        busy: _deciding,
        onTap: () => _retryGate('gate3_script'),
      ));
    }
    return _stageCard(
      icon: Icons.movie_outlined,
      title: tr('novel_drama.gate3_title'),
      gateStatus: status,
      body: body,
    );
  }

  // ── 连集分集与分镜明细(2026-09-20 优化:可观察、可修改、可补做) ──────────

  Future<void> _loadEpisodes() async {
    final uuid = _dramaUuid;
    if (uuid == null) return;
    if (mounted) setState(() => _episodesLoading = true);
    try {
      final r = await _api.dio.get('/dramas/$uuid/episodes', options: _fresh);
      final list = (_unwrap(r) as List?)?.whereType<Map>().toList() ?? const [];
      if (mounted) {
        setState(() {
          _episodes = list.map((e) => Map<String, dynamic>.from(e)).toList();
        });
      }
    } catch (_) {
    } finally {
      if (mounted) setState(() => _episodesLoading = false);
    }
  }

  /// 补做指定集的缺失镜头:重跑步骤 4 (自动复用成功镜头,只补做失败/未生成镜) + 步骤 5 重合成
  Future<void> _supplementEpShots(int epNo) async {
    final uuid = _dramaUuid;
    if (uuid == null) return;
    setState(() => _supplementingEp = epNo);
    _toast('正在补做第 $epNo 集缺失镜头并重合成，请稍候…');
    try {
      // 步骤 4 视频增量补做
      await _api.dio.post(
        '/dramas/$uuid/episodes/$epNo/steps/4/generate',
        data: const {},
        options: Options(receiveTimeout: const Duration(minutes: 20)),
      );
      // 步骤 5 重新合成成片
      await _api.dio.post(
        '/dramas/$uuid/episodes/$epNo/steps/5/generate',
        data: const {},
        options: Options(receiveTimeout: const Duration(minutes: 10)),
      );
      _toast('第 $epNo 集缺失镜头补做完成，成片已更新！');
      await _loadEpisodes();
    } catch (e) {
      if (mounted) _toast('补做失败: ${_errMsg(e)}', error: true);
    } finally {
      if (mounted) setState(() => _supplementingEp = null);
    }
  }

  /// 弹窗修改指定集字幕台词并 5 秒快速重烧(不重新生成视频,不耗视频配额)
  Future<void> _openReburnDialog(Map<String, dynamic> ep) async {
    final epNo = (ep['epNo'] as num?)?.toInt() ?? 1;
    final sd = (ep['stepData'] as Map?)?.cast<String, dynamic>() ?? const {};
    final out5 = (sd['5'] as Map?)?['output'] as Map?;
    final out2 = (sd['2'] as Map?)?['output'] as Map?;
    final subtitleCues = (out5?['subtitle_cues'] as List?)?.whereType<Map>().toList() ?? const [];
    final shots = (out2?['shots'] as List?)?.whereType<Map>().toList() ?? const [];

    final items = <Map<String, dynamic>>[];
    if (subtitleCues.isNotEmpty) {
      for (final c in subtitleCues) {
        items.add({
          'shotIdx': (c['shotIdx'] as num?)?.toInt() ?? 0,
          'text': (c['text'] ?? '').toString(),
          'speaker': c['speaker'],
        });
      }
    } else {
      for (final s in shots) {
        items.add({
          'shotIdx': (s['idx'] as num?)?.toInt() ?? 0,
          'text': (s['dialogue'] ?? '').toString(),
          'speaker': null,
        });
      }
    }

    if (items.isEmpty) {
      _toast('本集暂无台词可微调', error: true);
      return;
    }

    final controllers = items.map((it) => TextEditingController(text: it['text'] as String)).toList();

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Row(
          children: [
            Icon(Icons.subtitles_outlined, color: AppColors.primary, size: 20),
            const SizedBox(width: AppSpacing.sm),
            Text('微调第 $epNo 集字幕台词', style: AppTextStyles.titleSmall),
          ],
        ),
        content: SizedBox(
          width: 500,
          height: 380,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '修改后点击「立即重烧」，系统将直接复用视频在 5 秒内烧录新字幕，零视频配额消耗。',
                style: AppTextStyles.caption.copyWith(color: AppColors.textSecondary),
              ),
              const SizedBox(height: AppSpacing.md),
              Expanded(
                child: ListView.separated(
                  itemCount: items.length,
                  separatorBuilder: (_, __) => const SizedBox(height: AppSpacing.sm),
                  itemBuilder: (context, idx) {
                    final it = items[idx];
                    return Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                          decoration: BoxDecoration(
                            color: AppColors.surfaceLight,
                            borderRadius: BorderRadius.circular(AppRadius.bar),
                          ),
                          child: Text('镜 ${it['shotIdx']}', style: AppTextStyles.labelSmall),
                        ),
                        const SizedBox(width: AppSpacing.sm),
                        Expanded(
                          child: TextField(
                            controller: controllers[idx],
                            maxLines: 2,
                            minLines: 1,
                            style: AppTextStyles.bodySmall,
                            decoration: InputDecoration(
                              isDense: true,
                              contentPadding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm, vertical: AppSpacing.xs),
                              border: OutlineInputBorder(borderRadius: BorderRadius.circular(AppColors.buttonRadius)),
                            ),
                          ),
                        ),
                      ],
                    );
                  },
                ),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: Text(tr('common.cancel'))),
          FilledButton.icon(
            onPressed: () => Navigator.pop(ctx, true),
            icon: const Icon(Icons.bolt_rounded, size: 16),
            label: const Text('立即重烧字幕 (5秒)'),
          ),
        ],
      ),
    );

    if (confirmed != true || !mounted) {
      for (final c in controllers) {
        c.dispose();
      }
      return;
    }

    final edits = <Map<String, dynamic>>[];
    for (var i = 0; i < items.length; i++) {
      final newText = controllers[i].text.trim();
      edits.add({
        'shotIdx': items[i]['shotIdx'],
        'text': newText,
        'speaker': items[i]['speaker'],
      });
      controllers[i].dispose();
    }

    setState(() => _reburningEp = epNo);
    _toast('正在重烧第 $epNo 集字幕…');
    try {
      final resp = await _api.dio.post(
        '/dramas/$_dramaUuid/episodes/$epNo/subtitles/reburn',
        data: {'edits': edits},
        options: Options(receiveTimeout: const Duration(minutes: 5)),
      );
      final data = _unwrap(resp);
      _toast(data is Map && data['needsRealign'] == true
          ? '字幕已重烧进成片；字数变化超阈值，精确对齐需重跑分镜'
          : '第 $epNo 集字幕已成功重烧！');
      await _loadEpisodes();
    } catch (e) {
      if (mounted) _toast('重烧失败: ${_errMsg(e)}', error: true);
    } finally {
      if (mounted) setState(() => _reburningEp = null);
    }
  }

  /// 各集分镜制作明细与操作面板
  Widget _buildEpisodesBreakdown() {
    if (_episodes.isEmpty) {
      if (_episodesLoading) {
        return Padding(
          padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm),
          child: Row(
            children: [
              SizedBox(
                width: 14, height: 14,
                child: CircularProgressIndicator(strokeWidth: 1.8, color: AppColors.primary),
              ),
              const SizedBox(width: AppSpacing.sm),
              Text('正在读取各集制作明细…', style: AppTextStyles.caption.copyWith(color: AppColors.textTertiary)),
            ],
          ),
        );
      }
      return const SizedBox.shrink();
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Icon(Icons.video_library_outlined, size: 16, color: AppColors.primary),
            const SizedBox(width: AppSpacing.sm),
            Text(
              '各集分镜明细与操作 (${_episodes.length} 集)',
              style: AppTextStyles.labelSmall.copyWith(color: AppColors.textSecondary, fontWeight: FontWeight.w700),
            ),
            const Spacer(),
            TextButton.icon(
              onPressed: () => setState(() => _episodesExpanded = !_episodesExpanded),
              icon: Icon(_episodesExpanded ? Icons.expand_less_rounded : Icons.expand_more_rounded, size: 16),
              label: Text(_episodesExpanded ? '收起' : '展开明细', style: AppTextStyles.caption),
            ),
          ],
        ),
        if (_episodesExpanded) ...[
          const SizedBox(height: AppSpacing.xs),
          for (final ep in _episodes) _buildEpisodeItemCard(ep),
        ],
      ],
    );
  }

  Widget _buildEpisodeItemCard(Map<String, dynamic> ep) {
    final epNo = (ep['epNo'] as num?)?.toInt() ?? 1;
    final title = ep['title']?.toString() ?? '第 $epNo 集';
    final sd = (ep['stepData'] as Map?)?.cast<String, dynamic>() ?? const {};
    final out5 = (sd['5'] as Map?)?['output'] as Map?;
    final out2 = (sd['2'] as Map?)?['output'] as Map?;
    final out3 = (sd['3'] as Map?)?['output'] as Map?;
    final out4 = (sd['4'] as Map?)?['output'] as Map?;

    final finalUrl = (ep['finalUrl'] ?? out5?['final_url'] ?? '').toString();
    final durationSec = (out5?['duration_sec'] as num?)?.toDouble() ?? 0.0;
    final shotCount = (out5?['shot_count'] as num?)?.toInt() ?? 0;
    final missingShots = (out5?['missing_shots'] as num?)?.toInt() ?? 0;

    final shotsList = (out2?['shots'] as List?)?.whereType<Map>().toList() ?? const [];
    final keyframesList = (out3?['keyframes'] as List?)?.whereType<Map>().toList() ?? const [];
    final kfMap = <int, String>{};
    for (final k in keyframesList) {
      if (k['url'] != null) kfMap[(k['shot_idx'] as num?)?.toInt() ?? 0] = k['url'].toString();
    }
    final videoShotsList = (out4?['shots'] as List?)?.whereType<Map>().toList() ?? const [];
    final videoMap = <int, Map<String, dynamic>>{};
    for (final v in videoShotsList) {
      if (v['shot_idx'] != null) videoMap[(v['shot_idx'] as num?)?.toInt() ?? 0] = Map<String, dynamic>.from(v);
    }

    final isExpanded = _expandedEpNo == epNo;
    final isSupplementing = _supplementingEp == epNo;
    final isReburning = _reburningEp == epNo;

    return Container(
      margin: const EdgeInsets.only(bottom: AppSpacing.sm),
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: AppColors.surfaceLight,
        borderRadius: BorderRadius.circular(AppColors.slotRadius),
        border: Border.all(
          color: missingShots > 0
              ? AppColors.danger.withValues(alpha: 0.3)
              : AppColors.border.withValues(alpha: 0.5),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(
                  color: AppColors.primary.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(AppRadius.bar),
                ),
                child: Text('EP$epNo', style: AppTextStyles.labelSmall.copyWith(color: AppColors.primary, fontWeight: FontWeight.w800)),
              ),
              const SizedBox(width: AppSpacing.sm),
              Expanded(
                child: Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: AppTextStyles.bodySmall.copyWith(fontWeight: FontWeight.w700),
                ),
              ),
              if (durationSec > 0)
                Text(
                  '${durationSec.toStringAsFixed(0)}秒 · $shotCount镜',
                  style: AppTextStyles.caption.copyWith(color: AppColors.textSecondary),
                ),
              if (missingShots > 0) ...[
                const SizedBox(width: AppSpacing.sm),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                  decoration: BoxDecoration(
                    color: AppColors.danger.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(AppRadius.bar),
                  ),
                  child: Text('缺 $missingShots 镜', style: AppTextStyles.caption.copyWith(color: AppColors.danger, fontWeight: FontWeight.w700)),
                ),
              ],
            ],
          ),
          const SizedBox(height: AppSpacing.sm),
          // 操作按钮行
          Row(
            children: [
              if (missingShots > 0)
                _GateMiniButton(
                  label: isSupplementing ? '正在补做…' : '补做缺失镜头',
                  icon: Icons.auto_fix_high_rounded,
                  color: AppColors.danger,
                  busy: isSupplementing,
                  onTap: () => _supplementEpShots(epNo),
                ),
              if (finalUrl.isNotEmpty) ...[
                if (missingShots > 0) const SizedBox(width: AppSpacing.sm),
                _GateMiniButton(
                  label: isReburning ? '重烧中…' : '微调台词',
                  icon: Icons.subtitles_outlined,
                  color: AppColors.primary,
                  busy: isReburning,
                  onTap: () => _openReburnDialog(ep),
                ),
                const SizedBox(width: AppSpacing.sm),
                _GateMiniButton(
                  label: '播放本集',
                  icon: Icons.play_arrow_rounded,
                  color: AppColors.success,
                  onTap: () => webOpenInNewTab(Uri.parse(ApiClient.resolveUrl(finalUrl))),
                ),
              ],
              const Spacer(),
              if (shotsList.isNotEmpty)
                TextButton.icon(
                  onPressed: () => setState(() => _expandedEpNo = isExpanded ? null : epNo),
                  icon: Icon(isExpanded ? Icons.keyboard_arrow_up : Icons.keyboard_arrow_down, size: 16),
                  label: Text(isExpanded ? '收起分镜' : '看分镜(${shotsList.length})', style: AppTextStyles.caption),
                ),
            ],
          ),
          // 展开分镜列表九宫格/卡片
          if (isExpanded && shotsList.isNotEmpty) ...[
            const Divider(height: AppSpacing.lg),
            for (final shot in shotsList) ...[
              _buildShotDetailRow(
                shot: Map<String, dynamic>.from(shot),
                kfUrl: kfMap[(shot['idx'] as num?)?.toInt() ?? 0],
                videoInfo: videoMap[(shot['idx'] as num?)?.toInt() ?? 0],
              ),
              const SizedBox(height: AppSpacing.sm),
            ],
          ],
        ],
      ),
    );
  }

  Widget _buildShotDetailRow({
    required Map<String, dynamic> shot,
    String? kfUrl,
    Map<String, dynamic>? videoInfo,
  }) {
    final idx = (shot['idx'] as num?)?.toInt() ?? 0;
    final shotType = (shot['shot_type'] ?? '中景').toString();
    final duration = (shot['duration_sec'] ?? 10).toString();
    final dialogue = (shot['dialogue'] ?? '').toString();
    final description = (shot['description'] ?? '').toString();
    final videoStatus = videoInfo?['status']?.toString();
    final isVideoOk = videoStatus == 'completed';
    final isVideoFailed = videoStatus == 'failed';

    return Container(
      padding: const EdgeInsets.all(AppSpacing.sm),
      decoration: BoxDecoration(
        color: AppColors.cardBg,
        borderRadius: BorderRadius.circular(AppColors.buttonRadius),
        border: Border.all(
          color: isVideoFailed
              ? AppColors.danger.withValues(alpha: 0.3)
              : AppColors.border.withValues(alpha: 0.4),
        ),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // 关键帧缩略图
          ClipRRect(
            borderRadius: BorderRadius.circular(AppRadius.bar),
            child: Container(
              width: 54, height: 72,
              color: AppColors.surfaceLight,
              child: kfUrl != null && kfUrl.isNotEmpty
                  ? Image.network(
                      ApiClient.resolveUrl(kfUrl),
                      fit: BoxFit.cover,
                      errorBuilder: (_, __, ___) => Center(
                        child: Icon(Icons.broken_image_outlined, size: 18, color: AppColors.textTertiary),
                      ),
                    )
                  : Center(
                      child: Icon(Icons.image_outlined, size: 18, color: AppColors.textTertiary),
                    ),
            ),
          ),
          const SizedBox(width: AppSpacing.sm),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Text('镜 $idx · $shotType · ${duration}s',
                        style: AppTextStyles.labelSmall.copyWith(fontWeight: FontWeight.w700)),
                    const Spacer(),
                    if (isVideoOk)
                      Icon(Icons.check_circle, size: 14, color: AppColors.success)
                    else if (isVideoFailed)
                      Text('生成失败', style: AppTextStyles.caption.copyWith(color: AppColors.danger, fontWeight: FontWeight.w700))
                    else
                      Text('待处理', style: AppTextStyles.caption.copyWith(color: AppColors.textTertiary)),
                  ],
                ),
                if (dialogue.isNotEmpty) ...[
                  const SizedBox(height: AppSpacing.xxs),
                  Text('台词: $dialogue',
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: AppTextStyles.caption.copyWith(color: AppColors.primary, fontWeight: FontWeight.w600)),
                ],
                if (description.isNotEmpty) ...[
                  const SizedBox(height: AppSpacing.xxs),
                  Text('画面: $description',
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: AppTextStyles.caption.copyWith(color: AppColors.textTertiary)),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }

  // ── 连集生产进度(门③通过后) ──────────────────────────────────────────
  Widget _buildProductionCard(Map<String, dynamic>? p) {
    final b = _batch;
    // 刷新页面后 _batch 还是空的(轮询已按 batchStatus 停了),此时退回门 payload
    // 上后端写回的终态,否则会把一个已完成的批次画成"连集生产中 EP1/1"。
    final status = (b?['status'] ?? p?['batchStatus'] ?? 'queued').toString();
    final toEp = _asInt(b?['toEp'] ?? p?['toEp']) ?? 1;
    final curEp = _asInt(b?['cursorEp']) ?? 1;
    final curStep = _asInt(b?['cursorStep']) ?? 0;
    final stepLabel = (b?['cursorStepLabel'] ?? '').toString();
    final logs = (b?['log'] as List?)?.whereType<Map>().toList() ?? const [];
    final lastLog = logs.isNotEmpty ? logs.last : null;
    // 批次也会被后端重启打断:旧任务的锁最长能占住 90 分钟,期间 DB 仍是
    // running 而进度一动不动。把"多久没动"摆出来,别让用户干等。
    // 只认日志里的 at(后端 JS 写的真 UTC);批次的 updatedAt 是 DB 本地时间,
    // 拿来相减会得到负数,宁可显示不出也别显示错的。
    // 注:上游限流退避会持续刷新心跳条目的 at,所以这里量的不是"步骤多久没完成",
    // 而是"执行者多久没发声" —— 只有进程真没了/锁真僵尸才会触发 looksStuck。
    final staleMins = _minutesSince(lastLog?['at']);
    const stepLabels = ['承接与大纲', '资产预检', '分镜脚本', '分镜关键帧', '分镜视频', '成片与状态回写'];
    // 非终态且长时间没动 = 执行者已经没了(进程重启 / 队列僵尸锁)
    final looksStuck = staleMins != null &&
        staleMins >= 10 &&
        status != 'done' &&
        status != 'cancelled';

    final (Color color, String title) = switch (status) {
      'done' => (AppColors.success, tr('novel_drama.batch_done_title', args: {'n': '$toEp'})),
      'paused' => (AppColors.warning, tr('novel_drama.batch_paused_title')),
      'failed' => (AppColors.danger,
          tr('novel_drama.batch_failed', args: {'reason': (b?['error'] ?? p?['batchError'] ?? tr('novel_drama.see_drama_detail')).toString()})),
      'cancelled' => (AppColors.textTertiary, tr('novel_drama.batch_cancelled_title')),
      _ => (AppColors.primary,
          '连集生产中:EP$curEp/$toEp · ${stepLabel.isNotEmpty ? stepLabel : (curStep >= 0 && curStep < 6 ? stepLabels[curStep] : '')}'),
    };
    final double? value = status == 'done'
        ? 1.0
        : toEp > 0
            ? (((curEp - 1) * 6 + curStep + (status == 'running' ? 0 : 1)) /
                    (toEp * 6))
                .clamp(0.0, 1.0)
            : null;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Icon(Icons.smart_display_rounded, size: 18, color: color),
            const SizedBox(width: AppSpacing.sm),
            Expanded(child: Text(title, style: AppTextStyles.bodyMedium.copyWith(color: color))),
          ],
        ),
        const SizedBox(height: AppSpacing.md),
        ClipRRect(
          borderRadius: BorderRadius.circular(AppColors.thumbRadius),
          child: LinearProgressIndicator(
            value: value,
            minHeight: 6,
            backgroundColor: AppColors.surfaceLight,
            color: color,
          ),
        ),
        if (status != 'done' && lastLog != null) ...[
          const SizedBox(height: AppSpacing.sm),
          Text(
            'EP${lastLog['ep']} ${(lastLog['msg'] ?? '').toString()}',
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: AppTextStyles.labelSmall.copyWith(color: AppColors.textTertiary),
          ),
        ],
        if (logs.isNotEmpty) ...[
          const SizedBox(height: AppSpacing.sm),
          // 2026-09-16(批3 透明工作台):批次全时间线 —— 之前只取 log.last,
          // 用户看不到"每集哪步失败/为什么/烧了多少分";现在全量可展开倒序核对。
          Theme(
            data: ThemeData(dividerColor: Colors.transparent),
            child: ExpansionTile(
              tilePadding: EdgeInsets.zero,
              childrenPadding: const EdgeInsets.only(bottom: AppSpacing.sm),
              title: Text(tr('novel_drama.timeline_title', args: {'n': '${logs.length}'}),
                  style: AppTextStyles.labelSmall.copyWith(color: AppColors.textSecondary)),
              children: [
                ...logs.reversed.map((l) {
                  final ok = l['ok'] == true;
                  final at = (l['at'] ?? '').toString();
                  final hhmm = at.length >= 16 ? at.substring(11, 16) : '';
                  final credits = (l['credits'] as num?) ?? 0;
                  return Padding(
                    padding: const EdgeInsets.only(bottom: AppSpacing.xs),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Icon(ok ? Icons.check_circle_outline : Icons.error_outline,
                            size: 13, color: ok ? AppColors.success : AppColors.danger),
                        const SizedBox(width: AppSpacing.sm),
                        Expanded(
                          child: Text(
                            '${tr('novel_drama.timeline_entry', args: {'ep': '${l['ep']}', 'step': '${(_asInt(l['step']) ?? 0) + 1}', 'msg': '${l['msg'] ?? ''}'})}${credits > 0 ? tr('novel_drama.credits_unit', args: {'n': '$credits'}) : ''}${hhmm.isNotEmpty ? ' · $hhmm' : ''}',
                            style: AppTextStyles.labelSmall.copyWith(
                                fontSize: 10,
                                color: ok ? AppColors.textSecondary : AppColors.danger),
                          ),
                        ),
                      ],
                    ),
                  );
                }),
              ],
            ),
          ),
        ],
        if (looksStuck) ...[
          const SizedBox(height: AppSpacing.md),
          Text(
            tr('novel_drama.batch_stale_note', args: {'n': '$staleMins'}),
            style: AppTextStyles.labelSmall.copyWith(color: AppColors.warning),
          ),
          const SizedBox(height: AppSpacing.sm),
          _GateMiniButton(
            label: tr('novel_drama.toast_unresponsive_resume'),
            icon: Icons.refresh_rounded,
            color: AppColors.textSecondary,
            busy: _deciding,
            onTap: _resumeBatch,
          ),
        ],
        if (status == 'paused' || status == 'failed') ...[
          const SizedBox(height: AppSpacing.md),
          _GateMiniButton(
            label: status == 'paused' ? tr('novel_drama.resume_btn') : tr('novel_drama.retry_batch_btn'),
            icon: Icons.play_arrow_rounded,
            color: AppColors.primary,
            busy: _deciding,
            onTap: _resumeBatch,
          ),
        ],
        const SizedBox(height: AppSpacing.md),
        _buildEpisodesBreakdown(),
        // ── 就地控制(2026-09-15) ───────────────────────────────────────
        // 以前这四个动作散在剧集详情页与剧集列表页,而工作台正是用户盯着进度
        // 的那一屏 —— 想暂停得先离开正在看的进度。运行中给「暂停 / 取消」,
        // 任何状态都给「看成片」(失败的批次也可能已经出了前几集的成片,
        // 那是烧过配额的,入口不能藏)与「删除项目」(带二次确认)。
        const SizedBox(height: AppSpacing.md),
        Row(
          children: [
            if (status == 'running' || status == 'queued') ...[
              Expanded(
                child: _GateMiniButton(
                  label: tr('common.pause'),
                  icon: Icons.pause_rounded,
                  color: AppColors.warning,
                  busy: _projectBusy,
                  onTap: () => _setBatchStatus('paused', tr('novel_drama.toast_batch_paused')),
                ),
              ),
              const SizedBox(width: AppSpacing.sm),
              Expanded(
                child: _GateMiniButton(
                  label: tr('novel_drama.cancel_production'),
                  icon: Icons.stop_rounded,
                  color: AppColors.danger,
                  busy: _projectBusy,
                  onTap: _confirmCancelBatch,
                ),
              ),
              const SizedBox(width: AppSpacing.sm),
            ],
            Expanded(
              child: _GateMiniButton(
                label: _playing ? tr('novel_drama.opening') : tr('novel_drama.view_film_btn'),
                icon: Icons.play_circle_outline_rounded,
                color: AppColors.success,
                busy: _playing,
                onTap: _playFinal,
              ),
            ),
          ],
        ),
        const SizedBox(height: AppSpacing.md),
        Row(
          children: [
            Expanded(
              flex: 2,
              child: WbSubmitButton(
                label: tr('novel_drama.open_drama_detail'),
                icon: Icons.open_in_new_rounded,
                onTap: _openDramaDetail,
              ),
            ),
            const SizedBox(width: AppSpacing.sm),
            Expanded(
              child: _GateMiniButton(
                label: tr('novel_drama.delete_project'),
                icon: Icons.delete_outline_rounded,
                color: AppColors.danger,
                busy: _projectBusy,
                onTap: _deleteProject,
              ),
            ),
          ],
        ),
      ],
    );
  }

  /// 取消生产要二次确认:取消是终态,不会自动续跑,而已经烧掉的配额不会退回。
  Future<void> _confirmCancelBatch() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(tr('novel_drama.cancel_production')),
        content: Text(tr('novel_drama.dialog_cancel_body')),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text(tr('novel_drama.think_again')),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: TextButton.styleFrom(foregroundColor: AppColors.danger),
            child: Text(tr('novel_drama.cancel_production')),
          ),
        ],
      ),
    );
    if (ok != true) return;
    await _setBatchStatus('cancelled', tr('novel_drama.toast_batch_cancelled'));
  }

  // ── 阶段卡片小组件 ────────────────────────────────────────────────────
  Widget _stageCard({
    required IconData icon,
    required String title,
    required String gateStatus,
    required List<Widget> body,
  }) {
    return Container(
      padding: const EdgeInsets.all(AppSpacing.lg),
      decoration: BoxDecoration(
        color: AppColors.cardBg,
        borderRadius: BorderRadius.circular(AppColors.cardRadius),
        border: Border.all(color: AppColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, size: 18, color: AppColors.primary),
              const SizedBox(width: AppSpacing.sm),
              Expanded(child: Text(title, style: AppTextStyles.titleSmall)),
              _GateStatusChip(status: gateStatus),
            ],
          ),
          const SizedBox(height: AppSpacing.md),
          ...body,
        ],
      ),
    );
  }

  Widget _stageHint(IconData icon, Color color, String text) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, size: 18, color: color),
        const SizedBox(width: AppSpacing.sm),
        Expanded(
          child: Text(text,
              style: AppTextStyles.bodySmall.copyWith(color: AppColors.textSecondary)),
        ),
      ],
    );
  }

  /// 「已驳回」区块:说明 + 当时的驳回备注 + 「重新打开此门」。
  ///
  /// 三个门共用。驳回是可撤销的(后端 `gates/:gate/reopen`),所以这里必须
  /// 给出按钮 —— 2026-09-15 之前三个门的 rejected 分支都只有一行文字,用户
  /// 唯一的出路是删掉整个项目,而"驳回"本意只是"这次不满意,我调一下再来"。
  ///
  /// 备注来自后端 decideGate 落库的 `rejectedNote`:reopen 之后它会保留,
  /// 用户能看见自己当初为什么否掉,否则"改回待确认"会丢掉唯一一条上下文。
  Widget _rejectedBlock(String gateKey, String text) {
    final note = _gatePayload(gateKey)?['rejectedNote']?.toString();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _stageHint(Icons.block_rounded, AppColors.danger, text),
        if (note != null && note.trim().isNotEmpty) ...[
          const SizedBox(height: AppSpacing.sm),
          Text(tr('novel_drama.reject_note', args: {'note': note}),
              style: AppTextStyles.labelSmall
                  .copyWith(color: AppColors.textTertiary)),
        ],
        const SizedBox(height: AppSpacing.md),
        WbSubmitButton(
          label: tr('novel_drama.reopen_gate_btn'),
          loadingLabel: tr('novel_drama.submitting'),
          icon: Icons.lock_open_rounded,
          loading: _deciding,
          disabled: _deciding,
          onTap: () => _reopenGate(gateKey),
        ),
      ],
    );
  }

  Widget _stageSpinner(String text) {
    return Row(
      children: [
        // AppColors.* 是 static late 非 const,这里不能包 const(仓库已知坑 #2)
        SizedBox(
          width: AppSpacing.lg, height: AppSpacing.lg,
          child: CircularProgressIndicator(strokeWidth: 2.2, color: AppColors.primary),
        ),
        const SizedBox(width: AppSpacing.md),
        Expanded(
          child: Text(text,
              style: AppTextStyles.bodySmall.copyWith(color: AppColors.textSecondary)),
        ),
      ],
    );
  }

  Widget _assetSummary(Map<String, dynamic> p) {
    String names(String key) {
      final list = (p[key] as List?)?.whereType<Map>().toList() ?? const [];
      if (list.isEmpty) return '—';
      final s = list.map((x) => (x['name'] ?? '').toString()).join('、');
      return s.length > 90 ? '${s.substring(0, 90)}…' : s;
    }

    final rows = <Widget>[
      _assetRow(Icons.person_outline, tr('novel_drama.asset_characters'), names('characters')),
      _assetRow(WorkbenchIcons.scene, tr('novel_drama.asset_locations'), names('locations')),
      _assetRow(WorkbenchIcons.prop, tr('novel_drama.asset_props'), names('props')),
    ];
    return Container(
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: AppColors.surfaceLight,
        borderRadius: BorderRadius.circular(AppColors.slotRadius),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (var i = 0; i < rows.length; i++) ...[
            if (i > 0) const SizedBox(height: AppSpacing.sm),
            rows[i],
          ],
        ],
      ),
    );
  }

  Widget _assetRow(IconData icon, String label, String value) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, size: 14, color: AppColors.textSecondary),
        const SizedBox(width: AppSpacing.sm),
        Text('$label:', style: AppTextStyles.labelSmall.copyWith(color: AppColors.textTertiary)),
        const SizedBox(width: AppSpacing.sm),
        Expanded(
          child: Text(value,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: AppTextStyles.bodySmall),
        ),
      ],
    );
  }

  /// 门② 的定妆状态条。按后端批次状态给四种口径,绝不谎报:
  ///   running          → 进度条 + done/total + 去资产库查看
  ///   终态但仍有待定妆  → 失败项与原因直接摊开 + 去资产库重试
  ///   全部就绪          → 一句成功确认(关键帧会走图生图)
  ///   还没开跑(idle)    → 说明「确认设定后自动开始批量定妆」+ 想去就去的入口
  /// 资产还没拉回来时只报「读取中」—— 空列表不等于「都已定妆」。
  Widget _portraitNotice() {
    final items =
        (_portrait['items'] as List?)?.whereType<Map>().toList() ?? const [];
    final running = '${_portrait['status'] ?? 'idle'}' == 'running';
    final total = _asInt(_portrait['total']) ?? 0;
    final done = _asInt(_portrait['done']) ?? 0;
    final failed = items.where((i) => i['state'] == 'failed').toList();
    final undressed = _undressedAssets;

    if (running) {
      final settled = total > 0 ? ((done + failed.length) / total) : 0.0;
      return _portraitCard(
        AppColors.primary, Icons.auto_awesome,
        tr('novel_drama.dressing_running', args: {'done': '$done', 'total': '$total'}),
        children: [
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
          Text(tr('novel_drama.dressing_note'),
              style: AppTextStyles.bodySmall
                  .copyWith(color: AppColors.textSecondary, height: 1.55)),
          const SizedBox(height: AppSpacing.md),
          _GateMiniButton(
            label: tr('novel_drama.goto_assets_btn'),
            icon: Icons.palette_outlined,
            color: AppColors.primary,
            onTap: _openAssetsTab,
          ),
        ],
      );
    }

    if (!_assetsLoaded || _assets.isEmpty) {
      return _stageHint(Icons.hourglass_empty_rounded,
          AppColors.textTertiary, tr('novel_drama.loading_assets'));
    }

    if (undressed.isEmpty) {
      return _stageHint(Icons.brush_rounded, AppColors.success,
          tr('novel_drama.dressing_ready', args: {'n': '${_assets.length}'}));
    }

    final names = undressed
        .map((a) => (a['name'] ?? a['slug'] ?? '').toString())
        .where((x) => x.isNotEmpty)
        .toList();
    final head = names.isEmpty
        ? ''
        : '${names.take(4).join('、')}${names.length > 4 ? tr('novel_drama.and_more') : ''} —— ';

    if (failed.isNotEmpty) {
      return _portraitCard(
        AppColors.danger, Icons.error_outline_rounded,
        tr('novel_drama.dressing_failed', args: {'n': '${undressed.length}'}),
        children: [
          const SizedBox(height: AppSpacing.sm),
          for (final f in failed.take(4))
            Text(tr('novel_drama.dressing_fail_line', args: {'name': '${f['name'] ?? ''}', 'error': '${f['error'] ?? tr('novel_drama.unknown_reason')}'}),
                style: AppTextStyles.labelSmall
                    .copyWith(color: AppColors.danger, height: 1.5)),
          const SizedBox(height: AppSpacing.sm),
          Text(tr('novel_drama.dressing_retry_hint', args: {'n': '${undressed.length}'}),
              style: AppTextStyles.bodySmall
                  .copyWith(color: AppColors.textSecondary, height: 1.55)),
          const SizedBox(height: AppSpacing.md),
          _GateMiniButton(
            label: tr('novel_drama.goto_assets_retry_btn'),
            icon: Icons.refresh_rounded,
            color: AppColors.danger,
            onTap: _openAssetsTab,
          ),
        ],
      );
    }

    return _portraitCard(
      AppColors.warning, Icons.auto_awesome,
      tr('novel_drama.dressing_pending', args: {'n': '${undressed.length}'}),
      children: [
        const SizedBox(height: AppSpacing.sm),
        Text('$head${tr('novel_drama.dressing_auto_note')}',
            style: AppTextStyles.bodySmall
                .copyWith(color: AppColors.textSecondary, height: 1.55)),
        const SizedBox(height: AppSpacing.md),
        // 竖排而不是横排 Row:这个状态没被视觉回归覆盖,窄屏下赌宽度不值当
        _GateMiniButton(
          label: _assetsLoading ? tr('novel_drama.loading_assets_short') : tr('novel_drama.goto_assets_preview'),
          icon: Icons.palette_outlined,
          color: AppColors.warning,
          busy: _assetsLoading,
          onTap: _openAssetsTab,
        ),
        const SizedBox(height: AppSpacing.sm),
        Text(tr('novel_drama.dressing_auto_hint'),
            style: AppTextStyles.labelSmall
                .copyWith(color: AppColors.textTertiary, height: 1.5)),
      ],
    );
  }

  /// 定妆状态条外壳(颜色 + 图标 + 标题由调用方给,内容列自由展开)
  Widget _portraitCard(Color color, IconData icon, String title,
      {required List<Widget> children}) {
    return Container(
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(AppColors.cardRadius),
        border: Border.all(color: color.withValues(alpha: 0.35)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, size: 18, color: color),
              const SizedBox(width: AppSpacing.sm),
              Expanded(
                child: Text(title,
                    style: AppTextStyles.bodyMedium.copyWith(
                        color: color, fontWeight: FontWeight.w800)),
              ),
            ],
          ),
          ...children,
        ],
      ),
    );
  }

  Widget _episodeSummary(Map<String, dynamic> p) {
    final eps = (p['episodes'] as List?)?.whereType<Map>().toList() ?? const [];
    final failed = (p['failedEps'] as List?)?.whereType<Map>().toList() ?? const [];
    final shown = eps.take(6).toList();
    return Container(
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: AppColors.surfaceLight,
        borderRadius: BorderRadius.circular(AppColors.slotRadius),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final e in shown)
            Padding(
              padding: const EdgeInsets.only(bottom: AppSpacing.xs),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('EP${e['epNo']}',
                      style: AppTextStyles.labelSmall
                          .copyWith(color: AppColors.primary, fontWeight: FontWeight.w800)),
                  const SizedBox(width: AppSpacing.sm),
                  Expanded(
                    child: Text(
                      tr('novel_drama.auto_002', args: {'title': "${e['title'] ?? ''}", 'scenes': "${e['scenes'] ?? 0}", 'hook': ((e['hookOut'] ?? '').toString().isNotEmpty ? tr('novel_drama.hook_suffix', args: {'text': (e['hookOut']).toString()}) : '')}),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: AppTextStyles.bodySmall,
                    ),
                  ),
                ],
              ),
            ),
          if (eps.length > shown.length)
            Text(tr('novel_drama.eps_total', args: {'n': '${eps.length}'}),
                style: AppTextStyles.labelSmall.copyWith(color: AppColors.textTertiary)),
          if (failed.isNotEmpty)
            Text(tr('novel_drama.outline_failed', args: {'n': '${failed.length}', 'eps': failed.map((f) => 'EP${f['ep']}').join('、')}),
                style: AppTextStyles.labelSmall.copyWith(color: AppColors.warning)),
        ],
      ),
    );
  }

  Map<String, dynamic>? _gateOf(String gate) {
    final gates = (_ledger!['gates'] as List?)
        ?.whereType<Map>()
        .map((g) => Map<String, dynamic>.from(g));
    for (final g in gates ?? const Iterable<Map<String, dynamic>>.empty()) {
      if (g['gate'] == gate) return g;
    }
    return null;
  }
}

// ─── 小组件 ─────────────────────────────────────────────────────────────

class _StatCell extends StatelessWidget {
  final String label;
  final String value;
  const _StatCell({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label,
            style: AppTextStyles.labelSmall
                .copyWith(color: AppColors.textTertiary)),
        const SizedBox(height: AppSpacing.xs),
        Text(value,
            style: AppTextStyles.titleSmall
                .copyWith(
                    color: AppColors.primary, fontWeight: FontWeight.w900)),
      ],
    );
  }
}

class _GateStatusChip extends StatelessWidget {
  final String status;
  const _GateStatusChip({required this.status});

  @override
  Widget build(BuildContext context) {
    final (text, color) = switch (status) {
      'waiting' => (tr('novel_drama.chip_waiting'), AppColors.warning),
      'passed' => (tr('novel_drama.gate_passed'), AppColors.success),
      'rejected' => (tr('novel_drama.chip_rejected'), AppColors.danger),
      _ => (status, AppColors.textTertiary),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md, vertical: AppSpacing.xs),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(AppRadius.pill),
        border: Border.all(color: color.withValues(alpha: 0.4)),
      ),
      child: Text(text,
          style: AppTextStyles.labelSmall.copyWith(color: color)),
    );
  }
}

class _GateStatusDot extends StatelessWidget {
  final String status;
  const _GateStatusDot({required this.status});

  @override
  Widget build(BuildContext context) {
    final color = switch (status) {
      'waiting' => AppColors.warning,
      'passed' => AppColors.success,
      'rejected' => AppColors.danger,
      _ => AppColors.textTertiary,
    };
    return Container(
      width: 10,
      height: 10,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: color.withValues(alpha: 0.9),
      ),
    );
  }
}

/// 门卡片内的次级操作按钮(描边小按钮;主操作用 WbSubmitButton)
class _GateMiniButton extends StatelessWidget {
  final String label;
  final IconData? icon;
  final Color color;
  final bool busy;
  final VoidCallback? onTap;

  const _GateMiniButton({
    required this.label,
    required this.color,
    this.icon,
    this.busy = false,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final active = !busy && onTap != null;
    return InkWell(
      onTap: active ? onTap : null,
      borderRadius: BorderRadius.circular(AppColors.cardRadius),
      child: Container(
        height: 46,
        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.06),
          borderRadius: BorderRadius.circular(AppColors.cardRadius),
          border: Border.all(color: color.withValues(alpha: 0.45)),
        ),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            if (busy)
              SizedBox(
                width: AppSpacing.lg,
                height: AppSpacing.lg,
                child: CircularProgressIndicator(strokeWidth: 2, color: color),
              )
            else if (icon != null)
              Icon(icon, size: 16, color: color),
            const SizedBox(width: AppSpacing.sm),
            Flexible(
              child: Text(
                label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: AppTextStyles.labelSmall
                    .copyWith(color: color, fontWeight: FontWeight.w700),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
