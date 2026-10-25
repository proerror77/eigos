import type { Job } from '../../packages/core/domain.js';
import { taskSummary } from '../../packages/core/task-summary.js';
import type { TaskView } from '../../packages/security/task-service.js';

/** Foundation already returned a sealed view; never reinterpret it as a raw Job. */
export function publicTask(job: Job) {
  return 'view' in job && job.view === 'eigos.task.v2' ? job as TaskView : taskSummary(job);
}
