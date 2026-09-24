import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import { setupRouterGuard } from './guard'

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('@/views/login/Index.vue'),
    meta: { title: '登录', public: true },
  },
  {
    path: '/',
    component: () => import('@/layouts/AdminLayout.vue'),
    redirect: '/dashboard',
    children: [
      {
        path: 'dashboard',
        name: 'Dashboard',
        component: () => import('@/views/dashboard/Index.vue'),
        meta: { title: '仪表盘', icon: 'DataAnalysis' },
      },
      // 用户与认证
      {
        path: 'users',
        name: 'Users',
        component: () => import('@/views/users/Index.vue'),
        meta: { title: '用户管理', icon: 'User' },
      },
      {
        path: 'users/:id',
        name: 'UserDetail',
        component: () => import('@/views/users/Detail.vue'),
        meta: { title: '用户详情', icon: 'User', hidden: true },
      },
      {
        path: 'verifications',
        name: 'Verifications',
        component: () => import('@/views/verifications/Index.vue'),
        meta: { title: '实名认证', icon: 'Avatar' },
      },
      // Agent 审核 / 管理
      {
        path: 'agents/audit',
        name: 'AgentAudit',
        component: () => import('@/views/agents/Audit.vue'),
        meta: { title: 'Agent 审核', icon: 'Box' },
      },
      {
        path: 'agents/manage',
        name: 'AgentsManage',
        component: () => import('@/views/agents/Manage.vue'),
        meta: { title: 'Agent 管理', icon: 'Goods' },
      },
      {
        path: 'agents/publish',
        name: 'AgentPublish',
        component: () => import('@/views/agents/Publish.vue'),
        meta: { title: '平台发布 Agent', icon: 'Promotion' },
      },
      {
        path: 'agent-upstream',
        name: 'AgentUpstream',
        component: () => import('@/views/agent-upstream/Index.vue'),
        meta: { title: '上游仓库管理', icon: 'Connection' },
      },
      // 沙盒测试管理(高级 agent 自动 + 管理员手动跑/通过)
      {
        path: 'sandbox',
        name: 'SandboxTest',
        component: () => import('@/views/sandbox/Index.vue'),
        meta: { title: '沙盒测试管理', icon: 'VideoPlay' },
      },
      {
        path: 'tasks',
        name: 'Tasks',
        component: () => import('@/views/tasks/Index.vue'),
        meta: { title: '任务监管', icon: 'List' },
      },
      // 剧集运维(2026-09-24):按 drama uuid 查集/缺镜/批次,一键补做
      {
        path: 'dramas',
        name: 'Dramas',
        component: () => import('@/views/dramas/Index.vue'),
        meta: { title: '剧集运维', icon: 'Film' },
      },
      // 作品(产物)审核 — 用户作品 App 端仅本人可见,后台全量可见
      {
        path: 'artifacts',
        name: 'Artifacts',
        component: () => import('@/views/artifacts/Index.vue'),
        meta: { title: '作品审核', icon: 'Files' },
      },
      // 订单
      {
        path: 'orders',
        name: 'Orders',
        component: () => import('@/views/orders/Index.vue'),
        meta: { title: '订单管理', icon: 'ShoppingCart' },
      },
      // 流水
      {
        path: 'transactions',
        name: 'Transactions',
        component: () => import('@/views/transactions/Index.vue'),
        meta: { title: '资金流水', icon: 'Tickets' },
      },
      // 提现
      {
        path: 'withdrawals/audit',
        name: 'WithdrawalAudit',
        component: () => import('@/views/withdrawals/Audit.vue'),
        meta: { title: '提现审核', icon: 'Wallet' },
      },
      // 渠道退款队列(2026-08-29 F4:现金订单原路退款)
      {
        path: 'refunds',
        name: 'ChannelRefunds',
        component: () => import('@/views/refunds/Index.vue'),
        meta: { title: '渠道退款', icon: 'RefreshLeft' },
      },
      // 邀请增长(2026-08-30 P1)
      {
        path: 'invites',
        name: 'Invites',
        component: () => import('@/views/invites/Index.vue'),
        meta: { title: '邀请增长', icon: 'Connection' },
      },
      // 红包 / Banner / 公告
      {
        path: 'redpackets',
        name: 'RedPackets',
        component: () => import('@/views/redpackets/Index.vue'),
        meta: { title: '红包活动', icon: 'Money' },
      },
      {
        path: 'redeem-codes',
        name: 'RedeemCodes',
        component: () => import('@/views/redeem-codes/Index.vue'),
        meta: { title: '兑换码管理', icon: 'Ticket' },
      },
      {
        path: 'banners',
        name: 'Banners',
        component: () => import('@/views/banners/Index.vue'),
        meta: { title: 'Banner 管理', icon: 'Picture' },
      },
      {
        path: 'announcements',
        name: 'Announcements',
        component: () => import('@/views/announcements/Index.vue'),
        meta: { title: '系统公告', icon: 'Bell' },
      },
      // 数据分析 / 配置
      {
        path: 'analytics',
        name: 'Analytics',
        component: () => import('@/views/analytics/Index.vue'),
        meta: { title: '数据分析', icon: 'TrendCharts' },
      },
      // Skill / Runtime 管理(对接后端 /api/skills 与 runtime 状态)
      {
        path: 'skills',
        name: 'Skills',
        component: () => import('@/views/skills/Index.vue'),
        meta: { title: 'Skill 管理', icon: 'Cpu' },
      },
      {
        path: 'runtime',
        name: 'Runtime',
        component: () => import('@/views/runtime/Index.vue'),
        meta: { title: 'Runtime 监控', icon: 'Monitor' },
      },
      {
        path: 'agent-dependencies',
        name: 'AgentDependencies',
        component: () => import('@/views/agent-dependencies/Index.vue'),
        meta: { title: 'A2A 调用依赖', icon: 'Share' },
      },
      {
        path: 'agent-invocations',
        name: 'AgentInvocations',
        component: () => import('@/views/agent-invocations/Index.vue'),
        meta: { title: 'A2A 调用审计', icon: 'Histogram' },
      },
      {
        path: 'config',
        name: 'PlatformConfig',
        component: () => import('@/views/config/Index.vue'),
        meta: { title: '平台配置', icon: 'Setting' },
      },
      {
        path: 'packaging',
        name: 'Packaging',
        component: () => import('@/views/packaging/Index.vue'),
        meta: { title: '一键打包', icon: 'Box' },
      },
      {
        path: 'agreements',
        name: 'Agreements',
        component: () => import('@/views/agreements/Index.vue'),
        meta: { title: '协议管理', icon: 'Document' },
      },
    ],
  },
  {
    path: '/403',
    name: 'Forbidden',
    component: () => import('@/views/error/403.vue'),
    meta: { title: '无权限', public: true },
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'NotFound',
    component: () => import('@/views/error/404.vue'),
    meta: { title: '页面不存在', public: true },
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

setupRouterGuard(router)

export default router
