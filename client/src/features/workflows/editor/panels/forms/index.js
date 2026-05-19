import StartForm from './StartForm';
import EndForm from './EndForm';
import PromptForm from './PromptForm';
import PlannerForm from './PlannerForm';
import VerifierForm from './VerifierForm';
import DecisionForm from './DecisionForm';
import LoopForm from './LoopForm';
import ParallelForm from './ParallelForm';
import JoinForm from './JoinForm';
import TransformForm from './TransformForm';
import HttpForm from './HttpForm';
import CodeForm from './CodeForm';
import HumanForm from './HumanForm';
import ToolForm from './ToolForm';
import MemoryForm from './MemoryForm';

export const nodeFormRegistry = {
  start: StartForm,
  end: EndForm,
  prompt: PromptForm,
  planner: PlannerForm,
  verifier: VerifierForm,
  decision: DecisionForm,
  loop: LoopForm,
  parallel: ParallelForm,
  join: JoinForm,
  transform: TransformForm,
  http: HttpForm,
  code: CodeForm,
  human: HumanForm,
  tool: ToolForm,
  memory: MemoryForm
};
