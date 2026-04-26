import { formatRequiredDeliverableSummary, type NormalizedDebateWorkflow } from "@/lib/workflow";
import {
  getWorkflowEarliestCompletionRound,
  getWorkflowEarliestDeliberationRound,
  getWorkflowEarliestFinalizationRound,
  getWorkflowEarliestFinalizationVoteRound,
  getWorkflowMinimumAnalysisRounds,
  getWorkflowPhaseMinRounds,
  hasWorkflowPhase
} from "@/lib/runtime/workflow-phase";

export function appendWorkflowSummaryLines(lines: string[], workflow: NormalizedDebateWorkflow | null) {
  lines.push("## Rules (summary)");
  if (!workflow?.enabled) {
    lines.push("- disabled (no workflow.json or enabled=false)");
    return;
  }

  const hasFinalizationVotePhase = hasWorkflowPhase(workflow, "finalization_vote");
  const hasFinalizationPhase = hasWorkflowPhase(workflow, "finalization");
  lines.push(`- version: v${workflow.workflowVersion}`);
  lines.push(
    `- phase minRounds: analysis=${getWorkflowMinimumAnalysisRounds(workflow)}; deliberation=${getWorkflowPhaseMinRounds(workflow, "deliberation", 0)}; finalization_vote=${hasFinalizationVotePhase ? getWorkflowPhaseMinRounds(workflow, "finalization_vote", 0) : "n/a"}; finalization=${hasFinalizationPhase ? getWorkflowPhaseMinRounds(workflow, "finalization", 0) : "n/a"}`
  );
  lines.push(
    `- phase earliest rounds: deliberation@${getWorkflowEarliestDeliberationRound(workflow)}; finalization_vote@${hasFinalizationVotePhase ? getWorkflowEarliestFinalizationVoteRound(workflow) : "n/a"}; finalization@${hasFinalizationPhase ? getWorkflowEarliestFinalizationRound(workflow) : "n/a"}; completion@${getWorkflowEarliestCompletionRound(workflow)}`
  );
  lines.push(
    `- consolidation controls: votePhase=${hasFinalizationVotePhase ? "yes" : "no"}; consolidationPhase=${hasFinalizationPhase ? "yes" : "no"}; autoOpenVote=${workflow.phaseMachine.transitionRules.finalization.autoOpenVote ? "yes" : "no"}; requireUnanimousVote=${workflow.phaseMachine.transitionRules.finalization.requireUnanimousVote ? "yes" : "no"}; reopenUntilPassed=${workflow.phaseMachine.transitionRules.finalization.reopenUntilPassed ? "yes" : "no"}; discussionRoundsBetweenVotes=${workflow.phaseMachine.transitionRules.finalization.discussionRoundsBetweenVotes}; requirePhaseForCompletion=${workflow.phaseMachine.transitionRules.finalization.requirePhaseForCompletion ? "yes" : "no"}`
  );
  lines.push(
    `- output budget: discussion=${workflow.promptPolicies.outputBudget.discussionMaxTokens ?? "unlimited"}; writing=${workflow.promptPolicies.outputBudget.writingMaxTokens ?? "unlimited"}`
  );
  if (workflow.deliverables.requiredFiles.length > 0) {
    lines.push("- required deliverables:");
    for (const file of workflow.deliverables.requiredFiles) {
      lines.push(`  - ${formatRequiredDeliverableSummary(file, "plain")}`);
    }
  }
  if (workflow.summarizer.enabled) {
    lines.push(
      `- summarizer: enabled; perTurn=${workflow.summarizer.perTurn ? "yes" : "no"}; perRound=${workflow.summarizer.perRound ? "yes" : "no"}; factsBoard=${workflow.summarizer.factsBoard ? "yes" : "no"}`
    );
    lines.push(
      `- summarizer outputs: turn=${workflow.summarizer.outputPaths.turnSummaryDir}; round=${workflow.summarizer.outputPaths.roundSummaryDir}; facts=${workflow.summarizer.outputPaths.factsBoardPath}`
    );
  }
  if (
    workflow.contextAccess.alwaysRead.length > 0 ||
    workflow.contextAccess.readWhenNeeded.length > 0 ||
    workflow.contextAccess.unlockAfterPhase.length > 0
  ) {
    lines.push(
      `- contextAccess alwaysRead: ${workflow.contextAccess.alwaysRead.length ? workflow.contextAccess.alwaysRead.map((rule) => `[${rule.scope}] ${rule.targetType} ${rule.pathPrefix}`).join(" / ") : "(none)"}`
    );
    lines.push(
      `- contextAccess readWhenNeeded: ${workflow.contextAccess.readWhenNeeded.length ? workflow.contextAccess.readWhenNeeded.map((rule) => `[${rule.scope}] ${rule.targetType} ${rule.pathPrefix}`).join(" / ") : "(none)"}`
    );
    lines.push(
      `- contextAccess unlockAfterPhase: ${workflow.contextAccess.unlockAfterPhase.length ? workflow.contextAccess.unlockAfterPhase.map((rule) => `[${rule.scope}] ${rule.targetType} ${rule.pathPrefix} @ ${rule.phaseKind}`).join(" / ") : "(none)"}`
    );
  }
}
