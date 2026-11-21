                                     
const entryFailures=new Set(['profile_version_unsupported','launch_image_ambiguous','launch_profile_missing','launch_command_missing','launch_command_invalid','invalid_config']);
const otherDeterministicFailures=new Set(['launch_provenance_missing','original_home_changed','cwd_mismatch','session_not_found','session_ambiguous','session_invalid','resume_not_found','rollout_not_found','bootstrap_policy_unsupported','dedicated_mode_unsupported','workspace_untrusted','trust_required']);
export const deterministicEntryFailure=(code:string|undefined)=>entryFailures.has(code??'');
export function deterministicLaunchFailure(error:unknown):boolean{
  const code=(error as {code?:string})?.code;
  return deterministicEntryFailure(code)||otherDeterministicFailures.has(code??'');
}
