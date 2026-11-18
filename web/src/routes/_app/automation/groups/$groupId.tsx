import { createFileRoute } from '@tanstack/react-router'
import { GroupPage } from '@/features/automation/group-page'

export const Route = createFileRoute('/_app/automation/groups/$groupId')({
  staticData: { title: 'Group', dynamicTitle: 'group' },
  component: GroupRoute,
})

function GroupRoute() {
  const { groupId } = Route.useParams()
  return <GroupPage groupId={groupId} />
}
