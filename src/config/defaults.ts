import type {BridgeConfig,RetentionConfig} from '../types.js';
const week=7*24*60*60*1000;
export const DEFAULT_RETENTION:RetentionConfig={
  maintenanceIntervalMs:300000,eventMaxAgeMs:week,maxEvents:10000,
  historyMaxAgeMs:week,maxMessages:2000,maxQuestions:1000,maxArchivedPairs:100,
                                                  
  referenceMaxAgeMs:week,maxReferences:1024,maxReferenceBytes:128*1024*1024,
  peerMaxIdleMs:week,logMaxBytes:8*1024*1024,logBackups:2,
};

export const DEFAULT_CONFIG: BridgeConfig = {
  version: 1,
  implicit: 'on-demand',
  compatibilityWake: 'notify',
  subagentSend: 'allow-verified',
  questionTimeoutMs: 600000,
  claudeSdkUserPrompt: false,
  syncTipMinutes: 30,
  contextTipTokens: [400000,600000,850000],
  idleNoticeMinutes: 5,
  partnerProfiles: {claude:{source:'host'},codex:{source:'host'}},
  retention: DEFAULT_RETENTION,
};
