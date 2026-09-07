import {
  PlayIcon,
  FlagIcon,
  SparklesIcon,
  WrenchScrewdriverIcon,
  ArrowsRightLeftIcon,
  ArrowPathRoundedSquareIcon,
  Square2StackIcon,
  ArrowsPointingInIcon,
  UserIcon,
  AdjustmentsHorizontalIcon,
  CircleStackIcon,
  MapIcon,
  ShieldCheckIcon,
  GlobeAltIcon,
  CodeBracketIcon,
  MagnifyingGlassIcon,
  QueueListIcon,
  TableCellsIcon,
  CheckBadgeIcon,
  DocumentTextIcon,
  MegaphoneIcon,
  InboxArrowDownIcon,
  InboxIcon,
  ArchiveBoxIcon
} from '@heroicons/react/24/outline';

/** Icon component per workflow node type. */
const NODE_TYPE_ICONS = {
  start: PlayIcon,
  end: FlagIcon,
  prompt: SparklesIcon,
  planner: MapIcon,
  verifier: ShieldCheckIcon,
  decision: ArrowsRightLeftIcon,
  loop: ArrowPathRoundedSquareIcon,
  parallel: Square2StackIcon,
  join: ArrowsPointingInIcon,
  transform: AdjustmentsHorizontalIcon,
  code: CodeBracketIcon,
  tool: WrenchScrewdriverIcon,
  http: GlobeAltIcon,
  human: UserIcon,
  memory: CircleStackIcon,
  'query-plan': QueueListIcon,
  'corpus-search': MagnifyingGlassIcon,
  'structured-record': TableCellsIcon,
  'quote-validator': CheckBadgeIcon,
  'template-render': DocumentTextIcon,
  progress: MegaphoneIcon,
  'inbox-load': InboxArrowDownIcon,
  'inbox-finalize': InboxIcon,
  'memory-finalize': ArchiveBoxIcon
};

/**
 * Renders the icon for a workflow node type.
 *
 * @param {object} props
 * @param {string} props.type - Workflow node type identifier
 * @param {string} [props.className] - Icon size/style classes
 */
export function NodeTypeIcon({ type, className = 'w-4 h-4' }) {
  const IconComponent = NODE_TYPE_ICONS[type] || SparklesIcon;
  return <IconComponent className={className} aria-hidden="true" />;
}

export default NodeTypeIcon;
