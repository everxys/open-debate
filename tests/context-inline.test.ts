import test from "node:test";
import assert from "node:assert/strict";

import { resolveContextAccessRules } from "@/lib/runtime/context-inline";

test("unlockAfterPhase becomes readable without becoming auto-read", () => {
  const resolved = resolveContextAccessRules(
    {
      workflowVersion: 1,
      enabled: true,
      phaseMachine: {
        phases: [],
        transitionRules: {
          finalization: {
            autoOpenVote: false,
            requireUnanimousVote: false,
            reopenUntilPassed: false,
            discussionRoundsBetweenVotes: 0,
            requirePhaseForCompletion: false
          }
        }
      },
      contextAccess: {
        alwaysRead: [],
        readWhenNeeded: [],
        unlockAfterPhase: [
          {
            phaseKind: "analysis",
            scope: "shared",
            targetType: "dir",
            pathPrefix: "debate/ideas/",
            maxFiles: 6,
            maxCharsPerFile: 4_000,
            recursive: true
          }
        ]
      },
      promptPolicies: {
        outputBudget: {
          discussionMaxTokens: null,
          writingMaxTokens: null
        }
      },
      consensus: {
        enabled: false,
        minAvgScore: 0,
        requireAllSeats: false
      },
      voting: {
        governance: {
          tieBreaker: "revote",
          maxTieRounds: 2
        }
      },
      summarizer: {
        enabled: false,
        aiAgentId: null,
        perTurn: false,
        perRound: false,
        factsBoard: false,
        prompts: {
          turnSummary: null,
          roundSummary: null,
          factsBoard: null
        },
        outputPaths: {
          turnSummaryDir: "debate/turn_summaries/",
          roundSummaryDir: "debate/round_summaries/",
          factsBoardPath: "facts/board.md"
        }
      },
      deliverables: {
        allowedPaths: ["final/", "outputs/"],
        requiredFiles: []
      },
      completion: {
        mode: "workflow_gate"
      },
      ideaBank: {
        rawIdeaBankPath: null,
        derivedFiles: {
          currentBattlefieldPath: null,
          selectedSTierPath: null,
          selectedATierPath: null,
          rejectedOrMergedPath: null,
          eventMappingsPath: null,
          newlyInventedIdeasPath: null
        }
      }
    } as any,
    "deliberation"
  );

  assert.equal(resolved.autoRead.length, 0);
  assert.equal(resolved.readable.length, 1);
  assert.equal(resolved.readable[0]?.pathPrefix, "debate/ideas/");
  assert.equal(resolved.locked.length, 0);
});
