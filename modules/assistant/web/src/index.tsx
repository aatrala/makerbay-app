import { Route } from 'react-router-dom'
import type { DashboardModule } from '@makerbay/web-kit'
import Behavior from './Behavior'
import Conversations from './Conversations'
import DeployPage from './DeployPage'
import Insights from './Insights'
import Knowledge from './Knowledge'
import Playground from './Playground'

/**
 * The assistant's dashboard, as one object the shell can mount. The shell
 * knows nothing about what these screens do, and nothing here knows the
 * shell exists - which is what makes the next module cheap to add.
 */
export const assistantDashboard: DashboardModule = {
  id: 'assistant',
  label: 'Assistant',
  nav: [
    { to: '/assistant/playground', label: 'Playground' },
    { to: '/assistant/knowledge', label: 'Knowledge' },
    { to: '/assistant/behavior', label: 'Behavior' },
    { to: '/assistant/deploy', label: 'Deploy' },
    { to: '/assistant/conversations', label: 'Conversations' },
    { to: '/assistant/insights', label: 'Insights' },
  ],
  routes: ({ me }) => (
    <>
      <Route path="/assistant/playground" element={<Playground />} />
      <Route path="/assistant/knowledge" element={<Knowledge />} />
      <Route path="/assistant/behavior" element={<Behavior />} />
      <Route path="/assistant/deploy" element={<DeployPage me={me} />} />
      <Route path="/assistant/conversations" element={<Conversations />} />
      <Route path="/assistant/insights" element={<Insights />} />
    </>
  ),
}

/** The screen a brand-new workspace should land on: an assistant with no
 *  knowledge cannot answer anything, so send them to Knowledge first. */
export const assistantFirstRun = '/assistant/knowledge'

export default assistantDashboard
