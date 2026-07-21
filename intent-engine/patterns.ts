/**
 * Claw Task Service — Intent Patterns (Phase 2.5)
 *
 * Complete rule definitions for task management intent classification.
 * 22 rules across 6 intent categories, 44+ trigger words, 22 sub-categories.
 *
 * Based on: claw-task-intent-rules.md (v1.0, 2026-07-06)
 */

import { ClassificationRule } from './types';

// ─── Rule Library ──────────────────────────────────────────────────

export const RULES: ClassificationRule[] = [

  // ═══════════════════════════════════════════════════════════════════
  // 1. create_task (5 rules, 8 triggers, priority range: 82-88)
  // ═══════════════════════════════════════════════════════════════════

  {
    id: 'create-task-explicit',
    category: 'create_task',
    subCategory: 'general',
    priority: 85,
    conditions: [
      { type: 'keyword', value: '创建', weight: 1.0 },
      { type: 'keyword', value: '新建', weight: 0.95 },
      { type: 'keyword', value: '添加', weight: 0.9 },
      { type: 'keyword', value: '加一个', weight: 0.85 },
      { type: 'keyword', value: '帮我建立', weight: 0.9 },
      { type: 'keyword', value: '建立', weight: 0.75 },
      { type: 'keyword', value: '起一个', weight: 0.7 },
    ],
    confidence: 0.90,
    minConfidence: 0.6,
    rationale: 'Explicit task creation keyword detected',
  },

  {
    id: 'create-task-with-deadline',
    category: 'create_task',
    subCategory: 'general',
    priority: 87,
    conditions: [
      { type: 'regex', value: '帮我在.{1,20}前|在.{1,20}之前|在.{1,20}前', weight: 1.0, required: true },
      { type: 'keyword', value: '完成', weight: 0.8 },
      { type: 'keyword', value: '搞定', weight: 0.7 },
      { type: 'keyword', value: '做', weight: 0.6 },
    ],
    confidence: 0.92,
    minConfidence: 0.7,
    rationale: 'Task creation with explicit deadline constraint',
  },

  {
    id: 'create-task-bugfix',
    category: 'create_task',
    subCategory: 'bugfix',
    priority: 93,
    conditions: [
      { type: 'keyword', value: 'bug', weight: 0.9 },
      { type: 'keyword', value: '修复', weight: 0.9 },
      { type: 'keyword', value: '崩溃', weight: 0.8 },
      { type: 'keyword', value: '报错', weight: 0.8 },
      { type: 'negation', value: '查询', weight: 0 },
      // Must NOT contain pure debug signals without task creation context
      { type: 'negation', value: '页面崩溃', weight: 0 },
      { type: 'negation', value: '了，', weight: 0 },
      // Suppress when '删除' is present (delete_task takes precedence)
      { type: 'negation', value: '删除', weight: 0 },
      { type: 'negation', value: '删掉', weight: 0 },
      // Suppress standalone '修复这个bug' or '修复bug' (no task creation context)
      // — dev-bugfix should handle those cases
      { type: 'negation', value: '这个bug', weight: 0 },
    ],
    confidence: 0.91,
    minConfidence: 0.65,
    rationale: 'Bug fix task creation detected',
  },

  {
    id: 'create-task-feature',
    category: 'create_task',
    subCategory: 'feature',
    priority: 88,
    conditions: [
      { type: 'keyword', value: '开发', weight: 0.9 },
      { type: 'keyword', value: '功能', weight: 0.85 },
      { type: 'keyword', value: '新增', weight: 0.75 },
      // '实现' is a development verb, not a task creation signal — removed to avoid false match
    ],
    confidence: 0.88,
    minConfidence: 0.6,
    rationale: 'Feature development task creation detected',
  },

  {
    id: 'create-task-doc',
    category: 'create_task',
    subCategory: 'doc',
    priority: 86,
    conditions: [
      { type: 'keyword', value: '写', weight: 0.7 },
      { type: 'keyword', value: '文档', weight: 0.9 },
      { type: 'keyword', value: '整理', weight: 0.6 },
      // '写文档' is a task creation signal; suppress when it's purely a design action
      { type: 'negation', value: '设计接口', weight: 0 },
      { type: 'negation', value: '接口定义', weight: 0 },
    ],
    confidence: 0.85,
    minConfidence: 0.6,
    rationale: 'Documentation task creation detected',
  },

  // ═══════════════════════════════════════════════════════════════════
  // 2. query_status (4 rules, 9 triggers, priority range: 74-78)
  // ═══════════════════════════════════════════════════════════════════

  {
    id: 'query-single-task',
    category: 'query_status',
    subCategory: 'single',
    priority: 78,
    conditions: [
      { type: 'phrase', value: '怎么样了', weight: 1.0 },
      { type: 'phrase', value: '进展如何', weight: 0.9 },
      { type: 'keyword', value: '进度', weight: 0.9 },
      { type: 'keyword', value: '状态', weight: 0.8 },
      { type: 'negation', value: '创建', weight: 0 },
      { type: 'negation', value: '改', weight: 0 },
    ],
    confidence: 0.88,
    minConfidence: 0.65,
    rationale: 'Single task status query detected',
  },

  {
    id: 'query-all-tasks',
    category: 'query_status',
    subCategory: 'all',
    priority: 76,
    conditions: [
      { type: 'phrase', value: '有哪些任务', weight: 1.0 },
      { type: 'phrase', value: '我的任务', weight: 1.0 },
      { type: 'phrase', value: '所有任务', weight: 0.9 },
      { type: 'keyword', value: '全部', weight: 0.7 },
      { type: 'keyword', value: '有哪些', weight: 0.85 },
    ],
    confidence: 0.90,
    minConfidence: 0.7,
    rationale: 'List/query all tasks detected',
  },

  {
    id: 'query-filtered-tasks',
    category: 'query_status',
    subCategory: 'filtered',
    priority: 79,
    conditions: [
      { type: 'phrase', value: '有哪些任务', weight: 0.85 },
      { type: 'keyword', value: '查询', weight: 0.8 },
      { type: 'keyword', value: 'P0', weight: 0.7 },
      { type: 'keyword', value: '待办', weight: 0.75 },
      { type: 'keyword', value: '进行中', weight: 0.75 },
      { type: 'keyword', value: '查看', weight: 0.8 },
      { type: 'regex', value: 'P[0-3]\\s*(级别|等级|优先)', weight: 0.95 },
    ],
    confidence: 0.86,
    minConfidence: 0.6,
    rationale: 'Filtered task query detected',
  },

  {
    id: 'query-summary',
    category: 'query_status',
    subCategory: 'summary',
    priority: 74,
    conditions: [
      { type: 'phrase', value: '完成了几个', weight: 1.0 },
      { type: 'phrase', value: '还有多少', weight: 0.9 },
      { type: 'keyword', value: '统计', weight: 0.85 },
      { type: 'keyword', value: '总结', weight: 0.7 },
      { type: 'keyword', value: '还有', weight: 0.65 },
      { type: 'keyword', value: '还有什么', weight: 0.8 },
    ],
    confidence: 0.87,
    minConfidence: 0.65,
    rationale: 'Task summary/statistics query detected',
  },

  // ═══════════════════════════════════════════════════════════════════
  // 3. modify_task (5 rules, 11 triggers, priority range: 78-84)
  // ═══════════════════════════════════════════════════════════════════

  {
    id: 'modify-deadline',
    category: 'modify_task',
    subCategory: 'deadline',
    priority: 82,
    conditions: [
      { type: 'keyword', value: '改到', weight: 0.9 },
      { type: 'keyword', value: '截止', weight: 0.9 },
      { type: 'keyword', value: '延期', weight: 0.9 },
      { type: 'keyword', value: '提前', weight: 0.85 },
      { type: 'regex', value: '(\\d+).{0,4}(点|号|日|周|月)', weight: 0.8 },
    ],
    confidence: 0.90,
    minConfidence: 0.65,
    rationale: 'Deadline modification detected',
  },

  {
    id: 'modify-priority',
    category: 'modify_task',
    subCategory: 'priority',
    priority: 84,
    conditions: [
      { type: 'keyword', value: '提升到', weight: 1.0 },
      { type: 'keyword', value: '降低到', weight: 0.9 },
      { type: 'phrase', value: '优先级', weight: 1.0 },
      { type: 'keyword', value: '改成P', weight: 0.85 },
      { type: 'regex', value: 'P[0-3]', weight: 0.8 },
    ],
    confidence: 0.92,
    minConfidence: 0.7,
    rationale: 'Priority modification detected',
  },

  {
    id: 'modify-assignee',
    category: 'modify_task',
    subCategory: 'assignee',
    priority: 83,
    conditions: [
      { type: 'keyword', value: '转给', weight: 1.0, required: true },
      { type: 'keyword', value: '分配', weight: 0.7 },
      { type: 'keyword', value: '负责', weight: 0.6 },
      { type: 'keyword', value: '交给', weight: 0.7 },
    ],
    confidence: 0.93,
    minConfidence: 0.75,
    rationale: 'Assignee reassignment detected',
  },

  {
    id: 'modify-status',
    category: 'modify_task',
    subCategory: 'status',
    priority: 81,
    conditions: [
      { type: 'keyword', value: '标记为', weight: 1.0 },
      { type: 'keyword', value: '已完成', weight: 0.9 },
      { type: 'keyword', value: '完成', weight: 0.75 },
      { type: 'keyword', value: '关闭', weight: 0.8 },
      { type: 'keyword', value: '开始', weight: 0.7 },
      { type: 'keyword', value: '修改', weight: 0.6 },
      { type: 'keyword', value: '调整', weight: 0.5 },
      { type: 'negation', value: '删除', weight: 0 },
      { type: 'negation', value: '取消', weight: 0 },
    ],
    confidence: 0.89,
    minConfidence: 0.65,
    rationale: 'Task status modification detected',
  },

  {
    id: 'modify-description',
    category: 'modify_task',
    subCategory: 'description',
    priority: 78,
    conditions: [
      { type: 'keyword', value: '补充', weight: 0.7 },
      { type: 'keyword', value: '描述', weight: 0.85 },
      { type: 'keyword', value: '更新', weight: 0.6 },
      { type: 'phrase', value: '需求描述', weight: 0.9 },
    ],
    confidence: 0.83,
    minConfidence: 0.6,
    rationale: 'Task description modification detected',
  },

  // ═══════════════════════════════════════════════════════════════════
  // 4. delete_task (3 rules, 7 triggers, priority range: 78-82)
  // ═══════════════════════════════════════════════════════════════════

  {
    id: 'delete-explicit',
    category: 'delete_task',
    subCategory: 'single',
    priority: 90,
    conditions: [
      { type: 'keyword', value: '删除', weight: 1.0 },
      { type: 'keyword', value: '删掉', weight: 0.9 },
      { type: 'keyword', value: '移除', weight: 0.85 },
      { type: 'keyword', value: '清掉', weight: 0.75 },
      { type: 'keyword', value: '废弃', weight: 0.8 },
      { type: 'negation', value: '删除功能', weight: 0 },
      { type: 'negation', value: '删除文件', weight: 0 },
    ],
    confidence: 0.90,
    minConfidence: 0.7,
    rationale: 'Explicit task deletion detected',
  },

  {
    id: 'delete-cancel',
    category: 'delete_task',
    subCategory: 'cancel',
    priority: 90,
    conditions: [
      { type: 'keyword', value: '取消', weight: 1.0 },
      { type: 'keyword', value: '不要了', weight: 0.85 },
      { type: 'keyword', value: '放弃', weight: 0.8 },
      { type: 'negation', value: '提醒', weight: 0 },
      // '取消' as a task action should take precedence over development keywords
      { type: 'negation', value: '会议', weight: 0 },
    ],
    confidence: 0.88,
    minConfidence: 0.65,
    rationale: 'Task cancellation detected',
  },

  {
    id: 'delete-archive',
    category: 'delete_task',
    subCategory: 'archive',
    priority: 86,
    conditions: [
      { type: 'keyword', value: '归档', weight: 1.0, required: true },
      { type: 'keyword', value: '已完成', weight: 0.7 },
    ],
    confidence: 0.91,
    minConfidence: 0.7,
    rationale: 'Task archival detected',
  },

  // ═══════════════════════════════════════════════════════════════════
  // 5. schedule (4 rules, 9 triggers, priority range: 72-75)
  // ═══════════════════════════════════════════════════════════════════

  {
    id: 'schedule-view',
    category: 'schedule',
    subCategory: 'view',
    priority: 72,
    conditions: [
      { type: 'keyword', value: '安排', weight: 0.85 },
      { type: 'keyword', value: '日程', weight: 0.9 },
      { type: 'keyword', value: '日历', weight: 0.85 },
      { type: 'keyword', value: '下周', weight: 0.7 },
      { type: 'keyword', value: '本周', weight: 0.7 },
      { type: 'negation', value: '安排一下', weight: 0 },
      { type: 'negation', value: '约个', weight: 0 },
    ],
    confidence: 0.85,
    minConfidence: 0.6,
    rationale: 'Schedule view query detected',
  },

  {
    id: 'schedule-create',
    category: 'schedule',
    subCategory: 'create',
    priority: 75,
    conditions: [
      { type: 'keyword', value: '安排一下', weight: 0.95 },
      { type: 'keyword', value: '约', weight: 0.8 },
      { type: 'keyword', value: '会议', weight: 0.85 },
      { type: 'keyword', value: '排期', weight: 0.8 },
      { type: 'keyword', value: '约个时间', weight: 0.9 },
      { type: 'regex', value: '(周|星期).{1,3}(上午|下午|晚上|点)', weight: 0.9 },
    ],
    confidence: 0.88,
    minConfidence: 0.65,
    rationale: 'Schedule creation detected',
  },

  {
    id: 'schedule-conflict',
    category: 'schedule',
    subCategory: 'conflict',
    priority: 73,
    conditions: [
      { type: 'phrase', value: '有空吗', weight: 1.0 },
      { type: 'phrase', value: '有没有空', weight: 0.95 },
      { type: 'keyword', value: '冲突', weight: 0.85 },
      { type: 'phrase', value: '空闲时间', weight: 0.8 },
    ],
    confidence: 0.90,
    minConfidence: 0.7,
    rationale: 'Schedule conflict check detected',
  },

  {
    id: 'schedule-modify',
    category: 'schedule',
    subCategory: 'modify',
    priority: 83,
    conditions: [
      { type: 'keyword', value: '改到', weight: 0.85 },
      { type: 'keyword', value: '改期', weight: 0.9 },
      { type: 'keyword', value: '取消', weight: 0.8 },
      { type: 'keyword', value: '会议', weight: 0.8 },
      { type: 'phrase', value: '的会', weight: 0.9 },
      { type: 'negation', value: '任务', weight: 0 },
      { type: 'negation', value: '截止', weight: 0 },
    ],
    confidence: 0.87,
    minConfidence: 0.65,
    rationale: 'Schedule modification detected',
  },

  // ═══════════════════════════════════════════════════════════════════
  // 6. debug (5 rules, priority range: 80-92)
  // ═══════════════════════════════════════════════════════════════════

  {
    id: 'debug-crash',
    category: 'debug',
    subCategory: 'crash',
    priority: 92,
    conditions: [
      { type: 'keyword', value: '崩溃', weight: 1.0 },
      { type: 'keyword', value: 'crash', weight: 1.0 },
      { type: 'keyword', value: '闪退', weight: 0.9 },
      { type: 'keyword', value: '白屏', weight: 0.9 },
      { type: 'keyword', value: '死机', weight: 0.85 },
      { type: 'keyword', value: '挂了', weight: 0.8 },
      { type: 'keyword', value: '宕机', weight: 0.85 },
      // When '修复' + 'bug' both appear, it's a task creation, not pure debugging
      { type: 'negation', value: '修复', weight: 0 },
      { type: 'negation', value: 'bug', weight: 0 },
    ],
    confidence: 0.93,
    minConfidence: 0.7,
    rationale: 'Crash debugging detected',
  },

  {
    id: 'debug-error-log',
    category: 'debug',
    subCategory: 'error_log',
    priority: 88,
    conditions: [
      { type: 'keyword', value: '报错', weight: 0.9 },
      { type: 'keyword', value: '错误', weight: 0.85 },
      { type: 'keyword', value: 'error', weight: 0.9 },
      { type: 'keyword', value: '异常', weight: 0.85 },
      { type: 'keyword', value: 'exception', weight: 0.9 },
      { type: 'keyword', value: 'stack trace', weight: 0.95 },
      { type: 'keyword', value: '日志', weight: 0.7 },
      { type: 'keyword', value: 'log', weight: 0.7 },
      { type: 'phrase', value: '看下日志', weight: 0.9 },
      { type: 'phrase', value: '排查错误', weight: 0.9 },
      { type: 'negation', value: '修复', weight: 0 },
    ],
    confidence: 0.88,
    minConfidence: 0.6,
    rationale: 'Error/log debugging detected',
  },

  {
    id: 'debug-performance',
    category: 'debug',
    subCategory: 'performance',
    priority: 86,
    conditions: [
      { type: 'keyword', value: '慢', weight: 0.8 },
      { type: 'keyword', value: '卡顿', weight: 0.9 },
      { type: 'keyword', value: '延迟', weight: 0.85 },
      { type: 'keyword', value: 'latency', weight: 0.9 },
      { type: 'keyword', value: '性能', weight: 0.85 },
      { type: 'keyword', value: 'performance', weight: 0.9 },
      { type: 'keyword', value: '内存泄漏', weight: 0.95 },
      { type: 'keyword', value: 'memory leak', weight: 0.95 },
      { type: 'keyword', value: 'CPU', weight: 0.8 },
      { type: 'phrase', value: '响应慢', weight: 0.9 },
      { type: 'phrase', value: '加载慢', weight: 0.9 },
    ],
    confidence: 0.89,
    minConfidence: 0.65,
    rationale: 'Performance debugging detected',
  },

  {
    id: 'debug-data-issue',
    category: 'debug',
    subCategory: 'data_issue',
    priority: 82,
    conditions: [
      { type: 'keyword', value: '数据不对', weight: 0.95 },
      { type: 'keyword', value: '数据丢失', weight: 0.95 },
      { type: 'keyword', value: '数据异常', weight: 0.9 },
      { type: 'keyword', value: '脏数据', weight: 0.9 },
      { type: 'keyword', value: '不一致', weight: 0.85 },
      { type: 'phrase', value: '数据有问题', weight: 0.95 },
      { type: 'phrase', value: '对不上', weight: 0.85 },
    ],
    confidence: 0.87,
    minConfidence: 0.6,
    rationale: 'Data issue debugging detected',
  },

  {
    id: 'debug-environment',
    category: 'debug',
    subCategory: 'environment',
    priority: 80,
    conditions: [
      { type: 'keyword', value: '环境', weight: 0.8 },
      { type: 'keyword', value: '配置', weight: 0.7 },
      { type: 'keyword', value: '依赖', weight: 0.75 },
      { type: 'keyword', value: '版本', weight: 0.7 },
      { type: 'phrase', value: '装不上', weight: 0.85 },
      { type: 'phrase', value: '跑不起来', weight: 0.9 },
      { type: 'phrase', value: '启动失败', weight: 0.85 },
      { type: 'phrase', value: '环境问题', weight: 0.9 },
      { type: 'negation', value: '创建', weight: 0 },
    ],
    confidence: 0.84,
    minConfidence: 0.6,
    rationale: 'Environment/config debugging detected',
  },

  // ═══════════════════════════════════════════════════════════════════
  // 7. development (5 rules, priority range: 78-88)
  // ═══════════════════════════════════════════════════════════════════

  {
    id: 'dev-feature-impl',
    category: 'development',
    subCategory: 'feature_impl',
    priority: 86,
    conditions: [
      { type: 'keyword', value: '实现', weight: 0.85 },
      { type: 'keyword', value: '开发', weight: 0.8 },
      { type: 'keyword', value: '写一个', weight: 0.8 },
      { type: 'keyword', value: '做一个', weight: 0.8 },
      { type: 'keyword', value: '编码', weight: 0.75 },
      { type: 'keyword', value: 'implement', weight: 0.9 },
      { type: 'keyword', value: '功能', weight: 0.3 },
      { type: 'phrase', value: '写代码', weight: 0.9 },
      { type: 'phrase', value: '改代码', weight: 0.85 },
      { type: 'negation', value: '创建任务', weight: 0 },
    ],
    confidence: 0.86,
    minConfidence: 0.6,
    rationale: 'Feature implementation detected',
  },

  {
    id: 'dev-bugfix',
    category: 'development',
    subCategory: 'bugfix',
    priority: 88,
    conditions: [
      { type: 'keyword', value: '修复', weight: 0.9 },
      { type: 'keyword', value: 'fix', weight: 0.9 },
      { type: 'keyword', value: '解决', weight: 0.75 },
      { type: 'keyword', value: 'patch', weight: 0.85 },
      { type: 'phrase', value: '修bug', weight: 0.95 },
      { type: 'phrase', value: 'hotfix', weight: 0.9 },
      { type: 'negation', value: '查询', weight: 0 },
      // When 'bug' appears alongside '修复', it could be create_task — let disambiguator handle
      // but boost dev-bugfix since '修复bug' as standalone is development action
      { type: 'keyword', value: 'bug', weight: 0.3 },
    ],
    confidence: 0.89,
    minConfidence: 0.65,
    rationale: 'Bugfix development detected',
  },

  {
    id: 'dev-refactor',
    category: 'development',
    subCategory: 'refactor',
    priority: 82,
    conditions: [
      { type: 'keyword', value: '重构', weight: 1.0 },
      { type: 'keyword', value: 'refactor', weight: 1.0 },
      { type: 'keyword', value: '优化', weight: 0.8 },
      { type: 'keyword', value: '清理', weight: 0.7 },
      { type: 'keyword', value: '整理代码', weight: 0.85 },
      { type: 'phrase', value: '代码优化', weight: 0.85 },
      // Suppress when task management keywords are present
      { type: 'negation', value: '任务', weight: 0 },
      { type: 'negation', value: '取消', weight: 0 },
    ],
    confidence: 0.88,
    minConfidence: 0.65,
    rationale: 'Code refactoring detected',
  },

  {
    id: 'dev-api-design',
    category: 'development',
    subCategory: 'api_design',
    priority: 84,
    conditions: [
      { type: 'keyword', value: '接口', weight: 0.8 },
      { type: 'keyword', value: 'API', weight: 0.85 },
      { type: 'keyword', value: '路由', weight: 0.75 },
      { type: 'keyword', value: 'endpoint', weight: 0.85 },
      { type: 'phrase', value: '设计接口', weight: 0.9 },
      { type: 'phrase', value: 'API设计', weight: 0.9 },
      { type: 'phrase', value: '接口定义', weight: 0.85 },
    ],
    confidence: 0.87,
    minConfidence: 0.6,
    rationale: 'API design detected',
  },

  {
    id: 'dev-architecture',
    category: 'development',
    subCategory: 'architecture',
    priority: 86,
    conditions: [
      { type: 'keyword', value: '架构', weight: 0.95 },
      { type: 'keyword', value: 'architecture', weight: 0.9 },
      { type: 'keyword', value: '微服务', weight: 0.85 },
      { type: 'keyword', value: '分层', weight: 0.8 },
      { type: 'keyword', value: '设计模式', weight: 0.85 },
      { type: 'phrase', value: '系统设计', weight: 0.9 },
      { type: 'phrase', value: '架构方案', weight: 0.9 },
    ],
    confidence: 0.88,
    minConfidence: 0.65,
    rationale: 'Architecture design detected',
  },

  // ═══════════════════════════════════════════════════════════════════
  // 8. research (4 rules, priority range: 76-84)
  // ═══════════════════════════════════════════════════════════════════

  {
    id: 'research-investigation',
    category: 'research',
    subCategory: 'investigation',
    priority: 82,
    conditions: [
      { type: 'keyword', value: '调查', weight: 0.9 },
      { type: 'keyword', value: '排查', weight: 0.85 },
      { type: 'keyword', value: '分析', weight: 0.8 },
      { type: 'keyword', value: 'investigate', weight: 0.9 },
      { type: 'keyword', value: '排查原因', weight: 0.95 },
      { type: 'phrase', value: '查一下', weight: 0.8 },
      { type: 'phrase', value: '了解一下', weight: 0.75 },
      { type: 'phrase', value: '研究一下', weight: 0.85 },
      { type: 'negation', value: '查询状态', weight: 0 },
    ],
    confidence: 0.85,
    minConfidence: 0.6,
    rationale: 'Investigation/research detected',
  },

  {
    id: 'research-spike',
    category: 'research',
    subCategory: 'spike',
    priority: 80,
    conditions: [
      { type: 'keyword', value: 'spike', weight: 0.95 },
      { type: 'keyword', value: '原型', weight: 0.85 },
      { type: 'keyword', value: 'POC', weight: 0.9 },
      { type: 'keyword', value: '可行性', weight: 0.85 },
      { type: 'keyword', value: '验证', weight: 0.75 },
      { type: 'phrase', value: '技术验证', weight: 0.9 },
      { type: 'phrase', value: '概念验证', weight: 0.9 },
    ],
    confidence: 0.86,
    minConfidence: 0.6,
    rationale: 'Spike/POC research detected',
  },

  {
    id: 'research-comparison',
    category: 'research',
    subCategory: 'comparison',
    priority: 78,
    conditions: [
      { type: 'keyword', value: '对比', weight: 0.9 },
      { type: 'keyword', value: '比较', weight: 0.85 },
      { type: 'keyword', value: 'compare', weight: 0.9 },
      { type: 'keyword', value: '选型', weight: 0.9 },
      { type: 'phrase', value: '哪个好', weight: 0.85 },
      { type: 'phrase', value: '区别', weight: 0.75 },
      { type: 'phrase', value: '差异', weight: 0.75 },
    ],
    confidence: 0.84,
    minConfidence: 0.6,
    rationale: 'Comparison research detected',
  },

  {
    id: 'research-docs-lookup',
    category: 'research',
    subCategory: 'documentation_lookup',
    priority: 76,
    conditions: [
      { type: 'keyword', value: '文档', weight: 0.7 },
      { type: 'keyword', value: '文档', weight: 0.7 },
      { type: 'keyword', value: '手册', weight: 0.8 },
      { type: 'keyword', value: '用法', weight: 0.75 },
      { type: 'phrase', value: '怎么用', weight: 0.8 },
      { type: 'phrase', value: '查阅', weight: 0.85 },
      { type: 'phrase', value: '参考文档', weight: 0.85 },
      { type: 'negation', value: '写文档', weight: 0 },
    ],
    confidence: 0.82,
    minConfidence: 0.55,
    rationale: 'Documentation lookup research detected',
  },

  // ═══════════════════════════════════════════════════════════════════
  // 9. review (4 rules, priority range: 78-87)
  // ═══════════════════════════════════════════════════════════════════

  {
    id: 'review-code',
    category: 'review',
    subCategory: 'code_review',
    priority: 87,
    conditions: [
      { type: 'keyword', value: 'code review', weight: 0.95 },
      { type: 'keyword', value: '代码审查', weight: 0.95 },
      { type: 'keyword', value: 'review', weight: 0.85 },
      { type: 'keyword', value: '审查', weight: 0.85 },
      { type: 'phrase', value: '看一下代码', weight: 0.85 },
      { type: 'phrase', value: '代码走查', weight: 0.9 },
    ],
    confidence: 0.89,
    minConfidence: 0.65,
    rationale: 'Code review detected',
  },

  {
    id: 'review-pr',
    category: 'review',
    subCategory: 'pr_review',
    priority: 85,
    conditions: [
      { type: 'keyword', value: 'PR', weight: 0.85 },
      { type: 'keyword', value: 'pull request', weight: 0.95 },
      { type: 'keyword', value: '合并请求', weight: 0.9 },
      { type: 'phrase', value: 'review PR', weight: 0.95 },
      { type: 'phrase', value: '看PR', weight: 0.9 },
      { type: 'phrase', value: '合PR', weight: 0.85 },
    ],
    confidence: 0.90,
    minConfidence: 0.65,
    rationale: 'PR review detected',
  },

  {
    id: 'review-design',
    category: 'review',
    subCategory: 'design_review',
    priority: 82,
    conditions: [
      { type: 'keyword', value: '设计评审', weight: 0.95 },
      { type: 'keyword', value: '方案评审', weight: 0.9 },
      { type: 'phrase', value: 'review设计', weight: 0.9 },
      { type: 'phrase', value: '看下方案', weight: 0.8 },
      { type: 'phrase', value: '方案看看', weight: 0.75 },
    ],
    confidence: 0.87,
    minConfidence: 0.6,
    rationale: 'Design review detected',
  },

  {
    id: 'review-test',
    category: 'review',
    subCategory: 'test_review',
    priority: 78,
    conditions: [
      { type: 'keyword', value: '测试用例', weight: 0.8 },
      { type: 'keyword', value: 'test case', weight: 0.85 },
      { type: 'phrase', value: 'review测试', weight: 0.9 },
      { type: 'phrase', value: '看测试', weight: 0.8 },
      { type: 'phrase', value: '测试评审', weight: 0.9 },
    ],
    confidence: 0.84,
    minConfidence: 0.6,
    rationale: 'Test review detected',
  },

  // ═══════════════════════════════════════════════════════════════════
  // 10. planning (4 rules, priority range: 77-85)
  // ═══════════════════════════════════════════════════════════════════

  {
    id: 'planning-sprint',
    category: 'planning',
    subCategory: 'sprint_planning',
    priority: 85,
    conditions: [
      { type: 'keyword', value: 'sprint', weight: 0.9 },
      { type: 'keyword', value: '迭代', weight: 0.85 },
      { type: 'keyword', value: '排期', weight: 0.85 },
      { type: 'phrase', value: '迭代规划', weight: 0.95 },
      { type: 'phrase', value: 'sprint planning', weight: 0.95 },
      { type: 'phrase', value: '下个迭代', weight: 0.85 },
      { type: 'phrase', value: '本迭代', weight: 0.8 },
    ],
    confidence: 0.88,
    minConfidence: 0.65,
    rationale: 'Sprint planning detected',
  },

  {
    id: 'planning-estimation',
    category: 'planning',
    subCategory: 'estimation',
    priority: 82,
    conditions: [
      { type: 'keyword', value: '估时', weight: 0.95 },
      { type: 'keyword', value: '估算', weight: 0.9 },
      { type: 'keyword', value: 'estimate', weight: 0.9 },
      { type: 'keyword', value: '工时', weight: 0.85 },
      { type: 'keyword', value: '人天', weight: 0.85 },
      { type: 'phrase', value: '多少时间', weight: 0.8 },
      { type: 'phrase', value: '工作量', weight: 0.85 },
    ],
    confidence: 0.87,
    minConfidence: 0.6,
    rationale: 'Estimation/planning detected',
  },

  {
    id: 'planning-roadmap',
    category: 'planning',
    subCategory: 'roadmap',
    priority: 80,
    conditions: [
      { type: 'keyword', value: 'roadmap', weight: 0.95 },
      { type: 'keyword', value: '路线图', weight: 0.9 },
      { type: 'keyword', value: '里程碑', weight: 0.85 },
      { type: 'keyword', value: 'milestone', weight: 0.85 },
      { type: 'phrase', value: '长期规划', weight: 0.9 },
      { type: 'phrase', value: '版本规划', weight: 0.85 },
    ],
    confidence: 0.86,
    minConfidence: 0.6,
    rationale: 'Roadmap planning detected',
  },

  {
    id: 'planning-task-breakdown',
    category: 'planning',
    subCategory: 'task_breakdown',
    priority: 77,
    conditions: [
      { type: 'keyword', value: '拆解', weight: 0.9 },
      { type: 'keyword', value: '拆分', weight: 0.85 },
      { type: 'keyword', value: 'breakdown', weight: 0.9 },
      { type: 'keyword', value: 'WBS', weight: 0.95 },
      { type: 'phrase', value: '任务拆分', weight: 0.9 },
      { type: 'phrase', value: '拆任务', weight: 0.9 },
      { type: 'phrase', value: '分解', weight: 0.75 },
    ],
    confidence: 0.85,
    minConfidence: 0.6,
    rationale: 'Task breakdown planning detected',
  },
];

/**
 * Get all rules sorted by priority descending (standard evaluation order).
 */
export function getRulesByPriority(): ClassificationRule[] {
  return [...RULES].sort((a, b) => b.priority - a.priority);
}

/**
 * Get rules filtered by category.
 */
export function getRulesByCategory(category: string): ClassificationRule[] {
  return RULES.filter(r => r.category === category);
}

/**
 * Summary statistics for the rule library.
 */
export function getRuleStats() {
  const byCategory: Record<string, number> = {};
  const triggerWords = new Set<string>();

  for (const rule of RULES) {
    byCategory[rule.category] = (byCategory[rule.category] || 0) + 1;
    for (const cond of rule.conditions) {
      if (cond.type !== 'negation') {
        triggerWords.add(cond.value);
      }
    }
  }

  return {
    totalRules: RULES.length,
    totalTriggerWords: triggerWords.size,
    byCategory,
    categories: Object.keys(byCategory),
  };
}
