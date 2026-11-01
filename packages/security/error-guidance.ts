import type { SecurityError } from './store.js';

/** Public advice is selected from the actual denial boundary, never raw policy
 * diagnostics, private object existence, submitted text or hidden field names. */
export function securityErrorResponse(error: SecurityError, instance?: string) {
  const advice = error.context === 'personal_context'
    ? { stage: 'personal_context', nextAction: 'review_request_context', reviewPath: '/members/permissions',
        message: '请求中的个人资料不可用或超出当前授权范围。仅在任务确实需要时提交 personalContext；公共地点查询可省略无关个人上下文。需要这些资料时，由本人检查授权与资料绑定。这不表示缺少创建任务权限。' }
    : error.reason === 'SOURCE_NOT_AUTHORIZED'
      ? { stage: 'source', nextAction: 'review_source_authorization', reviewPath: '/members/permissions', message: '当前来源未获得本任务所需的有效授权。请本人审阅来源范围，再由原助手续接原任务；来源授权不代表查价已完成。' }
      : error.reason === 'OUTPUT_NOT_ALLOWED'
        ? { stage: 'output', nextAction: 'review_output_authorization', reviewPath: '/members/permissions', message: '当前连接不能接收所请求的结果或输出范围。请本人检查结果读取与输出通道授权；不要新建替代任务。' }
        : error.reason === 'POLICY_CHANGED'
          ? { stage: 'policy', nextAction: 'reread_current_context', reviewPath: '/members/permissions', message: '权限或任务版本已变化。重新读取当前连接及原任务版本，核对授权后继续；不要盲目重发提交。' }
          : error.reason === 'AUTHORITY_UNAVAILABLE'
            ? { stage: 'runtime', nextAction: 'wait_for_runtime', reviewPath: '/health', message: '权限运行服务暂时不可用。保留原请求和任务，等待运行恢复；无需重复补充业务信息。' }
            : error.reason === 'ACCESS_REVOKED' || error.reason === 'REVOCATION_PENDING'
              ? { stage: 'connection', nextAction: 'review_connection', reviewPath: '/members', message: '连接或授权已被收回，或正在处理撤销。请本人检查会员与助手连接状态；不能通过新身份或新任务绕过。' }
              : { stage: 'access', nextAction: 'review_permissions', reviewPath: '/members/permissions', message: '当前请求缺少有效访问范围。请本人检查安装、任务及数据授权；该错误本身不指明缺少哪一项权限，也不等同缺少创建任务权限。' };
  return { code: error.reason, message: `${error.reason}: ${advice.message}`, authorization: { ...advice,
    ...(instance ? { reviewUrl: new URL(advice.reviewPath, new URL(instance).origin).href } : {}), preserveOriginalTask: true, grantsAuthority: false } };
}
