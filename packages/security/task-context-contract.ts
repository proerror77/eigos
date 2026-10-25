export const TASK_CONTEXT_BINDING_VERSION = 'eigos.task-context-bindings.v1';

// Exact task-control fields only. These bindings do not expose raw jobs,
// private invocation arguments, credentials, model outputs, or arbitrary ledger rows.
export const taskContextFields:Record<string,readonly string[]>={
 RequestSpecification:['id','displayTitle','requestRevision','requestDigest','instructionCount','constraintCount','requestedDeliverable','executionEnvironment','outcome','businessScopeId','confirmedInputDigests','capabilityRef','assertionSnapshotVersion','factCount','conditionCount','factFamilies'],
 RequestInstruction:['id','displayTitle','introducedRevision','messageId','sequence','text','receivedAt'],
 RequestConstraint:['id','displayTitle','introducedRevision','requirementId','sequence','group','kind','role','strength','expected','provenance'],
 RequestFact:['factId','displayTitle','namespace','field','status','value','quote','source','factRevision'],
 RequestCondition:['conditionId','displayTitle','sequence','condition'],
 ExecutionContext:['id','displayTitle','requestRevision','phase','state','programRef','programDigest','scope','activeBinding','pendingPlanId','observationOrder','feedback','goal','components','goalAssessment'],
 ExecutionPlan:['id','displayTitle','planId','planDigest','requestRevision','kind','sequence','state','structureDigest','createdAt','modelRunId'],
 ExecutionStep:['id','displayTitle','stepId','sequence','actionId','definitionDigest','inputDigest','intentId','planDigest','effect','state','structureDigest','acceptedOutput'],
 ExecutionInput:['id','displayTitle','parameter','sourceKind','valueDigest','valueType','sourceStepId','sourcePath','sourcePort','sourceIntentId','object','candidateId','requestRevision','objectRevision','objectPropertiesDigest','objectLinksDigest'],
 ExecutionAttempt:['id','displayTitle','attemptId','intentId','planDigest','ordinal','requestRevision','taskRevision','kind','inputDigest','startedAt','state'],
 ExecutionResult:['id','displayTitle','resultId','resultDigest','receivedAt','kind','sourceVersion','applied','verification','output'],
 ActionBinding:['id','displayTitle','requestRevision','bindingRef','configurationDigest','bindingDigest','providerContract','kind','actionIds','active','authorization','programRef','contextId','contextDigest','scope','definitionDigest'],
 RegisteredActionType:['id','displayTitle','contractKind','actionId','actionVersion','capabilityRef','definitionDigest','description','inputs','inputSchema','resultType','effect','kind','effects','resultTypes','changes','submissionCriteria','execution','composition'],
 RegisteredCapability:['id','name','capabilityRef','description','tags','inputSchema','predicates','outcomePredicates','goalOutcomes','requirementRoles','constraintEvaluation','scopeReviewMode','locationSemantics','definitionDigest'],
};
